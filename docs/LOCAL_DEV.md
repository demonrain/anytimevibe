# 本地测试环境

用于在**发版前**完整联调：Web ↔ Relay ↔ Agent ↔ 本机 Codex。  
本地环境与线上隔离（独立数据库、独立 Agent 用户数据目录）。

## 架构

```
浏览器 http://127.0.0.1:4173  (Vite，代理 /api /ws)
        │
        ▼
   Relay http://127.0.0.1:8787
        │
        ├── PostgreSQL 127.0.0.1:5432  (Docker)
        │
        └── Agent Electron  (ANYTIMEVIBE_RELAY_URL=http://127.0.0.1:8787)
                 └── 本机 Codex CLI
```

## 依赖

| 软件 | 说明 |
|------|------|
| Node.js 22+ | 与仓库要求一致 |
| pnpm 10+ | `packageManager` 已锁定 |
| 本地 Postgres | **推荐无需 Docker**：`pnpm dev:pg`（embedded）或本机安装 PostgreSQL 16 |
| Docker Desktop | 可选；若一直卡在 Starting the Docker Engine，可不用 |
| Codex CLI 0.144.x | Agent 执行任务需要 |

> **不要用「管理员身份」终端跑 embedded Postgres**（PostgreSQL 禁止以 Administrator 启动）。用普通 Windows Terminal / PowerShell 即可。

## 一键准备

在仓库根目录：

```bash
pnpm install
pnpm dev:setup
```

会做这些事：

1. 若不存在则从 `.env.local.example` 生成 `.env.local`
2. 检测 Postgres（Docker 可用则启动；否则提示你用 `pnpm dev:pg`）
3. 构建 `@anytimevibe/protocol`

## Docker Desktop 卡住

若界面一直停在 **Starting the Docker Engine**：

常见原因：WSL2 后端起不来（`docker-desktop` 发行版 Stopped / `wsl` 命令挂起）。

在 **管理员 PowerShell** 中按顺序试：

```powershell
wsl --shutdown
net stop LxssManager
net start LxssManager
wsl --update
# 重启电脑后再开 Docker Desktop
```

仍不行：

- 设置 → 应用 → Docker Desktop → **修复**
- 或 `wsl --unregister docker-desktop` 后重装 Docker Desktop
- **更省事：不用 Docker**，改走下面的 `pnpm dev:pg` / 本机 PostgreSQL

## 启动服务（推荐：无 Docker）

用 **普通权限**（非管理员）终端：

```bash
# 终端 1 — 本地 Postgres（保持运行，Ctrl+C 结束）
pnpm dev:pg

# 终端 2 — Relay + Web
pnpm dev:stack

# 终端 3 — 桌面代理（数据在 .local/agent-data，中继 http://127.0.0.1:8787）
pnpm dev:agent:local
```

### 方式 B：本机安装 PostgreSQL（适合必须用管理员终端时）

```powershell
winget install -e --id PostgreSQL.PostgreSQL.16
# 安装完成后用 psql（默认超级用户 postgres）执行：
# CREATE USER anytimevibe WITH PASSWORD 'anytimevibe_dev' CREATEDB;
# CREATE DATABASE anytimevibe OWNER anytimevibe;
```

`.env.local` 中保持：

```dotenv
DATABASE_URL=postgres://anytimevibe:anytimevibe_dev@127.0.0.1:5432/anytimevibe
```

然后只需：

```bash
pnpm dev:stack
pnpm dev:agent:local
```

### 方式 C：Docker 正常时

```bash
pnpm dev:db:docker   # 或 docker compose -f docker-compose.dev.yml up -d
pnpm dev:stack
pnpm dev:agent:local
```

## 首次使用流程

1. 浏览器打开 **http://127.0.0.1:4173**
2. 初始化管理员：  
   - 设置令牌：`.env.local` 里的 `SETUP_TOKEN`（默认示例为 `local-dev-setup-token-change-me`）  
   - 自定用户名 / 密码（密码 ≥ 6 位）
