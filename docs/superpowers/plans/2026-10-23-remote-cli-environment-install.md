# 远程 CLI 环境安装 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Web 端通过配对主机通道远程静默安装缺失的编码引擎 CLI，并在安装后验证版本、同步模型；Node.js 仍作为独立前置条件。

**Architecture:** 扩展现有 `EngineMaintenance` 操作协议，增加 `install` 动作；客户端用固定的 npm 包或官方安装入口构造安装步骤，沿用进程树清理、代理、脱敏、维护锁和状态广播；Web 在同一维护窗口按引擎状态显示远程安装或升级按钮。

**Tech Stack:** TypeScript, Zod protocol schemas, Electron agent, React/Vite web, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-23-remote-cli-environment-install-design.md`

## Global Constraints

- 浏览器只能发送 `host.engine.install` 与枚举引擎，不能发送命令、URL、脚本或安装路径。
- 不自动提权，不卸载旧 CLI，不自动替换 Node.js。
- Windows/macOS 支持；Linux 对不支持的安装方式明确失败。
- npm 安装使用现有代理和镜像回退；输出必须脱敏并限制长度。
- 安装完成必须重新探测真实二进制和版本，并刷新模型目录。
- 修改 `apps/agent/**` 必须升级 agent、protocol/web 产品版本并发布客户端 tag。

---

### Task 1: Extend Protocol Contracts

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/protocol.test.ts`

**Interfaces:**
- Produce `ClientCommand` variant `host.engine.install`.
- Extend `EngineOperation.action` with `install` and `phase` with `installing`.

- [ ] Write tests that parse a valid install command and reject an extra command field.
- [ ] Run `pnpm vitest run packages/protocol/src/protocol.test.ts` and verify the new assertions fail before implementation.
- [ ] Add the Zod schema changes and update any exhaustive action/phase typing errors.
- [ ] Run the focused protocol test again and confirm it passes.

### Task 2: Add Install Semantics to EngineMaintenance

**Files:**
- Modify: `apps/agent/src/cli/engine-maintenance.ts`
- Test: `apps/agent/src/cli/engine-maintenance.test.ts`
- Test: `apps/agent/src/cli/engine-maintenance-queue.test.ts`

**Interfaces:**
- Add `install(engine, onOutput)` to `EngineMaintenanceDependencies`.
- Accept `host.engine.install`; allow missing engines for install, reject installed engines only when an active maintenance operation exists.

- [ ] Add failing tests for missing-engine install, busy-engine rejection, install failure cleanup, and post-install version/model sync.
- [ ] Run the focused tests and verify expected failures.
- [ ] Implement the smallest state-machine changes: `action: install`, `phase: installing`, no installed precondition, install callback, then detect/sync/complete.
- [ ] Run focused maintenance tests and confirm they pass.
- [ ] Update every production/test dependency fixture to provide `install`.

### Task 3: Build Safe Cross-Platform Install Steps

**Files:**
- Modify: `apps/agent/src/cli/engine-upgrade.ts`
- Create: `apps/agent/src/cli/engine-install.ts`
- Test: `apps/agent/src/cli/engine-upgrade.test.ts`
- Test: `apps/agent/src/cli/engine-install.test.ts`

**Interfaces:**
- Produce `buildEngineInstallSteps(target): EngineUpgradeStep[]` with fixed package names and vendor URLs.
- Produce platform/Node validation helpers used by `main.ts`.

- [ ] Add failing tests for Codex/Claude/Pi npm specs, Cursor/Grok/Antigravity fixed official installers, unsupported Linux, and missing npm.
- [ ] Run the focused install tests and verify failures are due to missing implementation.
- [ ] Implement fixed step generation without accepting user-provided shell text or URLs.
- [ ] Reuse existing Windows Claude repair and Codex npm shim repair hooks where applicable.
- [ ] Run focused install tests and confirm all pass.

### Task 4: Wire Agent Command and Installer Execution

**Files:**
- Modify: `apps/agent/src/main.ts`
- Modify: `apps/agent/src/cli/engine-maintenance.ts`
- Test: `apps/agent/src/cli/engine-maintenance-codex.test.ts`
- Test: `apps/agent/src/cli/engine-install.test.ts`

**Interfaces:**
- Handle `host.engine.install` in `handleCommandImpl`.
- Configure `EngineMaintenance.install` using real detection, proxy env, `execFileWithTreeKill`, output redaction, post-install reload where needed, and model sync.

- [ ] Add a failing integration-style test proving the command reaches install and publishes failed/completed operation states.
- [ ] Run it and verify failure before wiring.
- [ ] Wire install into the existing maintenance instance; use existing task-busy and client-operation protections.
- [ ] Ensure install never opens a visible console and does not use arbitrary input.
- [ ] Run focused agent tests and confirm pass.

### Task 5: Add Web Install Controls

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/i18n/locales.ts`
- Test: `apps/web/src/engine-maintenance-ui.test.ts`

**Interfaces:**
- Extend request action type to `install`.
- Send `{ type: "host.engine.install", commandId, cliEngine }` for missing engines.

- [ ] Add failing UI tests for missing engine install button, command payload, busy state and failed detail.
- [ ] Run focused Web tests and verify failures.
- [ ] Implement action labels, phase labels, button gating and bilingual strings.
- [ ] Run focused Web tests and confirm pass.

### Task 6: Documentation and Release Metadata

**Files:**
- Modify: `docs/USER_GUIDE.md`
- Modify: `packages/protocol/src/index.ts` version
- Modify: `apps/agent/package.json` version
- Modify: `apps/web/package.json` version

- [ ] Document remote install prerequisites, supported engines/platforms, Node.js prerequisite, and failure behavior.
- [ ] Bump all product/client versions from `0.5.33` to `0.5.34`.
- [ ] Run full test suite, typechecks, build and `git diff --check`.
- [ ] Commit, push `main`, create/push `v0.5.34`, and verify the desktop release workflow.

## Self-Review

- Protocol, agent execution, UI, tests, docs and release metadata are covered by Tasks 1-6.
- No browser-controlled command or URL is introduced.
- Node.js is explicitly a prerequisite and is not silently replaced.
- Every new install path is fixed and testable; unsupported platforms fail visibly.
