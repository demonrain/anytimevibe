import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";
import * as adapter from "../codex-adapter";
import { TaskStore } from "./task-store";
import { CodexThreadRegistry } from "./codex-threads";
import { windowTranscriptMessages } from "@anytimevibe/protocol";

// Run the actual event/sync entry points without starting Electron or a model turn.
const source = createSourceFile("main.ts", readFileSync(path.resolve("apps/agent/src/main.ts"), "utf8"), ScriptTarget.Latest, true);
const names = [
  "handleCodexMessage", "handleCodexMessageBody", "touchAgentTask", "extractCodexThreadList", "extractCodexNextCursor",
  "threadMatchesQuery", "listCodexThreadsForSync", "mapPool", "hideCodexSubagentTask", "cleanupCodexSubagentTasks",
  "refreshLocalTasks", "publishThread", "publishStoredTaskSnapshot", "hasActiveCodexTurn", "hasRunningCodexTurn", "busyCodingEngines", "resolveRelayTask", "recoverAfterCodexAppServerExit"
];
const declarations = source.statements.filter((node) => isFunctionDeclaration(node) && names.includes(node.name?.text || ""));
const script = new Script(`${transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
}).outputText}\n({ handleCodexMessage, listCodexThreadsForSync, refreshLocalTasks, publishThread, publishStoredTaskSnapshot, hasActiveCodexTurn, hasRunningCodexTurn, busyCodingEngines, resolveRelayTask, recoverAfterCodexAppServerExit });`);

function fixture() {
  const events: Array<Record<string, any>> = [];
  const deltas: Array<{ threadId: string; text: string }> = [];
  const threads = new Map<string, Record<string, any>>([
    ["parent", { id: "parent", source: "appServer", parentThreadId: null, name: "主任务", updatedAt: 1, turns: [] }],
    ["child", { id: "child", source: { subAgent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } }, parentThreadId: "parent", updatedAt: 3, turns: [] }]
  ]);
  const publicState = { tasks: [{ threadId: "parent", title: "主任务", cwd: "", status: "active", updatedAt: 1, engine: "codex" }], activities: [] };
  const context = {
    ...adapter,
    crypto: globalThis.crypto,
    publicState, taskStore: new TaskStore(),
    activeTurnByThread: new Map([["parent", "parent-turn"]]),
    lastProgressAtByThread: new Map(), turnUsageByThread: new Map(), pendingUsageByThread: new Map(),
    usageFlushTimers: new Map(), turnStartingByThread: new Set(), pendingCodexSteeringByThread: new Map(),
    activityItemsByThread: new Map(), activityOutputBuffers: new Map(), activityFlushTimers: new Map(),
    remoteDeltaBuffers: new Map(),
    pendingRequestTypes: new Map(), pendingAnswerMeta: new Map(),
    SEARCH_LIST_LIMIT: 100, SEARCH_MAX_PAGES: 20,
    normalizeContextUsage: () => undefined, normalizeTurnContextUsage: () => undefined, normalizeSessionContextUsage: () => undefined,
    noteThreadProgress: () => {}, clearEngineDiffChunks: () => {}, captureTurnDiffBaseline: async () => {},
    preferTaskCwd: (...values: string[]) => values.find(Boolean) || "",
    codexRunInfo: async () => ({ engine: "codex" }),
    persistAndPublishRunInfo: async (threadId: string) => { events.push({ type: "turn.info", threadId }); },
    appendLocalActivity: () => {}, appendLocalActivityStage: () => {}, activityItemLabel: () => null,
    queueRemoteDelta: (threadId: string, _itemId: string, text: string) => { deltas.push({ threadId, text }); },
    finishLocalActivity: () => {}, flushRemoteDeltas: async () => {}, publishTaskDiff: async () => {},
    publishThread: async (threadId: string) => { events.push({ type: "thread.snapshot", threadId }); },
    scheduleDrainTurnQueue: () => {}, maybeReloadCodexAppServerWhenIdle: async () => {}, handleError: () => {},
    updateState: (patch: object) => { Object.assign(publicState, patch); },
    publish: async (event: Record<string, any>) => { events.push(event); },
    logInfo: () => {}, logWarn: () => {},
    acceptFullAccessApproval: () => false,
    socket: { readyState: 1 }, WebSocket: { OPEN: 1 },
    hiddenCodexSubagentIds: new Set(),
    codexThreads: new CodexThreadRegistry(),
    pendingCodexRequestOwners: new Map(),
    activeNativeCodexTurns: new Map<string, string>(),
    codexMessageChains: new Map<string, Promise<void>>(),
    codexMessageGeneration: 0,
    pendingCursorApprovalsByThread: new Map(), turnQueueByThread: new Map(),
    isHeadlessThreadActive: () => false, resolveActivityEngine: () => "codex",
    subagentCleanupInFlight: null,
    DEFAULT_SYNC_LIMIT: 10, ensureCodex: async () => {},
    reconcileOrphanedActiveTasks: async () => {}, importLocalCliSessions: async () => ({}), pruneImportedCliSessions: async () => {},
    workspaceAllowRoots: () => [], resolveAbsoluteCwd: (cwd: string) => cwd,
    isThreadDeleted: () => false,
    isInProgressStoredStatus: (status: string) => status === "active",
    sanitizeTranscriptMessages: (messages: unknown[]) => messages, windowTranscriptMessages,
    queuedTurnsForThread: () => [],
    codex: { request: async (method: string, params: Record<string, any>): Promise<any> => {
      if (method === "thread/read") return { thread: threads.get(params.threadId) };
      if (method === "thread/list") return { data: [...threads.values()].filter((thread) =>
        params.sourceKinds?.length ? !!thread.parentThreadId : true), nextCursor: null };
      throw new Error(`Unexpected RPC ${method}`);
    } }
  };
  const functions = script.runInNewContext(context) as {
    handleCodexMessage(message: Record<string, any>): Promise<void>;
    listCodexThreadsForSync(options: { limit: number; query?: string }): Promise<Array<Record<string, any>>>;
    refreshLocalTasks(limit?: number): Promise<void>;
    publishThread(threadId: string): Promise<void>;
    publishStoredTaskSnapshot(threadId: string): Promise<void>;
    hasActiveCodexTurn(): boolean;
    hasRunningCodexTurn(): boolean;
    busyCodingEngines(): string[];
    resolveRelayTask(threadId: string): Promise<unknown>;
    recoverAfterCodexAppServerExit(detail: string): Promise<void>;
  };
  return { ...functions, context, events, deltas, threads, publicState };
}

