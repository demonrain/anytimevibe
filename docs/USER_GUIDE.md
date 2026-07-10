# AnytimeVibe 使用手册

- 手册版本：`v0.1`
- 适用产品：AnytimeVibe MVP
- 适用 Codex：`codex-cli 0.144.x`

## 1. 使用前准备

AnytimeVibe 由三个部分组成：

- VPS 服务：提供网页、中继、数据库和 Push。
- Windows 代理：安装在运行 Codex 的电脑上。
- PWA：在手机或其他浏览器中访问。

开始前请确认：

- 已有一个可以通过 HTTPS 访问的 AnytimeVibe 服务地址。
- Windows 电脑已安装并登录 Codex CLI。
- `codex --version` 输出为 `0.144.x`。
- Windows 电脑能够主动访问 AnytimeVibe 服务地址。
- Windows 用户会保持登录；锁屏可以，注销或关机会使代理离线。

## 2. 服务端部署

如果服务已经由其他人部署，可以跳到“首次初始化”。

### 2.1 环境要求

- 一台带公网 IP 的 Linux VPS。
- 一个解析到 VPS 的域名。
- Docker Engine 和 Docker Compose。
- 对公网开放 TCP 80 和 443。

### 2.2 配置环境变量

在项目根目录复制配置模板：

```bash
cp .env.example .env
```

至少配置以下项目：

```dotenv
DOMAIN=vibe.example.com
POSTGRES_PASSWORD=请替换为高强度随机密码
SETUP_TOKEN=请替换为至少24位随机令牌
COOKIE_SECRET=请替换为至少32位随机字符串
VAPID_PUBLIC_KEY=Web Push 公钥
VAPID_PRIVATE_KEY=Web Push 私钥
VAPID_SUBJECT=mailto:admin@example.com
```

`.env.example` 中的 `DATABASE_URL` 用于非 Compose 部署。Docker Compose 会根据 `POSTGRES_PASSWORD` 自动组成数据库连接地址。

生成 Web Push 密钥：

```bash
pnpm --filter @anytimevibe/relay exec web-push generate-vapid-keys
```

如果暂时不配置 VAPID，登录、配对和任务功能仍可使用，但“开启通知”会提示服务端未配置 Push。

### 2.3 启动服务

```bash
docker compose up -d --build
```

检查容器：

```bash
docker compose ps
docker compose logs -f relay
```

Caddy 会自动申请 TLS 证书。浏览器应能打开：

```text
https://你的域名
```

## 3. 首次初始化

1. 在浏览器打开 AnytimeVibe 地址。
2. 页面显示“初始化个人空间”。
3. 输入服务端 `.env` 中的 `SETUP_TOKEN`。
4. 设置用户名。
5. 设置不少于 10 个字符的密码。
6. 点击“创建空间”。

系统只允许创建一个用户。初始化完成后，后续访问会显示普通登录页。

请把 `SETUP_TOKEN` 作为部署凭据妥善保管。产品不会通过邮件找回密码。

## 4. 安装 Windows 代理

安装包位置：

```text
apps/agent/release/AnytimeVibe Agent Setup 0.1.0.exe
```

### 4.1 安装步骤

1. 将安装包放到运行 Codex 的 Windows 电脑。
2. 双击安装包。
3. 如果 SmartScreen 提示“Windows 已保护你的电脑”，点击“更多信息”。
4. 确认文件来源后点击“仍要运行”。
5. 选择安装目录并完成安装。
6. 启动 `AnytimeVibe Agent`。

当前安装包没有代码签名，因此出现 SmartScreen 提示属于预期现象。正式公开分发前应配置 Windows 代码签名证书。

### 4.2 代理启动行为

- 代理显示托盘图标和控制面板。
- 安装后会配置为当前 Windows 用户登录时自动启动。
- 关闭控制面板只会隐藏窗口，不会退出托盘代理。
- 如需完全退出，在托盘菜单选择“退出”。

## 5. 配置中继并配对

### 5.1 在电脑端配置

1. 打开 AnytimeVibe Agent 控制面板。
2. 在“中继服务器”输入完整地址，例如：

```text
https://vibe.example.com
```

3. 点击“保存”。
4. 确认面板显示 Codex 版本为 `0.144.x`。
5. 点击“生成配对码”。
6. 记下六位配对码。

配对码约十分钟后失效。失效后重新生成即可。

### 5.2 在 PWA 中确认

1. 登录 AnytimeVibe。
2. 点击主机栏右侧的 `＋`，或点击“连接第一台电脑”。
3. 输入六位配对码。
4. 检查电脑名称、系统和 Codex 版本。
5. 点击“确认并连接”。
6. 等待 Windows 代理显示“online”。

