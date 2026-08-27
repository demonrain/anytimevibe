# 跨引擎任务接力规划

更新时间：2026-08-27

## 1. 结论

AnytimeVibe 可以实现跨引擎任务接力，但目标应定义为：

> 同一个产品任务切换执行引擎，使用结构化 handoff 上下文创建或恢复目标引擎会话。

这不是 Codex、Claude、Cursor、Grok 和 Antigravity 原生会话之间的无缝 resume。各引擎的会话 ID、transcript 格式、权限模型和工具协议都不兼容，不能把一个 provider session id 直接交给另一个引擎。

推荐保留产品级 `threadId`，并在任务下维护多个引擎 session。切换时保留旧 session，目标引擎使用新的 provider session 或其已有 session，从而支持切回、审计和失败回退。

## 2. 当前实现基线

当前任务模型仍然是单引擎绑定：

```ts
StoredTask {
  threadId: string;
  engine: CliEngine;
  providerSessionId: string;
  messages: TranscriptMessage[];
  contextUsage?: ContextUsage;
}
```

现有能力：

- 创建任务时选择 Codex、Claude、Grok、Cursor 或 Antigravity。
- 同一引擎内继续任务和恢复原生 session。
- Agent 统一处理流式输出、停止、权限映射、diff 和本地 CLI 接力。
- Web 使用共享协议模块计算 token/context 显示。

现有限制：

- `turn.start` 没有目标引擎字段。
- `StoredTask` 只有一个 `engine` 和一个 `providerSessionId`。
- Agent 根据当前任务的 `stored.engine` 执行 turn。
- 原生 handoff 根据任务当前引擎拼接对应 CLI 命令。
- transcript 是统一文本消息，但没有 handoff 边界、摘要版本或来源引擎元数据。

因此，直接把 `stored.engine` 改成另一个值是不安全的：旧引擎的 provider session id 可能被错误地传给新引擎的 `--resume`。

## 3. 产品语义

### 3.1 用户看到的对象

用户始终看到一条任务流：目标、消息、diff、状态和接力记录都归属于同一个产品任务。

### 3.2 系统内部的对象

一个产品任务可以拥有多个 provider session：

```text
Task(threadId)
├── Session(codex, providerSessionId=...)
├── Session(claude, providerSessionId=...)
├── Session(cursor, providerSessionId=...)
└── activeSession -> 当前正在执行的 session
```

每个 provider session 独立保存：

- provider session id；
- 引擎、模型和推理参数；
- 权限模式和工作目录；
- 最近一次可靠的 context usage；
- 最近一次状态和错误；
- 创建、切换和最后使用时间。

## 4. 推荐数据模型

建议新增协议类型，旧字段保留一段时间用于兼容旧 Agent：

```ts
type EngineSession = {
  engine: CliEngine;
  providerSessionId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  thinking?: boolean;
  permissionMode?: PermissionMode;
  cwd: string;
  status: "new" | "active" | "completed" | "failed" | "interrupted";
  contextUsage?: ContextUsage;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
};

type TaskHandoff = {
  id: string;
  fromEngine: CliEngine;
  toEngine: CliEngine;
  sourceSessionId?: string;
  targetSessionId?: string;
  summary: string;
  recentMessageCount: number;
  diffIncluded: boolean;
  createdAt: number;
};
```

`StoredTask` 建议演进为：

```ts
type StoredTask = {
  threadId: string;
  activeEngine: CliEngine;
  activeSessionKey: string;
  sessions: Record<string, EngineSession>;
  handoffs: TaskHandoff[];
  messages: TranscriptMessage[];
};
```

旧的 `engine`、`providerSessionId`、`contextUsage` 字段可以继续发布为当前活动 session 的派生字段，避免旧 Web/Agent 立即失效。

## 5. 协议设计

新增命令：

```ts
{
  type: "thread.engine.switch",
  commandId: string,
  threadId: string,
  targetEngine: CliEngine,
  model?: string,
  reasoningEffort?: ReasoningEffort,
  thinking?: boolean,
  permissionMode?: PermissionMode,
  handoffMode?: "summary" | "summary-recent" | "full"
}
```

