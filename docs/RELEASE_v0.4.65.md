# 随码 v0.4.65

## 结论

客户端「接力」会复用网页端选择的权限模式；需更新桌面客户端到 **0.4.65**（Web 非必须）。

## 原因

接力只执行 `codex resume` / `claude --resume` 等，未带上任务的 sandbox / approval / permission-mode。任务本地也未持久化 `permissionMode`，终端回落到各引擎默认权限。

## 修复

1. 在 `StoredTask` 中持久化最近一次 `permissionMode`
2. 创建 / 续跑任务时写入该字段
3. 接力时按引擎注入对应 CLI 参数：
   - Codex：`--sandbox` + `--ask-for-approval`（与 app-server 映射一致）
   - Claude：`--permission-mode`
   - Cursor：`--force` / `--mode ask` / `--sandbox disabled` + `--trust`
   - Grok：`--always-approve` 或只读工具限制

## 说明

升级前已创建、且升级后未再发过消息的旧任务可能仍无缓存权限；对该任务在网页再发一条（或改一次权限再发）后接力即可记住。
