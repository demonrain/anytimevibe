# 服务端更新源配置说明

随码桌面客户端（Windows / macOS）通过中继服务读取自动更新配置，再从更新源下载安装包。管理员只需在服务端配置 `UPDATE_FEED_URL`；生产环境建议同时配置独立的 `UPDATE_TRANSFER_URL`，让大文件、Cursor/Antigravity 版本探针以及 npm 引擎包从可控的传输域名进入大陆网络。

> 安装后程序显示名为「随码」；发布产物文件名仍为 `AnytimeVibe-Agent-Setup.exe` 等工程标识，以保证更新源与历史链接兼容。

## 1. 工作原理

```text
Agent 启动 / 每 6 小时 / 用户点击「检查更新」
        │
        ▼
GET {中继地址}/api/agent/config
        │
        ▼
返回 { "updateFeedUrl": "https://..." }
        │
        ▼
electron-updater 访问 updateFeedUrl
  ├── Windows: latest.yml + 安装包 + blockmap
  └── macOS:   latest-mac.yml + 安装包 + blockmap
```

可选的传输服务还提供：

```text
GET /api/agent/engine/cursor/install?win32=true
GET /api/agent/engine/antigravity/releases/latest
GET /api/agent/npm/@scope/package
GET /api/agent/npm/@scope/package/-/package-version.tgz
```

- 配置了 `UPDATE_TRANSFER_URL` 时，relay 会把 `updateFeedUrl`、`engineUpdateBaseUrl` 和 `npmRegistryUrl` 下发给新客户端；旧客户端仍读取 `updateFeedUrl`。
- 传输服务会转发 `Range`、`If-Range`、`If-None-Match`、`HEAD` 和源站的 ETag/`Cache-Control`。大文件按流转发，不受固定 30 秒总时长限制；桌面端断开会取消源站请求。
- npm 元数据中的 `dist.tarball` 会改写为 relay 地址；只允许官方引擎包及其声明的依赖，落盘前按 npm `integrity`/`shasum` 校验。响应头 `X-AnytimeVibe-Cache` 只会报告 `HIT`、`MISS` 或 `BYPASS`，不会把源站缓存策略伪装成命中。
- 未配置传输服务时，relay 仍兼容旧的单一 `UPDATE_FEED_URL` 路由；但不应把裸 IP HTTP 地址当生产更新源。
- 更新源必须是 electron-updater 的 **generic** 发布目录（含 YAML 元数据）。
- 若未配置 `UPDATE_FEED_URL`，客户端显示「服务端未配置更新源」，不影响配对与任务。

## 2. 环境变量

在部署根目录 `.env` 中配置：

```dotenv
# 客户端安装包下载入口（Web 登录页展示）
WINDOWS_CLIENT_URL=https://github.com/demonrain/anytimevibe/releases/latest/download/AnytimeVibe-Agent-Setup.exe
MAC_CLIENT_URL=https://github.com/demonrain/anytimevibe/releases/latest/download/AnytimeVibe-Agent.dmg

# Agent 自动更新源（目录 URL，不要指向具体 .exe）
UPDATE_FEED_URL=https://github.com/demonrain/anytimevibe/releases/latest/download

# 可选：独立 HTTPS 传输域名（建议与业务 relay 分离）
UPDATE_TRANSFER_URL=https://updates.example.com
NPM_REGISTRY_ORIGIN=https://registry.npmjs.org
UPDATE_CACHE_DIR=/app/apps/relay/data/update-cache
```

| 变量 | 必填 | 说明 |
|------|------|------|
| `UPDATE_FEED_URL` | 否 | 更新元数据与安装包所在目录的 HTTPS URL |
| `UPDATE_TRANSFER_URL` | 否 | 中继/独立传输服务的 HTTPS 根地址；用于固定更新、引擎探针和 npm 包地址。HTTP 仅允许 loopback 测试 |
| `NPM_REGISTRY_ORIGIN` | 否 | 传输服务读取 npm 元数据/压缩包的官方 registry 根地址；不接受带凭据的 URL |
| `UPDATE_CACHE_DIR` | 否 | 已校验元数据和包文件的持久目录；容器部署应挂载卷 |
| `WINDOWS_CLIENT_URL` | 否 | Web 端 Windows 下载链接 |
| `MAC_CLIENT_URL` | 否 | Web 端 macOS 下载链接；留空则显示「敬请期待」 |