describe("Codex subagent task visibility", () => {
  it("keeps child turns and streamed output out of the task list while the parent continues", async () => {
    const f = fixture();
    await f.handleCodexMessage({ method: "thread/started", params: { thread: f.threads.get("child") } });
    await f.handleCodexMessage({ method: "turn/started", params: { threadId: "child", turn: { id: "child-turn" } } });
    await f.handleCodexMessage({ method: "item/agentMessage/delta", params: { threadId: "child", itemId: "reply", delta: "子任务输出" } });
    await f.handleCodexMessage({ method: "turn/completed", params: { threadId: "child", turn: { id: "child-turn", status: "completed" } } });

    expect(f.publicState.tasks.map((task) => task.threadId)).toEqual(["parent"]);
    expect(f.context.activeTurnByThread.get("parent")).toBe("parent-turn");
    expect(f.events.filter((event) => event.threadId === "child" && event.type !== "thread.deleted")).toEqual([]);
    expect(f.deltas).toEqual([]);
  });

  it("omits child sessions from history without hiding a normal unnamed or forked session", async () => {
    const f = fixture();
    f.threads.set("unnamed", { id: "unnamed", source: "cli", name: null, preview: "", updatedAt: 4 });
    f.threads.set("fork", { id: "fork", source: "vscode", forkedFromId: "parent", parentThreadId: null, updatedAt: 2 });
    const rows = await f.listCodexThreadsForSync({ limit: 10 });
    expect(rows.map((row) => row.id)).toEqual(["unnamed", "fork", "parent"]);
  });

  it("routes a nested child's approval and its resolution to the root task without changing native ids", async () => {
    const f = fixture();
    f.threads.set("grandchild", { id: "grandchild", parentThreadId: "child", source: { subAgent: "review" } });
    await f.handleCodexMessage({ id: 42, method: "item/commandExecution/requestApproval", params: {
      threadId: "grandchild", turnId: "native-child-turn", itemId: "cmd", command: "git status"
    } });
    await f.handleCodexMessage({ method: "serverRequest/resolved", params: { threadId: "grandchild", requestId: 42 } });
    expect(f.events.filter((event) => event.type === "approval.requested")).toEqual([
      expect.objectContaining({ threadId: "parent", requestId: 42, turnId: "native-child-turn", itemId: "cmd" })
    ]);
    expect(f.events.filter((event) => event.type === "request.resolved")).toEqual([
      expect.objectContaining({ threadId: "parent", requestId: 42 })
    ]);
    expect(f.context.activeTurnByThread.get("parent")).toBe("parent-turn");
  });

  it("cleans already-synced child tasks on local refresh even when the default native list excludes them", async () => {
    const f = fixture();
    f.publicState.tasks.push({ threadId: "child", title: "未命名任务", cwd: "", status: "completed", updatedAt: 3, engine: "codex" });
    const request = f.context.codex.request;
    f.context.codex.request = async (method, params) => {
      if (method === "thread/list" && !params.sourceKinds?.length) return { data: [f.threads.get("parent")], nextCursor: null };
      return request(method, params);
    };
    await f.refreshLocalTasks();
    expect(f.publicState.tasks.map((task) => task.threadId)).toEqual(["parent"]);
    expect(f.events.filter((event) => event.type === "thread.deleted").map((event) => event.threadId)).toEqual(["child"]);
    expect(f.threads.has("child")).toBe(true);
  });

  it("never republishes a known child from the stored snapshot fallback", async () => {
    const f = fixture();
    await f.context.taskStore.upsert({ threadId: "child", engine: "codex", providerSessionId: "child", cwd: "", title: "未命名任务", status: "completed", createdAt: 1, updatedAt: 3, messages: [] });
    f.context.codexThreads.observeThread(f.threads.get("child"));
    await f.publishStoredTaskSnapshot("child");
    expect(f.events.filter((event) => event.type === "thread.snapshot")).toEqual([]);
    expect(f.publicState.tasks.map((task) => task.threadId)).toEqual(["parent"]);
    expect(f.context.taskStore.get("child")).toBeDefined();
  });

  it("fills the recent task window across pages occupied by subagents", async () => {
    const f = fixture();
    const cursors: unknown[] = [];
    f.context.codex.request = async (method, params) => {
      if (method !== "thread/list") throw new Error(`Unexpected RPC ${method}`);
      cursors.push(params.cursor);
      return params.cursor
        ? { data: [f.threads.get("parent"), { id: "older", source: "cli", updatedAt: 0 }], nextCursor: null }
        : { data: [f.threads.get("child")], nextCursor: "next" };
    };
    const rows = await f.listCodexThreadsForSync({ limit: 2 });
    expect(rows.map((row) => row.id)).toEqual(["parent", "older"]);
    expect(cursors).toEqual([undefined, "next"]);
  });

  it("still treats an invisible background child as busy for engine upgrade and reload", async () => {
    const f = fixture();
    f.context.activeTurnByThread.clear();
    await f.handleCodexMessage({ method: "turn/started", params: { threadId: "child", turn: { id: "child-turn" } } });
    expect(f.hasActiveCodexTurn()).toBe(true);
    expect(f.hasRunningCodexTurn()).toBe(true);
    expect(f.busyCodingEngines()).toEqual(["codex"]);
    await f.handleCodexMessage({ method: "turn/completed", params: { threadId: "child", turn: { id: "child-turn", status: "completed" } } });
    expect(f.hasActiveCodexTurn()).toBe(false);
    expect(f.busyCodingEngines()).toEqual([]);
  });

  it("publishes cleanup once online after a child was detected offline", async () => {
    const f = fixture();
    f.context.socket.readyState = 0;
    await f.handleCodexMessage({ method: "thread/started", params: { thread: f.threads.get("child") } });
    expect(f.events).toEqual([]);
    f.context.socket.readyState = 1;
    await f.refreshLocalTasks();
    await f.refreshLocalTasks();
    expect(f.events.filter((event) => event.type === "thread.deleted").map((event) => event.threadId)).toEqual(["child"]);
  });

  it("rejects a stale desktop handoff to a native child instead of adding it back", async () => {
    const f = fixture();
    await expect(f.resolveRelayTask("child")).rejects.toThrow();
    expect(f.publicState.tasks.map((task) => task.threadId)).toEqual(["parent"]);
    expect(f.threads.has("child")).toBe(true);
  });

  it("preserves start/completion order while a spawn identifies a child during a slow metadata read", async () => {
    const f = fixture();
    let finishRead!: (value: { thread: Record<string, any> }) => void;
    let readEntered!: () => void;
    const entered = new Promise<void>((resolve) => { readEntered = resolve; });
    const read = new Promise<{ thread: Record<string, any> }>((resolve) => { finishRead = resolve; });
    const request = f.context.codex.request;
    f.context.codex.request = async (method, params) => {
      if (method === "thread/read" && params.threadId === "child") { readEntered(); return read; }
      return request(method, params);
    };
    const started = f.handleCodexMessage({ method: "turn/started", params: { threadId: "child", turn: { id: "child-turn" } } });
    await entered;
    f.context.activeTurnByThread.clear();
    expect(f.hasRunningCodexTurn()).toBe(true);
    f.context.codexThreads.observeItem({ type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "parent", receiverThreadIds: ["child"] }, "parent");
    const completed = f.handleCodexMessage({ method: "turn/completed", params: { threadId: "child", turn: { id: "child-turn", status: "completed" } } });
    // In the old handler completion can overtake start while its read is pending.
    await Promise.resolve();
    finishRead({ thread: { id: "child", source: "unknown" } });
    await Promise.all([started, completed]);
    expect([...f.context.activeNativeCodexTurns]).toEqual([]);
    expect(f.hasRunningCodexTurn()).toBe(false);
  });

  it.each(["child", "parent"])("discards a pending %s notification after its app-server exits", async (threadId) => {
    const f = fixture();
    f.context.activeTurnByThread.clear();
    if (threadId === "child") f.context.codexThreads.observeThread({ id: "child", source: { subAgent: "review" } });
    let readEntered!: () => void;
    let rejectRead!: (error: Error) => void;
    const entered = new Promise<void>((resolve) => { readEntered = resolve; });
    const read = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
    f.context.codex.request = async () => { readEntered(); return read; };
    const started = f.handleCodexMessage({ method: "turn/started", params: { threadId, turn: { id: "native-turn" } } });
    await entered;
    Object.assign(f.context, { codex: null });
    await f.recoverAfterCodexAppServerExit("Codex app-server exited");
    rejectRead(new Error("Codex app-server exited"));
    await started;
    expect(f.hasRunningCodexTurn()).toBe(false);
    expect(f.events.filter((event) => event.type !== "thread.deleted")).toEqual([]);
  });
});