3. 登录后 → **添加电脑** → 在 Agent 窗口点 **生成配对码** → Web 输入配对码
4. Agent 中 **添加白名单工作区**
5. Web **新建任务** 选择该工作区，验证发送 / 流式回复 / 简洁模式等

### Agent 中继地址

`pnpm dev:agent:local` 会：

- 使用环境变量 `ANYTIMEVIBE_RELAY_URL=http://127.0.0.1:8787`（覆盖配置）
- 使用独立目录 `.local/agent-data`，**不会动**你本机已安装的正式版随码配置

若界面仍显示旧中继，检查是否误开了正式安装的客户端。

## 常用命令

| 命令 | 作用 |
|------|------|
| `pnpm dev:setup` | 初始化 env + protocol，检测 Postgres |
| `pnpm dev:pg` | **推荐** 无 Docker 起 Postgres（embedded，需非管理员） |
| `pnpm dev:db` | 同 `dev:pg`（自动 Docker 或 embedded） |
| `pnpm dev:db:docker` | 仅 Docker Compose Postgres |
| `pnpm dev:db:down` | 停止 Docker 库并保留卷 |
| `pnpm dev:db:reset` | 删除 Docker 库数据卷 |
| `pnpm dev:stack` | 启动 Relay + Web |
| `pnpm dev:relay` | 仅 Relay（读 `.env.local`） |
| `pnpm dev:web` | 仅 Web（Vite :4173） |
| `pnpm dev:agent:local` | 本地测试用 Electron Agent |
| `pnpm test` | 单元测试 |
| `pnpm typecheck` | 全仓类型检查 |

## 改代码后如何验证

| 改动范围 | 本地怎么测 | 是否需要打客户端包 |
|----------|------------|--------------------|
| `apps/web/**` | 刷新 http://127.0.0.1:4173 | 否 |
| `apps/relay/**` | `tsx watch` 自动重启 | 否 |
| `packages/protocol/**` | `pnpm --filter @anytimevibe/protocol build` 后重启 relay/web/agent | 若 agent 要吃到协议再打包 |
| `apps/agent/**` | 停掉 Agent → `pnpm dev:agent:local` | 确认 OK 后再 `v*` tag 发版 |

建议流程：

1. 本地 `dev:stack` + `dev:agent:local` 测通  
2. 再 `git commit` / 推 main  
3. **仅当 agent 有行为变化时** 再 bump 版本、打 `v*` tag 触发 `build-clients`

## 环境变量（`.env.local`）

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | 指向本机 Docker Postgres |
| `SETUP_TOKEN` | 首次创建管理员 |
| `COOKIE_SECRET` | Session 签名（≥24 字符） |
| `PUBLIC_ORIGIN` | 必须与浏览器地址一致：`http://127.0.0.1:4173` |
| `ANYTIMEVIBE_RELAY_URL` | Agent 本地联调中继 |

模板见根目录 `.env.local.example`。`.env` / `.env.local` 已在 `.gitignore` 中。

## 故障排查

| 现象 | 处理 |
|------|------|
| Relay 启动报 `DATABASE_URL` | 先 `pnpm dev:setup` 或检查 `.env.local` |
| `ECONNREFUSED 5432` | 先起 `pnpm dev:pg`（非管理员）或本机 PostgreSQL 服务 |
| embedded 报 administrative permissions | 当前是管理员终端，换普通终端或装本机 PostgreSQL |
| Docker 一直 Starting the Docker Engine | 见上文 WSL 修复，或直接放弃 Docker 用 `dev:pg` |
| Web 登录后 WS 断 | 确认 Vite 代理、`PUBLIC_ORIGIN` 端口 4173 |
| Agent 连不上 | 中继是否 `http://127.0.0.1:8787`（不要 https） |
| 工作区为空 | Agent 已加白名单且在线；Web 新建任务会 `host.refresh` |
| 与正式版互相干扰 | 只用 `dev:agent:local`，关掉安装版随码 |
| 想清空本地库 | `pnpm dev:db:reset` 后重新 setup / 初始化管理员 |

## 停止

```bash
# Ctrl+C 停掉 dev:stack / dev:relay / dev:web / agent
pnpm dev:db:down
```