修改后需重新加载中继环境变量并重启：

```bash
docker compose up -d --force-recreate relay
# 或
docker compose restart relay
```

独立传输服务使用 `docker-compose.update.yml`，接入已有的 Traefik 和外部 Docker 网络 `traefik-net`。先为更新域名配置 DNS 和 HTTPS，再构建并启动：

```bash
docker build -t anytimevibe-relay:updates -f apps/relay/Dockerfile .
docker compose -f docker-compose.update.yml up -d update-transfer
install -m 0644 traefik-anytimevibe-updates.yml /home/docker/traefik/config/dynamic/anytimevibe-updates.yml
```

示例使用 `updates.demonrain.top`，自建时同步修改 `UPDATE_DOMAIN` 和 `traefik-anytimevibe-updates.yml` 中的域名及证书设置。它只暴露更新 API，不连接 Postgres，也不承载任务、模型或登录流量。完整配置和验证见 [UPDATE_RELAY.md](UPDATE_RELAY.md)。

## 3. 更新源目录结构

`UPDATE_FEED_URL` 指向的目录在浏览器或 `curl` 下应能访问到下列文件（名称以实际构建产物为准）：

### Windows

```text
{UPDATE_FEED_URL}/
  latest.yml
  AnytimeVibe-Agent-Setup.exe
  AnytimeVibe-Agent-Setup.exe.blockmap
```

`latest.yml` 示例：

```yaml
version: 0.5.25
files:
  - url: AnytimeVibe-Agent-Setup.exe
    sha512: <base64-sha512>
    size: 12345678
path: AnytimeVibe-Agent-Setup.exe
sha512: <base64-sha512>
releaseDate: '2026-07-11T00:00:00.000Z'
```

### macOS

```text
{UPDATE_FEED_URL}/
  latest-mac.yml
  AnytimeVibe-Agent.dmg
  AnytimeVibe-Agent.zip          # 自动更新通常使用 zip
  AnytimeVibe-Agent.zip.blockmap
```

> 未签名 / 未公证的 macOS 构建，系统可能拦截安装与自动更新。生产分发需配置 Apple Developer ID 签名与公证。

## 4. 推荐托管方式

### 4.1 GitHub Releases（推荐公开项目）

1. 打 Tag 并触发构建，将产物上传到 Release。
2. 设置：

```dotenv
UPDATE_FEED_URL=https://github.com/<owner>/<repo>/releases/latest/download
WINDOWS_CLIENT_URL=https://github.com/<owner>/<repo>/releases/latest/download/AnytimeVibe-Agent-Setup.exe
MAC_CLIENT_URL=https://github.com/<owner>/<repo>/releases/latest/download/AnytimeVibe-Agent.dmg
```

要求：

- Release 资产文件名与 `latest.yml` / `latest-mac.yml` 内 `url` 一致。
- 仓库为公开，或下载 URL 对客户端匿名可达。

### 4.2 自建静态存储 / CDN

将构建产物同步到对象存储或静态站点，例如：

```text
https://updates.example.com/agent/
  latest.yml
  latest-mac.yml
  AnytimeVibe-Agent-Setup.exe
  ...
```

```dotenv
UPDATE_FEED_URL=https://updates.example.com/agent
```

要求：

- 全程 HTTPS。
- 允许跨域 GET（electron-updater 从桌面端发起，通常不依赖浏览器 CORS，但 CDN 勿拦截）。
- 支持 Range 请求更利于大文件与 blockmap 校验。

### 4.3 与中继同域

若希望与业务域名统一，可用 Caddy 反代静态目录：

```caddyfile
https://vibe.example.com {
  handle_path /updates/* {
    root * /var/www/anytimevibe-updates
    file_server
  }
  # ... 其余 reverse_proxy 到 web / relay
}
```

```dotenv
UPDATE_FEED_URL=https://vibe.example.com/updates
```

## 5. 原生 CLI 维护代理（可选）

部分官方 CLI 的 `update` 命令不是 npm 包安装。可为这些维护子进程配置一个单独的、带 HTTPS 的 CONNECT 代理：

```dotenv
UPDATE_PROXY_URL=https://proxy.example.com:9443
UPDATE_PROXY_TOKEN_SECRET=<至少 32 个字符的随机值>
```

