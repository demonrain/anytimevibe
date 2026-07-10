# AnytimeVibe

AnytimeVibe 是一个多用户远程 Codex 工作台。移动端 PWA 通过 VPS 中继连接 Windows 或 macOS 托盘代理，支持任务下发、对话同步、流式回复、Diff、停止或追加指令以及远程审批。

中继只保存和转发端到端加密信封。Codex 登录信息、项目源码和同步密钥不会作为明文上传。

## 文档

- [产品文档](docs/PRODUCT.md)
- [使用手册](docs/USER_GUIDE.md)
- [多用户容量评估](docs/CAPACITY.md)

## 当前范围

- 支持开放注册，每个用户可配对多台 Windows 或 macOS 主机。
- 支持 Codex CLI `0.144.x`。
- 只允许操作代理端明确添加的工作区。
- 主机离线时可以查看已同步历史，不会排队执行离线命令。
- 不提供任意终端、文件编辑、远程桌面或 Codex 桌面 UI 自动化。

## 快速验证

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## VPS 部署

```powershell
Copy-Item .env.example .env
docker compose up -d --build
```

部署前需要配置 `DOMAIN`、`POSTGRES_PASSWORD`、`SETUP_TOKEN`、`COOKIE_SECRET` 和 VAPID 密钥。完整步骤参见[使用手册](docs/USER_GUIDE.md)。

## 桌面客户端

```text
apps/agent/release/AnytimeVibe Agent Setup 0.1.0.exe
```

macOS 客户端需要在 macOS 或 GitHub Actions 的 `macos-latest` 环境构建：

```bash
pnpm --filter @anytimevibe/agent package:mac
```

当前安装包未签名，Windows 可能显示 SmartScreen 提示。
