# 随码 v0.4.64

## 结论

Codex「接力」报 `already has an active writer` **不必更新 Web**；需要更新 **桌面客户端** 到 **0.4.64**。

## 原因

Agent 内的 Codex app-server 与 CLI `codex resume` 共用 `~/.codex` 会话。同一 thread 只允许一个 live writer；app-server 仍占锁时，接力会失败（JSON-RPC `-32600`）。

## 修复

接力前：

1. 若有进行中的 turn → `turn/interrupt`
2. `thread/unsubscribe` 后 **停止 app-server**，立即释放写锁
3. 再打开外部终端执行 `codex resume <threadId>`

下次 Web 发消息时会按需重新拉起 app-server。

## 同版本附带

- Cursor headless：本机代理下启用 `NODE_USE_ENV_PROXY`，并在有代理时写入 `network.useHttp1ForAgent`
- Web：Cursor 切到无 effort 模型（如 Auto）时清除残留 reasoning effort 选择

## 临时绕过（未升级前）

关闭 AnytimeVibe Agent（或先停掉该会话远程回合）后再点接力。