只有已配对且未撤销的 Agent 在请求 `/api/agent/config` 时得到一个 15 分钟有效的带签名代理 URL；匿名请求得到 `engineUpdateProxyUrl: null`。首次安装前尚未配对的主机可以使用公共 npm 中转，但不能取得原生维护代理凭据。客户端仅把 `HTTP_PROXY`/`HTTPS_PROXY` 等变量注入引擎维护子进程，并将 relay/transfer 域名放入 `NO_PROXY`，不会改变任务/模型流量。代理仅接受 `CONNECT host:443`，并限制为厂商域名，拒绝内网、环回、文档和保留地址。

生成证书后启用可选服务：

```bash
docker compose -f docker-compose.update.yml --profile native-proxy up -d --build update-proxy
```

至少提供 `UPDATE_PROXY_CERT_DIR/fullchain.pem`、`privkey.pem`，并让 `UPDATE_PROXY_URL` 使用相同的公网 HTTPS 主机名。证书续期后重启 `update-proxy` 加载新证书。不要把 `UPDATE_PROXY_TOKEN_SECRET` 写入镜像或提交到仓库。

边界：Cursor 当前官方脚本把下载地址硬编码在 `downloads.cursor.com`，没有可验证的镜像变量；Windows PowerShell 的部分官方安装脚本也可能忽略 `HTTP(S)_PROXY`。因此该代理只保证“厂商程序遵守代理环境变量”的维护路径，不能声称所有厂商自更新都已强制中转。Cursor/Antigravity 的版本检查本身会走 `/api/agent/engine/*`；安装脚本是否走代理取决于脚本实现。

## 6. 发布新版本流程

1. 提升 `apps/agent/package.json` 的 `version`。
2. 构建：

```bash
# Windows
pnpm --filter @anytimevibe/agent package:win

# macOS（需在 macOS 或 CI macos runner）
pnpm --filter @anytimevibe/agent package:mac
```

3. 将 `apps/agent/release/` 中的安装包、blockmap、`latest.yml` / `latest-mac.yml` 上传到更新源目录。
4. 确认 `UPDATE_FEED_URL` 下元数据中的 `version` 高于已安装客户端。
5. 在已安装的 Agent 中点击「检查更新」，或等待 6 小时自动检查。

## 7. 客户端行为说明

| 场景 | 行为 |
|------|------|
| 开发模式（未打包） | 不检查更新，显示「开发模式不检查更新」 |
| 未配置 `UPDATE_FEED_URL` | 显示「服务端未配置更新源」 |
| 已是最新 | 状态回到空闲，提示「当前已是最新版本」 |
| 发现新版本 | 后台自动下载 |
| 下载完成 | 保留后台运行，网页和控制面板显示可安装状态 |
| 网页选择「后台下载并在空闲时安装」或本机点击「重启并更新」 | 持久化安装意图；运行、准备启动、等待审批、排队任务及 CLI 维护全部结束后才安装 |
| 准备静默安装 | 检查安装包、目标目录和权限，启动独立辅助进程并确认就绪；失败时保留客户端在线 |
| 安装并重启 | Windows NSIS 静默执行；macOS 原子替换应用并保留旧版备份，网页保留状态自动重连 |
| 客户端重新上线 | 核对实际运行版本，确认完成或报告失败；失败不会无限自动重试 |
| 取消延后安装 | 撤销安装意图，保留已下载更新包；安装已经开始后不能取消 |

默认中继地址为 `https://vibe.demonrain.top`（可在控制面板修改）。更新检查始终使用**当前已保存的中继地址**上的 `/api/agent/config`。

网页复用已配对主机的加密命令通道：`host.client.update` 只接受 `check`、`upgrade`、`cancel` 三个动作，不接受安装地址、路径或命令。更新源仍由服务端下发，下载安装包继续使用 electron-updater 的完整性校验。`host.client.update.status` 和 `host.status.clientUpdate` 同步进度和恢复结果，刷新网页也能重新获取状态。

