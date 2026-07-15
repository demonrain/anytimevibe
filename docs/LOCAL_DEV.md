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
| Docker Desktop | 仅跑本地 Postgres |
| Codex CLI 0.144.x | Agent 执行任务需要 |

## 一键准备

在仓库根目录：

```bash
pnpm install
pnpm dev:setup
```

会做这些事：

1. 若不存在则从 `.env.local.example` 生成 `.env.local`
2. `docker compose -f docker-compose.dev.yml up -d` 启动 Postgres
3. 构建 `@anytimevibe/protocol`

> Windows：先打开 Docker Desktop，再执行 `pnpm dev:setup`。

## 启动服务

### 方式 A：Relay + Web 一起起（推荐）

```bash
pnpm dev:stack
```

另开终端启动本地 Agent：

```bash
pnpm dev:agent:local
```

### 方式 B：三个终端分别起

```bash
# 终端 1 — 数据库（若已 setup 可跳过）
pnpm dev:db

# 终端 2 — 中继
pnpm dev:relay

# 终端 3 — Web
pnpm dev:web

# 终端 4 — 桌面代理（隔离用户数据，强制连本地中继）
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
| `pnpm dev:setup` | 初始化 env + Postgres + protocol |
| `pnpm dev:db` | 启动本地 Postgres |
| `pnpm dev:db:down` | 停止并保留数据卷 |
| `pnpm dev:db:reset` | 停止并**删除**本地数据库卷 |
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
| `ECONNREFUSED 5432` | Docker 未起 / `pnpm dev:db` |
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
