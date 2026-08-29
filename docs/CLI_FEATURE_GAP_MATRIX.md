# CLI 差异化能力与接入规划

更新时间：2026-08-27

本文件基于当前 AnytimeVibe 适配器和协议实现整理。表中的“已接入”指代码已经有稳定路径；“可模拟”指可以用产品层行为近似，但不应对用户宣称是引擎原生能力；“未接入”指当前没有协议或适配器支持。

## 1. 当前能力矩阵

| 能力 | Codex | Claude Code | Grok Build | Cursor Agent | Antigravity |
| --- | --- | --- | --- | --- | --- |
| 创建/继续会话 | 已接入：app-server `thread/start`、`turn/start`、resume | 已接入：`-p`、`--resume` | 已接入：`-p`、`--resume` | 已接入：print、`--resume` | 已接入：print、`--conversation` |
| 当前回合追加方向（steering） | **原生已接入**：`turn/steer`，不创建新回合 | 未接入原生 API；只能停止后 resume 或排队 | 未接入原生 API；只能停止后 resume 或排队 | 未接入原生 API；当前仅有 plan/question 交互 | 未发现等价 RPC；只能停止后重新运行 |
| 等待队列 | 已接入：每线程持久化 FIFO | 同一产品队列，CLI 本身无感知 | 同一产品队列，CLI 本身无感知 | 同一产品队列，CLI 本身无感知 | 同一产品队列，CLI 本身无感知 |
| 队列插队/优先级 | **未接入**：`enqueueTurnStart` 只 `push` 到尾部 | 同左 | 同左 | 同左 | 同左 |
| 计划/目标模式 | 当前没有独立的 `plan/goal/collaboration` 协议字段；权限和 prompt 可近似 | 当前只传 `--permission-mode`，没有产品级目标模式 | 当前只传权限和 reasoning effort | 有原生计划工具并已转换为 Web 审批卡 | 有显式 `--mode plan`，当前映射到 `ask-for-approval` |
| 命令/文件审批 | 原生 server request，支持 command/file/permission/input/elicitation | headless 无可靠交互卡，主要靠 `acceptEdits`/allowlist | headless 主要靠 `--always-approve` 或工具 allowlist；ACP 可增强 | plan/question 已接入；普通工具审批能力有限 | headless Ask 不能停留在 TTY，主要靠 mode 参数 |
| 中途停止 | 原生 `turn/interrupt` | kill 进程树 | kill 进程树 | kill 进程树，另有结果后强制退出 | kill 进程树 |
| 中断后恢复 | app-server thread 可继续 | `--resume`，失效时自动去掉 resume 重跑 | `--resume`，依赖 session 文件 | `--resume`，无输出时自动去掉 resume 重跑 | `--conversation`，trajectory 无效时新开 |
| 流式结构化事件 | 丰富的 item delta、tool、审批、usage | stream-json，工具事件有限 | streaming-json，事件形态依版本变化 | stream-json + partial，含 plan/question | stream-json，工具状态解析有限 |
| Diff | Codex diff 事件/线程读取 | 回合结束后从工作区生成 | 回合结束后从工作区生成 | 回合结束后从工作区生成 | 回合结束后从工作区生成 |
| Token/context | 当前回合 usage 可计算时显示；累计-only 不计算百分比 | 依赖 usage block 和模型目录 | 依赖 usage block 和模型目录 | 依赖 usage/metrics 和模型目录 | 依赖 usage/metrics，窗口可能未知 |
| 原生任务列表/历史 | `thread/list`、`thread/read` | 主要依赖本地 session 文件导入 | `grok sessions` + 本地索引 | 本地 chat 文件导入 | brain/conversation 文件导入 |
| 原生终端接力 | `codex resume`，需释放 app-server writer | `claude --resume` | `grok --resume` | `agent --resume` | `agy --conversation` |

### Pi Coding Agent 补充