配对过程中会自动交换端到端加密密钥。不要通过聊天或公开渠道长期分享仍然有效的配对码。

## 6. 添加工作区

远程端只能操作电脑端明确允许的目录。

1. 打开 Windows 代理控制面板。
2. 在“允许的工作区”区域点击“添加目录”。
3. 选择项目根目录。
4. 目录出现在工作区列表后，代理会立即同步到 PWA。

建议每个仓库单独添加，不要直接添加磁盘根目录、用户主目录或包含大量无关项目的父目录。

移除工作区：

1. 在代理工作区列表找到对应目录。
2. 点击“移除”。
3. 新任务将不能再选择该目录。

移除目录不会删除项目文件，也不会删除已经存在的 Codex 线程。

## 7. 安装 PWA 到手机

### 7.1 Android Chrome

1. 使用 Chrome 打开 AnytimeVibe。
2. 打开浏览器菜单。
3. 选择“安装应用”或“添加到主屏幕”。
4. 从主屏幕启动 AnytimeVibe。

### 7.2 iPhone Safari

1. 使用 Safari 打开 AnytimeVibe。
2. 点击分享按钮。
3. 选择“添加到主屏幕”。
4. 从主屏幕图标启动。

iOS 上的 Web Push 需要以已安装到主屏幕的 PWA 形式运行。

## 8. 创建第一个任务

1. 在左侧或顶部主机列表选择在线主机。
2. 确认状态显示“主机在线，命令将立即执行”。
3. 点击“新任务”。
4. 选择电脑端允许的工作区。
5. 可选填写任务标题。
6. 输入给 Codex 的完整任务指令。
7. 点击“开始任务”。

建议在第一条指令中说明：

- 希望实现或修复什么。
- 哪些内容不应修改。
- 是否需要运行测试或构建。
- 验收标准是什么。

提交后，代理会在所选目录创建 Codex 线程，并沿用本机 `AGENTS.md`、Codex 配置、沙箱和认证信息。

## 9. 查看和继续任务

### 9.1 查看对话

- `YOU` 表示从 PWA 发出的指令。
- `CODEX` 表示 Codex 的流式回复。
- `SYSTEM` 表示计划等系统型线程内容。
- 任务卡片显示最近状态、消息摘要、工作区和待审批数量。

### 9.2 继续空闲任务

1. 选择任务。
2. 在底部输入新的要求。
3. 点击“发送”。

系统会在同一 Codex 线程中创建新回合。

### 9.3 给运行中任务追加方向

任务运行时仍可在输入框补充要求，例如：

```text
先不要调整数据库结构，只修复接口兼容问题。
```

此操作使用 Codex 的 steer 能力，不会创建新的独立任务。

### 9.4 停止任务

任务运行时点击输入区旁的“停止”。Codex 会中断当前回合，已经写入磁盘的修改不会因此自动撤销。

## 10. 处理审批

当 Codex 请求执行受限制命令或修改文件时，对话区会出现橙色审批卡片。

### 10.1 命令执行审批

审批卡片会尽量显示：

- 待执行命令。
- 工作目录。
- Codex 提供的审批原因。

可选择：

- 允许一次：仅批准当前请求。
- 拒绝：不允许执行。
- 取消：取消当前审批。

### 10.2 文件修改审批

在允许前检查目标目录和原因。MVP 不提供“永久允许”，也不会从手机端降低 Codex 的沙箱级别。

### 10.3 审批失效

如果审批已在其他客户端处理、任务已结束或连接中断，卡片可能自动消失。不要反复提交已经失效的审批。

## 11. 查看 Diff

1. 打开一个任务。
2. 点击对话区右上角的“Diff”。
3. 查看当前回合汇总的统一 Diff。

颜色含义：

- 绿色：新增内容。
- 红色：删除内容。
- 黄色：Diff 区块标题。

Diff 只用于查看。应用、撤销、暂存或提交代码仍应回到电脑完成。

## 12. 开启通知

1. 登录 PWA。
2. 点击顶栏“开启通知”。
3. 允许浏览器发送通知。

通知类型：

- 任务需要审批。
- 任务已完成。

通知不会包含项目名、命令、代码或对话正文。

如果按钮提示服务端未配置 Push，请让服务管理员配置 VAPID 密钥并重启 relay 服务。

## 13. 主机离线时

主机离线可能由以下原因造成：

- 电脑关机、休眠或断网。
- Windows 用户已注销。
- 代理已退出。
- Codex app-server 异常退出。
- VPS 或 WSS 连接不可用。

离线状态下：

