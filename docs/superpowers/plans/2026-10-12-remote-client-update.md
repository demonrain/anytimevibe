# 网页静默升级客户端 Implementation Plan

**Goal:** 已配对的网页能触发客户端后台下载，在任务和队列完成后静默安装，失败时尽量恢复旧客户端，重新连接后确认实际版本。

**Architecture:** 复用现有加密命令通道和 electron-updater 下载校验；新增客户端更新控制器管理延后安装与重启恢复。平台安装器在退出前完成权限、文件和辅助进程检查，Windows 使用 NSIS 静默参数，macOS 使用已准备好的应用目录原子替换与备份恢复。独立辅助进程监控启动心跳，失败后重新打开旧版并保留错误供网页显示。

**Tech Stack:** TypeScript、Electron、React、Zod、Vitest、PowerShell、macOS 系统命令。

**Spec:** 用户已确认此前提出的后台下载、任务完成后安装、自动重连方案，并明确要求各平台静默安装，避免安装向导导致客户端长期离线。

## Global Constraints

- 不升级正在运行、准备启动、等待审批或有队列的任务；编码引擎维护操作也必须结束后才安装。
- 网页命令不能传入下载地址、命令或安装路径，只接受固定的 check、upgrade、cancel 动作。
- 权限不足、运行于 DMG 或安装器准备失败时保留当前客户端运行；不弹出需要用户交互的提权向导。
- 安装前持久化目标版本和操作 ID；重启后用运行版本确认完成，相同旧版本则反馈失败，不能无限重试。
- 下载状态和安装意图均通过加密事件同步，host.status 携带最新状态以支持网页刷新。
- 不提交、推送、改版本或发版；当前请求为实现功能，发布仍按仓库约定执行。

## Task 1: 协议和更新控制

**Files:** `packages/protocol/src/index.ts`、`packages/protocol/src/protocol.test.ts`、`apps/agent/src/client-update.ts`、`apps/agent/src/client-update.test.ts`。

**Interfaces:** `host.client.update { commandId, action: check | upgrade | cancel }`；`host.client.update.status { update: ClientUpdateState }`；`host.status.clientUpdate?: ClientUpdateState`。
`ClientUpdateState` 包含 supported、status（idle/checking/available/downloading/ready/waiting/installing/completed/error）、currentVersion、version?、progress?、commandId?、installWhenIdle?、message?、updatedAt。

- [x] 用协议测试确认固定动作有效、未知动作和注入参数被拒绝。
- [x] 更新控制器接收原生下载状态，保存升级意图，只在空闲时安装；重复点击、取消、权限失败和重启版本确认均有测试。
- [x] `pnpm test packages/protocol/src/protocol.test.ts apps/agent/src/client-update.test.ts` 先验证新增测试失败，再实现并验证通过。

## Task 2: 平台静默安装与恢复

**Files:** `apps/agent/src/client-update-installer.ts`、`apps/agent/src/client-update-installer.test.ts`。

**Interfaces:** `prepareSilentClientUpdate(options): Promise<{ launch(): Promise<void>; dispose(): Promise<void> }>`。options 包含 platform、installerPath、appPath、executablePath、userDataPath、currentPid、currentVersion、targetVersion、operationId。`dispose()` 只用于辅助进程启动前清理已准备的临时文件。
辅助进程读取 `userDataPath/client-update-health.json` 中的 version、pid、updatedAt，写入 `userDataPath/client-update-result.json` 中的 operationId、success、message。启动心跳由客户端在初始化后写入。

- [x] 安装前验证已下载文件、目标可写、辅助进程成功启动；所有路径用平台原生参数或正确字面量转义。
- [x] Windows 通过受控 NSIS `/S /currentuser /D=...` 与 `--updated` 启动，完整备份应用目录；有界等待失败后停止自有进程树并恢复旧版，避免提权弹窗。
- [x] macOS 在退出前解压并验证应用；替换时保留唯一备份，启动失败则恢复并重新打开旧应用。
- [x] 测试实际文件校验、权限拒绝、特殊字符路径、辅助进程失败恢复；使用受控假安装器验证，禁止真实更新用户客户端。macOS 原生解压、签名和启动仍需 macOS runner/实机验证。

## Task 3: 网页升级入口与状态

**Files:** `apps/web/src/ClientUpdatePanel.tsx`、`apps/web/src/client-update-ui.test.tsx`、`apps/web/src/App.tsx`、`apps/web/src/styles.css`。

- [x] 使用 Task 1 的 ClientUpdateState 和命令；旧客户端缺少能力时明确提示先更新客户端。
- [x] 版本提示区提供检查、升级、取消延后安装，并显示下载进度、等待任务、重连、成功或失败。
- [x] 离线时保留安装状态，不丢弃操作；对长时间未重新上线提供故障提示，不能无限显示“升级中”。
- [x] 测试事件恢复、旧版能力清除、离线状态与超时提示；适配中文、英文及手机布局。

## Task 4: 主进程集成、验证与说明

**Files:** `apps/agent/src/main.ts`、`docs/UPDATE_FEED.md`、`docs/USER_GUIDE.md`。

- [x] 接入原生更新事件、持久化状态和独立安装器；禁止退出时自动安装绕过任务保护。
- [x] 安装准备期间阻止新任务和 CLI 维护竞争；当前操作完成后再退出并自动重连。外部 CLI/接力终端脚本通过完成回执持有维护锁，异常关闭且无法确认子进程结束时保持客户端在线。
- [x] 启动时写心跳并确认目标版本，将恢复错误同步给网页。
- [x] 更新使用说明，运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check`；独立审阅失败恢复和并发边界。（全套验证已通过；macOS 原生安装/签名仍需 macOS runner 或实机验证。）