Pi 通过 `pi --mode rpc --approve` 接入，使用 `~/.pi/agent/sessions` JSONL 会话文件和 `--session <id>` 恢复。RPC usage 可用于显示已消耗 token；Pi 当前没有可依赖的原生上下文窗口字段，因此窗口占用百分比保持隐藏。Pi 暂无与 Codex `turn/steer` 等价的原生 steering，产品层应使用等待队列或插队运行语义。

## 2. 用户提到的三类能力

### 2.1 GPT/Codex 的目标引导（steering）

普通 `turn.steer` 仍保留 Codex 原生“向当前回合追加方向”的语义。队列中的“插队运行”是另一条产品路径：先中断当前回合，执行选中的队列项，再在同一线程发送恢复提示继续原任务；它不冒充同一个原生 turn，也不保证恢复隐式模型状态。

建议产品定义三个明确的动作：

| 产品动作 | 语义 | 可用引擎 |
| --- | --- | --- |
| 目标引导 | 当前回合继续运行，追加一条高优先级指令 | Codex 原生；其他引擎暂不宣称支持 |
| 插队运行 | 中断当前回合，先执行队列项，再恢复原任务 | Codex（同线程恢复）；其他引擎暂不宣称支持 |
| 立即执行 | 停止当前回合，把新指令作为下一回合首条消息 | 所有引擎可实现，但会丢失未持久化的隐式状态 |
| 稍后执行 | 进入等待队列 | 所有引擎 |

Web 应在按钮上显示能力状态。对 Claude/Cursor/Grok/Antigravity，不能把“立即执行”标成 steering。

### 2.2 队列插队模式

当前队列只有 `push`、单项取消和清空，见 [`enqueueTurnStart`](H:/git/anytimevibe/apps/agent/src/main.ts:772)。插队至少有两种不同语义，必须分开设计：

- **队头插入（推荐首版）**：当前回合不受影响，新指令排到等待队列第一位。风险低，实现只需增加 `position: "front" | "back"` 或 `priority`，并持久化排序键。
- **抢占当前回合**：Codex 插队运行已采用这一语义。需要保存中断状态、部分输出和恢复阶段；对非 Codex 引擎不是原生能力，失败时容易造成重复执行或上下文丢失。

非 Codex 引擎仍建议只做队头插入，并允许用户拖动等待项排序；不要默认打断正在运行的模型。

### 2.3 计划/目标模式

“目标模式”不能直接统一成一个布尔值：

- Antigravity 有明确的 `--mode plan`，当前已经映射到 `ask-for-approval`。
- Cursor 的计划是工具调用（createPlan），当前通过审批卡暂停并等待 Web 决策。
- Codex 当前协议没有独立的产品级 plan/goal 字段；如果 CLI 版本支持类似 collaboration mode，代码尚未传递或持久化。
- Claude/Grok 当前 headless 路径没有统一的计划状态事件；用 prompt 要求“先规划”只能算提示词模拟。

建议将模式拆成 `execute`、`plan`、`review` 三个产品语义，并让每个引擎声明 `native`、`emulated` 或 `unsupported`。UI 必须展示实际能力来源，不能把 prompt 模拟和原生计划混为一谈。

## 3. 其他值得补齐的差异

### 3.1 交互式审批

Codex 的 server request 最完整；Cursor 已有计划/问题卡；Claude、Grok、Antigravity 的 headless 进程无法可靠等待手机审批，当前只能在启动参数阶段决定权限。若要统一审批体验，需要为这些引擎接入 ACP/stdio 等长期交互协议，成本明显高于继续使用 headless。

### 3.2 模型参数与能力声明

当前已有 model、reasoning effort、Cursor fast/thinking，但 `EngineCapability` 没有声明 steering、plan、审批、队列抢占等功能。建议新增能力位：

```ts
type EngineFeatureSupport = "native" | "emulated" | "unsupported";

type EngineFeatures = {
  steering: EngineFeatureSupport;
  planMode: EngineFeatureSupport;
  interactiveApproval: EngineFeatureSupport;
  resume: EngineFeatureSupport;
  contextUsage: EngineFeatureSupport;
};
```