- 可以查看已经同步到云端的加密历史。
- 不能创建、继续、追加或停止任务。
- 不会把命令加入队列等待电脑上线后自动执行。

电脑恢复后，代理会自动重连并重新同步线程。

## 14. 管理和撤销主机

在左侧设备列表中找到要删除的主机，点击设备行右侧的 `×`，并在确认窗口中确认删除。

撤销后：

- 代理令牌失效。
- 当前 WSS 被关闭。
- 中继删除该主机的加密同步事件。
- Windows 项目文件和 Codex 本地线程不会被删除。

## 15. 密钥、缓存与恢复

### 15.1 清除浏览器数据的影响

浏览器同步密钥保存在该站点的 IndexedDB 中。清除站点数据、使用无痕模式或更换浏览器后，原浏览器中的密钥会丢失。

如果 Windows 主机仍可用：

1. 重新生成配对码。
2. 在新浏览器重新配对。
3. 代理重新读取 Codex 线程并以新密钥同步当前历史。

如果主机也不可用，新浏览器无法解密云端已有密文。MVP 尚未提供密钥导出和恢复码。

### 15.2 服务端备份

建议定期备份：

- Docker 卷 `postgres-data`。
- Caddy 的 `caddy-data` 和 `caddy-config`。
- 服务器 `.env`，并使用安全的密码管理工具保存。

不要公开 `.env`、数据库备份或 `COOKIE_SECRET`。

## 16. 安全建议

- 使用独立、高强度密码，不与其他网站共用。
- 只在受信任设备登录 PWA。
- 不要将宽泛目录加入工作区白名单。
- 定期更新 VPS、Docker 镜像和 Windows 系统。
- 在升级 Codex CLI 前确认新版本是否仍为 `0.144.x`，否则代理会拒绝启动远程任务。
- 不要关闭 HTTPS 或把 relay 的 8787 端口直接公开到公网。
- 不要在中继日志中主动添加请求正文或解密内容。

## 17. 常见问题

| 现象 | 原因 | 处理方法 |
| --- | --- | --- |
| 页面一直无法连接 | VPS、域名或 TLS 不可用 | 检查 `docker compose ps`、Caddy 日志和域名解析 |
| 登录提示 `invalid_credentials` | 用户名或密码错误 | 检查输入；MVP 没有自助找回密码 |
| 初始化提示 `invalid_setup_token` | 设置令牌不一致 | 对照 VPS `.env` 中的 `SETUP_TOKEN` |
| 页面提示 `invalid_origin` | 实际访问域名与 `PUBLIC_ORIGIN` 不一致 | 修正环境变量并重启 relay |
| 配对码不存在 | 配对码错误或已过期 | 在 Windows 代理重新生成 |
| 代理显示 `incompatible` | Codex CLI 版本不是 `0.144.x` | 安装受支持版本或等待适配器升级 |
| 没有可选工作区 | 代理端尚未添加目录 | 在 Windows 代理点击“添加目录” |
| 创建任务提示主机离线 | WSS 未连接或代理退出 | 打开托盘代理并点击“重新连接” |
| 浏览器提示没有解密密钥 | 当前浏览器未完成该主机配对或站点数据被清除 | 重新配对并让主机重新同步 |
| 没有 Push | 未授权通知、未安装 PWA 或服务端缺少 VAPID | 检查浏览器权限、PWA 安装和 VAPID 配置 |
| 关闭代理窗口后主机仍在线 | 窗口只是隐藏到托盘 | 从托盘菜单选择“退出” |
| 停止任务后文件仍被修改 | 中断不会自动撤销已有写入 | 回到电脑检查 Git Diff 并自行回滚 |
| 安装包出现 SmartScreen | 当前安装包未签名 | 核对文件来源和 SHA256 后选择“仍要运行” |

## 18. 运维命令

查看服务：

```bash
docker compose ps
```

查看中继日志：

```bash
docker compose logs -f relay
```

重启服务：

```bash
docker compose restart relay web caddy
```

升级并重建：

```bash
docker compose pull
docker compose up -d --build
```

本地代码验证：

```powershell
pnpm typecheck
pnpm test
pnpm build
```

重新生成 Windows 安装包：

```powershell
pnpm --filter @anytimevibe/agent package:win
```

## 19. 当前安装包校验

文件：

```text
AnytimeVibe Agent Setup 0.1.0.exe
```

SHA256：

```text
C4A217DEA42CDC0381BD7CF310A3AD1A2A36366871D35EEDA4CE406F37D6DEE8
```

后续重新构建安装包后，文件哈希会发生变化，应以实际发布渠道提供的新哈希为准。
