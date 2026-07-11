# 服务端更新源配置说明

随码桌面客户端（Windows / macOS）通过中继服务读取自动更新配置，再从更新源下载安装包。管理员只需在服务端配置 `UPDATE_FEED_URL`，客户端即可自动检查、下载并提示安装。

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

- 中继**不托管**安装包本身，只告诉客户端更新源 URL。
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
```

| 变量 | 必填 | 说明 |
|------|------|------|
| `UPDATE_FEED_URL` | 否 | 更新元数据与安装包所在目录的 HTTPS URL |
| `WINDOWS_CLIENT_URL` | 否 | Web 端 Windows 下载链接 |
| `MAC_CLIENT_URL` | 否 | Web 端 macOS 下载链接；留空则显示「敬请期待」 |

修改后需重新加载中继环境变量并重启：

```bash
docker compose up -d --force-recreate relay
# 或
docker compose restart relay
```

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
version: 0.4.5
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

## 5. 发布新版本流程

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

## 6. 客户端行为说明

| 场景 | 行为 |
|------|------|
| 开发模式（未打包） | 不检查更新，显示「开发模式不检查更新」 |
| 未配置 `UPDATE_FEED_URL` | 显示「服务端未配置更新源」 |
| 已是最新 | 状态回到空闲，提示「当前已是最新版本」 |
| 发现新版本 | 后台自动下载 |
| 下载完成 | 打开控制面板，显示「重启并更新」 |
| 用户点击「重启并更新」 | 退出并安装新版本 |

默认中继地址为 `https://vibe.demonrain.top`（可在控制面板修改）。更新检查始终使用**当前已保存的中继地址**上的 `/api/agent/config`。

## 7. 验证清单

```bash
# 1. 中继是否返回更新源
curl -sS https://你的域名/api/agent/config
# 期望: {"updateFeedUrl":"https://..."}

# 2. 元数据是否可访问
curl -sSI "$UPDATE_FEED_URL/latest.yml"
curl -sS  "$UPDATE_FEED_URL/latest.yml" | head

# 3. 安装包是否可下载
curl -sSI "$UPDATE_FEED_URL/AnytimeVibe-Agent-Setup.exe"
```

在客户端：

1. 确认中继地址正确并已保存。
2. 点击「检查更新」。
3. 观察状态：检查中 → 发现新版本 / 当前已是最新 / 错误信息。

## 8. 常见问题

**Q: 点击检查更新提示网络错误？**  
A: 检查中继是否可达、`UPDATE_FEED_URL` 是否 HTTPS 且匿名可访问；GitHub 私有仓库需改为公开或改用自建 CDN。

**Q: 一直显示「服务端未配置更新源」？**  
A: `.env` 中 `UPDATE_FEED_URL` 为空或未注入容器；修改后重启 relay，并用 `curl /api/agent/config` 确认。

**Q: 下载完成但安装失败？**  
A: Windows SmartScreen / 未签名；macOS 未签名公证。生产环境应配置代码签名。

**Q: `WINDOWS_CLIENT_URL` 和 `UPDATE_FEED_URL` 有何区别？**  
A: 前者是 Web 页给用户点的「首次下载」链接；后者是已安装 Agent 自动更新的目录地址。两者可以指向同一 Release 体系，但路径语义不同（文件 vs 目录）。

## 9. 安全建议

- 仅使用 HTTPS 更新源，防止安装包被中间人替换。
- 生产环境为 Windows / macOS 构建配置代码签名。
- 不要把更新源目录配置成可列目录且混放无关敏感文件。
- 版本号只升不降；回滚应发布更高版本号的回退包，或手动重装旧包。