能力从 Agent 发布，Web 据此隐藏或降级按钮；不要根据引擎名称在 Web 内硬编码推断。

### 3.3 恢复、重试和重复执行

各引擎对失效 resume 的处理不同：Cursor、Claude、Antigravity 已有不同的“去掉 resume 重试”逻辑，Grok 依赖 session 文件，Codex 依赖 app-server thread。统一层需要记录 `retryReason`、是否创建了新 session，以及重试前后 provider session ID，避免用户误以为仍在同一原生会话。

### 3.4 并发与工作区冲突

当前并发控制主要按 thread 维度；多个任务只要 threadId 不同就可能同时修改同一个 cwd。跨引擎和队头插入上线前，至少要增加 cwd 级互斥策略：拒绝、排队或明确允许并显示风险。否则“同一任务接力”和“多个任务并行写同一仓库”会互相覆盖。

### 3.5 上下文和额度

上下文窗口、累计 token、订阅额度必须继续按 session 隔离。计划模式、steering 和队头插入都会改变 token 消耗，UI 应区分：当前上下文占用、当前回合消耗、session 累计消耗、接力/重试额外消耗。窗口未知时显示不可计算提示，不应使用模型家族猜测值伪造百分比。

## 4. 实现优先级

| 优先级 | 功能 | 难度 | 建议 |
| --- | --- | --- | --- |
| P0 | Codex 插队运行与恢复状态提示 | 中-高 | 复用队列命令，串行处理中断、插队回合和恢复回合；失败时恢复队列项 |
| P0 | 队头插入，不打断当前回合 | 低-中 | 增加 `position/priority`、持久化排序、移动和取消事件 |
| P0 | 引擎能力矩阵下发 | 低 | 扩展 `EngineCapability`，由 Web 决定按钮是否可用 |
| P1 | `execute/plan/review` 产品模式 | 中 | 先支持 Antigravity/Cursor 原生能力，其他引擎标记 emulated |
| P1 | 队列拖动排序与定时执行 | 中 | 需要幂等排序版本，防止多浏览器覆盖顺序 |
| P1 | cwd 级并发策略 | 中 | 至少提供“同目录已有任务”警告和排队选项 |
| P2 | 非 Codex steering 的真实支持 | 高 | 评估 Claude/Grok ACP 或各 CLI 的长期 stdin 协议；不要用 kill+resume 冒充 |
| P2 | 跨引擎统一交互审批 | 高 | 需要 ACP/stdio 常驻会话、断线恢复和权限审计 |
| P3 | 非 Codex 引擎抢占当前回合 | 高 | 先完成各引擎中断恢复、部分输出持久化和 workspace 锁，再考虑开放 |

## 5. 建议的协议增量

建议保持现有 `turn.steer` 的 Codex 语义不变，新增通用队列命令，而不是让 `turn.start` 承担所有行为：

```ts
{
  type: "turn.queue.enqueue",
  commandId: string,
  threadId: string,
  prompt: string,
  position?: "front" | "back",
  priority?: number
}

{
  type: "turn.queue.move",
  commandId: string,
  threadId: string,
  queueCommandId: string,
  beforeQueueCommandId?: string
}
```

任务快照应增加：

- 当前 active session 和引擎能力矩阵；
- 队列排序版本、每项创建时间和来源客户端；
- 当前模式（execute/plan/review）及 `native/emulated/unsupported` 来源；
- steering、抢占、重试是否为原生能力；
- 按 session 的 context/token 和重试/接力额外消耗。

## 6. 验收重点

- Codex steering 不会产生第二个 turn，也不会重复用户消息。
- Claude/Cursor/Grok/Antigravity 的普通追加不会被误标为 steering。
- 队头插入不会打断当前回合，重启 Agent 后顺序仍保持。
- 多浏览器同时排序时不会丢失较新的队列版本。
- 计划模式明确显示原生或模拟来源，审批行为与权限模式一致。
- 同一 cwd 的并行任务会得到明确策略，而不是静默互相覆盖文件。
- session 切换、重试和 steering 后，context/token 显示仍绑定正确 session。
