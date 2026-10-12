# 任务目录与大陆网络更新 Implementation Plan

> **For agentic workers:** Use the existing session to finish these tasks; the independent update transport task is delegated under `superpowers:dispatching-parallel-agents`. Preserve the current uncommitted changes and do not commit or release without a current user request.

**Goal:** 在网页直接选择远程电脑的任务目录，标题可选，按任务权限执行并显示准确路径和 Git 分支，同时让更新流量可以经过中转服务器。

**Architecture:** 目录列表与选择通过已有加密命令通道传输，Agent 校验真实目录，Web 使用点选式目录浏览器。macOS 先激活文件夹授权再读取文件。更新使用固定来源的下载中转与 npm 镜像；中转凭据只留在部署环境。

**Tech Stack:** TypeScript、Electron、React、Zod、Fastify、Vitest。

**Spec:** 本次用户的四项需求及后续补充：目录在前端选择、不手动输入；可选择后移除工作区；标题未填则由描述提取；服务器为用户提供的中转机器。

## Global Constraints

- 目录浏览器列出远程电脑的目录，不使用浏览器自己的文件选择器，也不要求手机用户操作电脑。
- 旧客户端不支持目录浏览时保留原有目录选择并提示更新客户端。
- macOS 系统未授权目录允许由电脑端授权，但不能先访问再授权，也不能静默替换任务目录。
- 保留旧工作区协议和书签以兼容历史配置，移除新版客户端工作区设置入口。
- 不把认证信息提交到仓库；密码文件为空时继续本地工作，等待有效服务器凭据。

## Task 1: 目录协议、列表与 macOS 授权

**Files:** `packages/protocol/src/index.ts`、`apps/agent/src/cli/task-directory.ts`、对应测试、`apps/agent/src/main.ts`。

**Interfaces:** `host.directory.list { path?: string }` → `host.directory.listed { commandId, path?, parentPath?, directories, requiresAuthorization?, error? }`。`host.status.directoryBrowsing` 声明支持。`resolveTaskDirectory(input, authorize?)` 先调用授权回调，再检查存在、类型与真实路径。

- [x] 添加并运行回归测试：授权回调中创建的目录可以被正确解析，拒绝授权不读取目录，列表只包含目录、支持上级路径、拒绝相对路径。
- [x] 实现目录列表与协议校验，通过磁盘根目录、用户目录和最近任务目录进入浏览。
- [x] 先激活并保存 macOS 文件夹书签，再调用 `stat/realpath`；重启恢复书签。
- [x] 运行 `pnpm test apps/agent/src/cli/task-directory.test.ts packages/protocol/src/protocol.test.ts`。

## Task 2: 网页选择、路径和分支信息

**Files:** `apps/web/src/TaskDirectoryPicker.tsx`、`apps/web/src/App.tsx`、`apps/web/src/styles.css`、Agent 路径及 Git 读取函数、对应测试。

**Interfaces:** 使用 Task 1 的列表协议；事件按 commandId 匹配，仅最后一次请求更新选择器。主机切换使用 `key={host.id}` 清除上一台电脑的目录。

- [x] 实现目录按钮、当前路径、上一级、选择当前目录、加载/错误/超时/离线状态；目录名称可搜索但无路径手动输入。
- [x] 新建任务不填标题时由描述生成；新增文案使用中英文。
- [x] 测试路径更新不能因旧路径较长而被覆盖；分支改变、无 Git 仓库、首次提交前分支和 detached HEAD 均正确。
- [x] 更新 README 与产品文档的工作区描述，运行 Web/Agent 相关测试。

## Task 3: 更新中转与验证（独立代理负责）

**Files:** Relay 更新路由及新模块、Agent 更新网络与版本查询模块、`docs/UPDATE_FEED.md`、中转部署说明。

**Interfaces:** 更新配置返回可用中转地址；Agent 在加载/更改中继配置时初始化更新网络。npm 安装和版本查询使用同一网络策略。

- [x] 测试固定更新源、路径穿越、Range、HEAD、ETag、流式下载和请求取消。
- [x] 补齐 GitHub/Cursor 版本查询的中转路径；原生 CLI 全量升级尚未在真实厂商网络和中转服务器上实测。
- [x] 在主进程接入更新网络，保持安装目录与包所有权检测。
- [x] 准备部署配置及检查命令；2026-10-12 已接入现有 Traefik 并部署到 `updates.demonrain.top`，业务 Relay 已下发新的更新配置。

## Completion checks

- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] Web 桌面与手机尺寸检查目录点选；确认完整路径和分支显示。
- [x] `git diff --check`
- [x] 记录本地验证证据；服务器部署及公网 npm/版本探针验证已完成，macOS 实机验证尚未完成。