Windows 的 NSIS 更新使用 `/S`、`/currentuser`、`--updated` 和固定目标目录，安装器由独立无窗口辅助进程启动并受控，不依赖 `--force-run` 或交互式提权。安装前会把整个应用目录备份到同一父目录；安装器或新版启动失败时，辅助进程会先停止自己创建的进程树，再恢复完整旧版文件并重新启动客户端。该文件级恢复不对安装器可能修改的注册表、快捷方式等系统副作用提供事务回滚；安装目录、父目录和额外备份空间必须可写。macOS 在退出前预解压并验证应用身份、版本及可写目录，替换时保留独立备份，新版启动健康检查失败时恢复旧版；DMG 和只读目录无法远程更新。

客户端用户数据目录保留 `client-update-health.json`（运行版本、PID 和启动心跳）、`client-update-result.json`（辅助安装结果），安装意图保存在 `agent-config.json`。辅助进程确认就绪前，客户端不会断开；恢复后核对实际版本且不无限重试。旧版 Agent 未声明 `clientUpdate.supported` 时，网页只提供手动下载入口，首次需手动升级到支持此能力的客户端。

## 8. 验证清单

```bash
# 1. 中继是否返回更新源
curl -sS https://你的域名/api/agent/config
# 期望: {"updateFeedUrl":"https://..."}

# 2. 元数据是否可访问
curl -sSI "$UPDATE_FEED_URL/latest.yml"
curl -sS  "$UPDATE_FEED_URL/latest.yml" | head

# 3. 安装包是否可下载
curl -sSI "$UPDATE_FEED_URL/AnytimeVibe-Agent-Setup.exe"

# 新传输服务（期望是 HTTPS）
curl -sS https://updates.example.com/api/health
curl -sSI https://updates.example.com/api/agent/update/latest.yml
curl -sSI -H 'Range: bytes=0-15' https://updates.example.com/api/agent/update/AnytimeVibe-Agent-Setup.exe
curl -sS https://updates.example.com/api/agent/npm/@openai/codex | head
```

在客户端：

1. 确认中继地址正确并已保存。
2. 点击「检查更新」。
3. 观察状态：检查中 → 发现新版本 / 当前已是最新 / 错误信息。

## 9. 常见问题

**Q: 点击检查更新提示网络错误？**  
A: 检查中继是否可达、`UPDATE_FEED_URL` 是否 HTTPS 且匿名可访问；GitHub 私有仓库需改为公开或改用自建 CDN。

**Q: 一直显示「服务端未配置更新源」？**  
A: `.env` 中 `UPDATE_FEED_URL` 为空或未注入容器；修改后重启 relay，并用 `curl /api/agent/config` 确认。

**Q: 下载完成但安装失败？**  
A: 先查看网页返回的具体原因。Windows 全机安装、管理员目录、需要提权的安装器会在退出前被拒绝；macOS 需从可写目录内的 `.app` 运行，不能直接从 DMG 运行。新版启动失败会记录辅助进程结果并尝试恢复运行。代码签名、Apple 公证和系统策略仍影响真实机器上的安装，应在发布前进行平台验证。

**Q: 网页显示等待安装或一直未重连？**

A: 等待安装会检查所有运行/待审批/排队任务和编码引擎维护；处理审批或完成队列后才会继续，也可以取消延后安装。重启后网页自动重连，超过 5 分钟仍离线会改为故障提示，请查看电脑上的客户端和上述结果文件；下载完成或命令已发送都不等于升级成功。

**Q: `WINDOWS_CLIENT_URL` 和 `UPDATE_FEED_URL` 有何区别？**  
A: 前者是 Web 页给用户点的「首次下载」链接；后者是已安装 Agent 自动更新的目录地址。两者可以指向同一 Release 体系，但路径语义不同（文件 vs 目录）。

## 10. 安全建议

- 仅使用 HTTPS 更新源，防止安装包被中间人替换。
- 生产环境为 Windows / macOS 构建配置代码签名。
- 不要把更新源目录配置成可列目录且混放无关敏感文件。
- `X-AnytimeVibe-Cache: HIT` 表示本机已通过完整性校验的缓存文件；`MISS` 表示本次下载并校验后落盘；`BYPASS` 表示直接流式代理，不能据此声称已缓存。
- npm 包必须保留官方 `integrity` 或 `shasum`；缺失摘要或摘要不匹配时中继拒绝服务并删除临时文件。
- 版本号只升不降；回滚应发布更高版本号的回退包，或手动重装旧包。