建议新增事件：

- `thread.engine.switch.started`
- `thread.engine.switch.completed`
- `thread.engine.switch.failed`
- `thread.handoff.created`

事件必须携带 `threadId`、源引擎、目标引擎和 handoff id。旧客户端不识别新事件时，Agent 仍应发布一个兼容的 `thread.snapshot`。

`turn.start` 暂时不建议直接增加 `cliEngine` 并允许任意切换。引擎切换需要停止、flush、生成 handoff 和建立 session，是一个独立的事务；普通 turn 只使用当前 active session。

## 6. 接力流程

```text
用户选择目标引擎
        |
        v
校验任务没有活动 turn / 或先中断当前 turn
        |
        v
flush delta、usage、diff、队列和本地状态
        |
        v
生成 handoff 摘要 + 最近消息 + diff 摘要
        |
        v
创建或恢复目标引擎 session
        |
        v
注入 handoff，启动目标引擎首个 turn
        |
        v
更新 active session，发布切换完成事件
```

切换必须具备：

- 每个任务单写锁或 generation token，防止两个引擎同时成为 active。
- 当前 turn 未退出时禁止创建目标 session。
- 中断超时后进入 `switch.failed`，不能假设旧进程已经结束。
- 目标引擎创建失败时恢复旧引擎为 active。
- 所有切换命令使用 `commandId` 幂等处理。

## 7. Handoff 内容策略

不建议把完整 transcript 无限制地塞进目标引擎 prompt。推荐三层内容：

### 必须包含

- 原始任务目标；
- 当前工作目录；
- 已完成事项；
- 未完成事项和阻塞点；
- 已修改文件；
- 最近一次测试结果；
- 权限模式和不可违反的约束。

### 默认包含

- 最近 8～20 轮用户/助手消息；
- 当前 git diff/stat；
- 最近一次错误和审批结果。

### 按需包含

- 更早的 transcript 页面；
- 大型 diff 的文件级摘要；
- 目标引擎需要的特定工具说明。

第一版建议使用本地确定性摘要，避免切换本身产生额外 token 费用。后续可以增加可选的旧引擎摘要，但必须标记摘要来源，并在失败时回退到本地摘要。

Handoff 应作为产品 transcript 中的特殊消息或独立元数据保存，不能伪装成普通用户消息。这样可以在 UI 中明确显示“已从 Claude 切换到 Codex”。

## 8. Token 与上下文统计规则

跨引擎后必须把 usage 按 session 隔离：

- 上下文窗口占用只属于当前 provider session。
- 切换引擎后，旧引擎的 context gauge 不得继续显示在新引擎上。
- 产品任务可以额外显示所有 session 的累计消耗，但不能把它当成当前上下文百分比。
- 没有当前回合输入数据时，不显示上下文百分比，显示“暂时无法计算”。
- 只有累计 token、没有当前 turn token 的 payload，只能作为累计用量记录。
- 不同引擎、不同模型的 context window 不允许合并成一个百分比。

建议后续把 `ContextUsage` 明确拆成：

```ts
type ContextUsage = {
  inputTokens?: number;       // 当前回合/当前上下文
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  contextWindow?: number;
  totalTokens?: number;       // 仅表示当前上下文占用
  sessionTotalTokens?: number; // provider session 累计，仅用于消费显示
  usageConfidence?: "reported" | "estimated" | "unavailable";
};
```

`usageConfidence` 可以让 Web 不必通过字段存在与否猜测能否计算。

## 9. Web 交互

建议在会话头部提供当前引擎下拉菜单或图标按钮：

- 当前引擎和模型始终可见；
- turn 执行期间禁用切换按钮；
- 切换前显示目标引擎、模型、权限模式；
- 明确提示“将创建目标引擎的新会话，旧会话仍可切回”；
- 切换中显示阶段：停止旧引擎、整理上下文、启动新引擎；
- 失败时提供“恢复旧引擎”和“重试目标引擎”；
- transcript 中插入可折叠的 handoff 边界；
- usage chip 只显示当前 active session 的上下文。

