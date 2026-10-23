# 远程 CLI 环境安装设计

## 目标

允许 Web 端对已配对且在线的桌面客户端远程安装缺失的编码引擎 CLI，并在安装后验证真实命令、版本和模型目录；Node.js 作为独立的运行环境安装项，不在 CLI 安装中隐式替换。

## 背景与现状

当前引擎维护协议只有 `host.engine.update` 和 `host.engine.refresh`。桌面端的 `installEnvironment` 主要用于本机 IPC，Windows 会打开可见控制台，macOS 会打开 Terminal，不能安全地从 Web 远程触发。`EngineMaintenance` 对更新要求引擎已安装，因此缺失引擎在 Web 上没有可执行入口。

## 范围

### 本次支持

- 远程安装 Codex、Claude Code、Pi CLI。
- 远程安装 Cursor Agent、Grok Build、Google Antigravity（仅使用固定的官方安装入口，并按平台执行）。
- Windows 和 macOS；Linux 继续返回不支持，不伪造成功。
- 复用现有的中继代理、本机代理、npm 镜像回退和加密主机通道。
- 安装过程使用维护锁，禁止对应引擎有运行中任务、待审批操作或排队任务。
- 安装完成后重新探测命令路径、版本和模型目录，并向 Web 回传最终状态。
- Node.js 作为单独的本地/远程环境安装目标；CLI 安装发现 Node 缺失时只返回明确的前置条件错误。

### 不在本次范围

- 不从浏览器接收任意命令、脚本、URL、安装路径或管理员凭据。
- 不自动提权，不通过 UAC/`sudo` 模拟用户确认。
- 不在后台自动替换现有 Node.js，也不删除或卸载已有 CLI。
- 不承诺厂商没有静默模式的安装器可以无人值守完成；此类情况必须报告“不支持静默安装”。

## 用户流程

1. Web 打开远程主机的“CLI / MODELS”维护窗口。
2. 对 `availableEngines` 中 `ready !== true` 的引擎显示“远程安装”；已安装且有新版本的引擎显示“升级 CLI”。
3. 点击安装后，Web 发送 `host.engine.install`，客户端立即创建 `install` 操作并发布 `installing` 进度。
4. 客户端检查平台、Node/npm 前置条件和引擎占用状态，然后执行固定安装步骤。
5. 客户端重新探测可用命令和版本，刷新模型目录；验证失败时操作进入 `failed`，保留错误详情和重试入口。
6. 成功时操作进入 `completed`，Web 自动显示新的版本、模型数量和“已安装”状态。

## 协议设计

### 命令

在 `ClientCommand` 增加：

```ts
{ type: "host.engine.install"; commandId: string; cliEngine: CliEngine }
```

不增加可由浏览器传入的命令参数。

### 操作状态

- `EngineOperation.action` 增加 `install`。
- `EngineOperation.phase` 增加 `installing`。
- `previousVersion` 对安装可省略；成功必须包含探测到的 `version`。
- 安装进度通过现有 `detail` 字段传递，并沿用 1000 字符上限、ANSI 清理和密钥脱敏。

### 兼容性

新字段保持在 `host.status.engineManagement` 可选结构内。旧 Web 客户端忽略新操作，旧 Agent 拒绝未知命令并发布错误；新 Web 在收到不支持的错误时显示可读提示。

## 客户端实现

### EngineMaintenance

- 增加 `install` 命令类型和 `install(engine, onOutput)` 依赖。
- `execute` 对 `install` 允许 `ready === false`，但要求未存在同引擎任务或维护操作。
- 安装和升级共享全局锁、通知队列、失败后重新探测和模型同步。
- 安装成功验证 `ready === true`、版本符合 semver，并将最终版本写入操作状态。

### 固定安装策略

- Codex：使用检测到的 `npm`，按用户前缀安装 `@openai/codex@latest`，Windows 保留 `--include=optional --bin-links=true` 和现有 shim 修复。
- Claude：使用检测到的 `npm` 安装 `@anthropic-ai/claude-code@latest`，执行现有 optional native binary 修复步骤。
- Pi：使用检测到的 `npm` 安装 `@earendil-works/pi-coding-agent@latest`，保留现有安全的脚本参数和安装后验证。
- Cursor：使用固定的官方安装脚本地址和当前平台参数，下载到临时文件后执行，不使用浏览器输入。
- Grok：使用固定的 x.ai 官方安装脚本，设置现有用户级安装目录并验证 `grok`。
- Antigravity：使用固定的 antigravity.google 官方安装脚本，设置现有用户级安装目录并验证 `agy`。

所有步骤都通过现有进程树清理执行器运行，使用超时、输出脱敏和代理环境；网络失败时只对 npm 安装步骤尝试已配置镜像，不对任意脚本做未知重试。

### Node.js 前置条件

Node.js 安装不绑定到 `host.engine.install`。客户端维护界面可复用现有本地 `installEnvironment("node")` 能力，但远程协议本次只增加 CLI 安装；若远程 CLI 安装缺少 Node，返回带有“请先安装 Node.js”的失败状态。后续可单独扩展 `host.runtime.install`。

## Web 实现

- `sendEngineMaintenance` 增加 `install` action，并只对缺失引擎启用。
- `EngineManagementDialog` 根据 `installed` 和 `updateAvailable` 显示“远程安装 / 升级 CLI / 已是最新”。
- 安装按钮、升级按钮和刷新按钮共享全局忙碌态；运行中任务显示现有占用提示。
- 增加中英文文案：远程安装、安装中、安装完成、Node.js 前置条件、静默安装不支持和无确认超时。
- 保持断线后依靠 `host.status` 恢复状态；不把临时浏览器请求状态当成最终事实。

## 安全与失败处理

- 命令只接受协议枚举中的引擎值；所有包名、官方 URL、安装目录和参数由客户端代码固定生成。
- 远程安装不读取或上传 API Key、npm token 或本地配置内容。
- 安装前拒绝忙碌引擎；执行中客户端断线不取消本地安装；安装完成后下一次状态上报必须包含实际探测结果。
- 安装器退出码非零、命令不可执行、版本缺失、模型刷新失败或平台不支持均进入 `failed`，保留经过脱敏和截断的详情。
- 不删除旧安装，不接受 `--force` 覆盖已有 shim；已有文件冲突返回可操作错误。

## 测试验收

- 协议测试验证新命令、新 action 和新 phase 的解析及恶意额外字段拒绝。
- `EngineMaintenance` 测试验证：缺失引擎可安装、已安装引擎可升级、忙碌/并发拒绝、失败后重新探测、成功后同步模型、重复点击只执行一次。
- 安装步骤测试验证六个引擎的固定包名/URL、平台分支、Node 缺失错误、代理环境和输出脱敏。
- Web 测试验证缺失引擎显示安装、安装请求正确发送、状态回传后按钮恢复和失败详情展示。
- 运行完整 `pnpm test`、agent typecheck、web typecheck 和 agent build；涉及 `apps/agent` 时升级客户端版本并发布客户端。

