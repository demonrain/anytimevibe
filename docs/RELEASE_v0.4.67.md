# 随码 v0.4.67

## 结论

前端 Codex 报 `HTTP 499 … store.demonrain.top/responses` 多为**本机网关/上游长连接被掐断**，不是 Web 本身逻辑错误。更新客户端 **0.4.67**；并先确认本机 `localhost:3310` 网关在跑。

## 原因（本机实测）

- `~/.codex/config.toml`：`model_provider = "codex_local_access"` → `http://localhost:3310/v1`
- 网关上游为 `https://store.demonrain.top`；错误里的 URL 是上游地址
- Cockpit sidecar 曾用 `stream-idle-timeout-ms: 60000`：长推理静默超过 60s 会被掐断，表现为 499
- 排查时发现 **3310 端口当前未监听**（网关未启动时也会导致任务失败）

## 客户端修复

1. Codex 下发前预检本机 loopback 网关是否可达，不可达则立即给出明确错误
2. 完善 499 说明（空闲超时 / 代理 / app-server 重启 / 网关宕机）

## 本机已做（非 git）

将 sidecar `stream-idle-timeout-ms` / `image-stream-idle-timeout-ms` 调到 **600000**，`request-retry` 调到 **3**（已备份原配置）。**请重启 Cockpit Tools / cockpit-cliproxy** 使配置生效。

## 使用建议

1. 先确认 3310 在听（启动 Cockpit）
2. 更新 AnytimeVibe Agent 到 0.4.67
3. 仍失败时先用较低 reasoning effort 试一次
