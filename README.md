# 随码（AnytimeVibe）

**离开电脑，任务不用停。** · **随时续上你的代码。**

随码是一个多用户远程 Codex 工作台。移动端 PWA 通过 VPS 中继连接 Windows 或 macOS 托盘代理，支持任务下发、处理状态、完成通知、历史同步、停止或追加指令以及远程审批。

中继只保存和转发端到端加密信封。Codex 登录信息、项目源码和同步密钥不会作为明文上传。

## 文档

- [产品文档](docs/PRODUCT.md)
- [使用手册](docs/USER_GUIDE.md)
- [品牌与 Slogan](docs/BRANDING.md)
- [多用户容量评估](docs/CAPACITY.md)
- [服务端更新源配置说明](docs/UPDATE_FEED.md)

## 当前范围

- 支持开放注册，每个用户可配对多台 Windows 或 macOS 主机。
- 支持 Codex CLI `0.144.x`。
- 只允许操作代理端明确添加的工作区。
- 主机离线时可以查看已同步历史，不会排队执行离线命令。
- 客户端可自定义显示名称，便于在多台电脑间区分。
- 桌面客户端支持自动更新（由服务端 `UPDATE_FEED_URL` 配置更新源）。
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

客户端自动更新相关变量（`UPDATE_FEED_URL`、`WINDOWS_CLIENT_URL`、`MAC_CLIENT_URL`）参见[更新源配置说明](docs/UPDATE_FEED.md)。

## 桌面客户端（随码）

默认中继地址：`https://vibe.demonrain.top`（可在控制面板修改）。

```text
apps/agent/release/AnytimeVibe-Agent-Setup.exe
```

安装后程序显示为 **随码**。安装包文件名仍使用工程标识 `AnytimeVibe-Agent-Setup.exe`，便于更新源与 GitHub Release 兼容。

macOS 客户端需要在 macOS 或 GitHub Actions 的 `macos-latest` 环境构建：

```bash
pnpm --filter @anytimevibe/agent package:mac
```

当前安装包未签名，Windows 可能显示 SmartScreen 提示。

### 客户端界面要点

- 无 File / Edit / View 菜单栏，托盘常驻。
- 可设置客户端名称（配对与 Web 主机列表显示）。
- 生成配对码与保存中继地址同一行；自动更新状态与「检查更新」同一行。
- 统一产品图标用于托盘、安装包、Web 与 PWA。
