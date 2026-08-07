# 随码 v0.4.69

## 结论

前端 Codex `HTTP 499 … store.demonrain.top/responses` 的根因是 **Cockpit local-access sidecar**，不是 Web。请更新客户端 **0.4.69**，并保持 `localhost:3310` 在跑。

## 根因链

1. `model_provider = codex_local_access` → `http://localhost:3310/v1`
2. `cockpit-cliproxy` 把请求转到 `https://store.demonrain.top`
3. Cockpit 会把 sidecar 配置重置回：
   - `stream-idle-timeout-ms: 60000`
   - `stream-open-timeout-ms: 10000` / attempts=2
   - `beta-features: responses_websockets=…`
4. 长推理静默或 WS 握手失败时，网关/客户端先断开 → 上游 nginx 记 **499**
5. 有时 3310 进程本身也没起来

## 本版修复

任务前自动：

1. 加固 `~/.antigravity_cockpit/codex_local_access_sidecar/config.json`（空闲/打开超时、清 WS beta）
2. 若配置变更或端口不通，尝试重启 `cockpit-cliproxy.exe`
3. 仍不通则立即报「网关不可达」，避免再冒成含糊 499

## 本机已处理

- 已加固 sidecar，并重启 cliproxy；当前 **3310 已监听**
- 若再开 Cockpit Tools，它可能再次改写配置；新客户端会在每次任务前重新加固