不要在 UI 上宣称“同一个原生会话已续跑”，应显示“任务已切换到 Codex/Claude”等产品级语义。

## 10. 兼容与迁移

### 阶段一：协议兼容

- 新增 `sessions`、`activeEngine`、handoff 事件 schema。
- 旧字段继续发布当前活动 session 的值。
- 旧 Agent 收到未知命令时安全拒绝，不改变当前任务。

### 阶段二：存储迁移

- 读取旧任务时，将旧 `engine/providerSessionId` 转换成一个 session。
- 不删除旧字段，写入时同时更新新旧结构。
- 迁移失败时保留原 JSON，不覆盖原任务。

### 阶段三：单向接力

- 先支持 Codex -> Claude、Claude -> Codex。
- 只支持 `summary-recent`，不支持完整历史注入。
- 目标 session 创建失败时恢复源 session。

### 阶段四：全引擎和切回

- 加入 Cursor、Grok、Antigravity。
- 允许在已有目标 session 上恢复。
- 增加每个 session 的 usage、错误和 handoff 历史。

## 11. 测试计划

协议层：

- 新命令和事件 schema 校验；
- 旧任务迁移为单 session；
- 多 session 序列化和恢复；
- handoff 内容大小和敏感字段过滤。

Agent 层：

- 活动 turn 时拒绝切换；
- 中断后正确 flush；
- 目标 session 创建失败能恢复旧 session；
- provider session id 不跨引擎复用；
- 切换后旧 session 仍可恢复；
- 重复 `commandId` 不重复启动 CLI。

Usage 层：

- Codex `last_token_usage` 优先于 `total_token_usage`；
- 只有累计 usage 时返回不可计算状态；
- 切换 session 后 context usage 不串用；
- 稀疏事件不会覆盖可靠的窗口和当前 usage；
- snapshot 晚到不会回滚 Web 显示。

Web 层：

- 切换按钮在活动 turn 时禁用；
- 切换中、成功、失败和回退状态正确显示；
- 不可计算上下文显示友好提示；
- handoff 边界不会重复用户消息；
- 刷新页面后 active session 和历史边界仍正确。

## 12. 分阶段实施计划

### P0：数据与统计基础

- 完成 `ContextUsage` 的 current/session 语义拆分。
- 保持不可计算时不显示伪造百分比。
- 增加真实 CLI payload fixture 和回归测试。

### P1：多 session 存储

- 扩展 `StoredTask` 和 snapshot schema。
- 完成旧数据迁移和兼容字段发布。
- Agent 内部所有 resume/handoff 路径改为按引擎查找 session。

### P2：单向接力 MVP

- 新增 `thread.engine.switch`。
- 实现停止、flush、摘要、创建目标 session、失败回退。
- 首先支持 Codex 与 Claude。
- Web 增加切换入口和状态显示。

### P3：增强上下文与切回

- 支持目标 session 恢复和反向切换。
- 增加 diff、测试结果和审批状态的结构化 handoff。
- 展示按 session 的上下文和累计 token。

### P4：全引擎和稳定性

- 接入 Cursor、Grok、Antigravity。
- 增加断线恢复、并发 fencing、长摘要压缩和诊断日志。
- 完成真实 CLI 版本矩阵验证。

## 13. 验收标准

第一版跨引擎接力只有满足以下条件才算完成：

- 同一个 `threadId` 可以从一个引擎切换到另一个引擎。
- 目标引擎不会收到源引擎的 provider session id。
- 源引擎 session 仍可保留并切回。
- 目标引擎能获得目标、进度、文件改动和最近对话。
- 活动 turn 不会与切换并发运行。
- 切换失败不会丢失原任务状态。
- 当前上下文无法计算时 UI 不显示伪造的 token 百分比。
- 旧 Agent/Web 客户端仍能查看和继续旧任务。

