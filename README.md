# 随码（AnytimeVibe）

[English](README.en.md) · [产品文档](docs/PRODUCT.md) · [使用手册](docs/USER_GUIDE.md)

![GitHub stars](https://img.shields.io/github/stars/demonrain/anytimevibe?style=flat-square)
![License](https://img.shields.io/github/license/demonrain/anytimevibe?style=flat-square)
![Latest tag](https://img.shields.io/github/v/tag/demonrain/anytimevibe?sort=semver&style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-3c873a?style=flat-square)

**离开电脑，任务不用停。随时续上你的代码。**

随码是一个面向个人开发者和小团队的远程 Codex 工作台：通过手机或浏览器连接自己的 Windows / macOS 电脑，在远程主机上执行本机 Codex CLI 任务，并同步任务状态、会话记录、审批和完成通知。

它不是远程桌面，也不会把项目源码或 Codex 凭据上传到中继服务。桌面 Agent 在本机调用 Codex，Relay 只负责身份认证、WebSocket 路由、Web Push 和加密事件存储。

## 产品预览

[![观看 30 秒产品宣传视频](docs/media/remote-command.png)](docs/media/anytimevibe-promo.mp4)

视频文件：[anytimevibe-promo.mp4](docs/media/anytimevibe-promo.mp4)。宣传片展示了手机下发任务、电脑 CLI 接力、队列状态同步和权限控制。

| 手机下发任务 | 电脑 CLI 接力 |
| --- | --- |
| ![手机发送命令，电脑立即执行](docs/media/remote-command.png) | ![手机任务接力到电脑 CLI](docs/media/cli-handoff.png) |

| 任务队列与状态 | Codex 权限控制 |
| --- | --- |
| ![任务队列和处理状态](docs/media/task-stream.png) | ![Full Access 权限设置](docs/media/permissions.png) |

## 核心工作流

1. 在手机或桌面浏览器登录 Web PWA，选择已配对的电脑和白名单工作区。
2. 手机发送任务命令，Windows / macOS Agent 在本机启动或继续 Codex CLI 任务。
3. 需要更完整的终端开发时，点击“电脑接力”，在桌面 CLI 中 `codex resume` 同一任务上下文。
4. 任务进度、完成状态、审批请求和同步后的会话记录继续回到 Web 端，刷新或更换浏览器也能恢复任务状态。

## 能做什么

- 多用户注册、登录和用户级主机隔离。
- 配对多台 Windows / macOS 主机，并为主机设置易记名称。
- 在白名单工作区创建、继续、追加、停止 Codex 任务。
- 手机下发命令，远程电脑执行；电脑端一键接力回到同一任务。
- 任务队列、处理中、已完成、失败和离线状态同步。
- Web Push 审批与任务完成通知。
- Full Access、Workspace Write、Read Only 等 Codex 权限设置。
- 多浏览器设备授权，避免每个浏览器重复配对同一主机。
- 客户端环境检测、Codex 安装指引、自动更新和 Windows / macOS 安装包。
- 手动同步或登录后自动同步任务记录和会话历史。

当前边界：Web 端在任务执行期间优先显示处理中状态，完整流式 CLI 输出由本机 Agent 处理；不提供任意终端、远程桌面、文件浏览器或 Codex 桌面 UI 自动化。Agent 必须在电脑用户已登录且 Codex 环境可用时在线工作。

## 系统架构

```mermaid
flowchart LR
    PWA[手机 / 桌面浏览器 PWA] <-->|HTTPS / WSS<br/>加密事件信封| Relay[VPS Relay]
    Relay <-->|出站 WSS<br/>加密事件信封| Agent[Windows / macOS Agent]
    Agent <-->|JSONL stdio| Codex[Codex app-server]
    Codex --> Workspace[白名单工作区]
    Relay --> DB[(PostgreSQL)]
    Relay --> Push[Web Push]
```

## 技术栈

| 层 | 技术 | 职责 |
| --- | --- | --- |
| Web PWA | React 19、TypeScript、Vite 6、Service Worker、IndexedDB | 登录、主机、任务、会话、审批、Diff 和移动端布局 |
| Relay 服务 | Node.js、Fastify 5、WebSocket、Zod、Argon2id、Web Push | 认证、用户隔离、在线路由、加密事件存储和通知 |
| 数据库 | PostgreSQL 16 | 账号、会话、主机、配对、Push 订阅和加密事件元数据 |
| 桌面 Agent | Electron 36、WebSocket、electron-updater | 托盘常驻、配对、环境检测、自动更新和本机 Codex 进程管理 |
| Codex 适配 | Codex app-server JSONL stdio | `thread/start`、`thread/resume`、`turn/start`、审批和状态事件 |
| 部署 | Docker Compose、Caddy 2.8 | Relay、Web、PostgreSQL、HTTPS 和证书自动续期 |

## 安全模型

- Relay 不运行 Codex，不读取项目源码、命令正文、对话正文或 Diff 明文。
- Web 与 Agent 之间传输加密事件信封；主机同步密钥由浏览器和 Agent 管理。
- 浏览器密钥保存在 IndexedDB `CryptoKey` 中，新浏览器通过 Agent 授权现有主机密钥。
- Agent 使用 Electron `safeStorage` 保护本机令牌、私钥和同步密钥。
- 远程任务只能访问 Agent 明确配置的工作区，不能通过随码获得任意终端。
- 服务端使用 Argon2id 保存密码，HTTP API 和 WebSocket 都有速率限制和消息大小限制。

## 快速开始

环境要求：Node.js 22+、pnpm 10+、Git；运行服务端还需要 Docker Engine 和 Docker Compose。

```bash
git clone https://github.com/demonrain/anytimevibe.git
cd anytimevibe
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

### 本地测试环境（发版前推荐）

完整联调说明见 [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)。

```bash
pnpm install
pnpm dev:setup          # 生成 .env.local + 启动本地 Postgres + 构建 protocol
pnpm dev:stack          # Relay + Web
# 另开终端：
pnpm dev:agent:local    # Electron 连 http://127.0.0.1:8787，数据在 .local/agent-data
```

浏览器打开 http://127.0.0.1:4173 ，用 `.env.local` 中的 `SETUP_TOKEN` 初始化管理员。

分开启动：

```bash
pnpm dev:web
pnpm dev:relay
pnpm dev:agent:local
```

## Docker 部署

1. 准备一台带公网 IP 的 Linux VPS、域名，并放行 TCP 80 / 443。
2. 复制环境变量模板并填写强随机值：

```bash
cp .env.example .env
```

至少配置 `DOMAIN`、`POSTGRES_PASSWORD`、`SETUP_TOKEN`、`COOKIE_SECRET`、`PUBLIC_ORIGIN` 和 VAPID 密钥。开放注册由 `REGISTRATION_ENABLED` 控制，用户上限由 `MAX_USERS` 控制。

生成 Web Push 密钥：

```bash
pnpm --filter @anytimevibe/relay exec web-push generate-vapid-keys
```

启动生产服务：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f relay
```

Caddy 会根据 `DOMAIN` 自动申请 HTTPS 证书。首次打开 `PUBLIC_ORIGIN` 时，使用 `SETUP_TOKEN` 初始化管理员空间；启用开放注册后，其他用户可以自行注册。

## 构建桌面客户端

Windows 安装包：

```bash
pnpm --filter @anytimevibe/agent package:win
```

macOS DMG / ZIP：

```bash
pnpm --filter @anytimevibe/agent package:mac
```

macOS 包需要在 macOS 或 GitHub Actions `macos-latest` 环境构建。当前安装包默认未进行代码签名，Windows 可能显示 SmartScreen 提示，macOS 可能要求用户在“隐私与安全性”中允许打开。

客户端更新源和首页下载链接由 `WINDOWS_CLIENT_URL`、`MAC_CLIENT_URL` 和 `UPDATE_FEED_URL` 配置。更详细的更新源说明见 [docs/UPDATE_FEED.md](docs/UPDATE_FEED.md)。

## 文档导航

- [产品文档](docs/PRODUCT.md)：产品目标、系统架构、数据模型和安全设计。
- [使用手册](docs/USER_GUIDE.md)：部署、初始化、配对、任务操作和故障排查。
- [管理后台](docs/ADMIN.md)：多用户服务的管理能力和运维边界。
- [容量评估](docs/CAPACITY.md)：不同注册用户数和并发连接规模的服务器建议。
- [更新源配置](docs/UPDATE_FEED.md)：桌面客户端后台更新和重启安装流程。
- [品牌规范](docs/BRANDING.md)：产品名称、图标、Slogan 和发布素材规范。

## Star 趋势

下图通过 Star History 动态读取 GitHub 数据，不把某个时间点的 Star 数量写死在文档中：

![AnytimeVibe GitHub Star History](https://api.star-history.com/svg?repos=demonrain/anytimevibe&type=Date)

也可以直接查看仓库的实时 Star 数：[github.com/demonrain/anytimevibe](https://github.com/demonrain/anytimevibe)。

## 开源协议

本项目采用 [MIT License](LICENSE)。代码、文档和示例可以在保留版权声明的前提下使用、修改和再发布。品牌名称、图标和宣传素材请勿暗示与原作者存在官方背书关系。

## 参与贡献

欢迎提交 Issue、改进文档和 Pull Request。涉及加密协议、权限边界、任务执行和更新源的改动，请同时补充测试与安全影响说明。

```bash
pnpm typecheck
pnpm test
pnpm build
```
