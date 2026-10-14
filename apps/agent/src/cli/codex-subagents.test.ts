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
  "threadMatchesQuery", "listCodexThreadsForSync", "mapPool", "hideCodexSubagentTask", "cleanupCodexSubagentTasks", "pruneJunkCliImports", "evictStaleNativeCliImports", "isProtectedFromCliImportCleanup",
  "refreshLocalTasks", "refreshLocalTasksImpl", "reconcileOrphanedActiveTasks", "isAnytimeVibeManagedTask", "isHiddenCodexSubagentTask", "retainExternalHandoff", "releaseExternalHandoff", "reserveClientOperation", "withClientOperation", "publishThread", "publishStoredTaskSnapshot", "hasActiveCodexTurn", "hasRunningCodexTurn", "busyCodingEngines", "resolveRelayTask", "recoverAfterCodexAppServerExit"
];
const declarations = source.statements.filter((node) => isFunctionDeclaration(node) && names.includes(node.name?.text || ""));
const script = new Script(`${transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
}).outputText}\n({ handleCodexMessage, listCodexThreadsForSync, refreshLocalTasks, publishThread, publishStoredTaskSnapshot, hideCodexSubagentTask, pruneJunkCliImports, evictStaleNativeCliImports, hasActiveCodexTurn, hasRunningCodexTurn, busyCodingEngines, resolveRelayTask, recoverAfterCodexAppServerExit, reconcileOrphanedActiveTasks, retainExternalHandoff, releaseExternalHandoff });`);

function fixture() {
  const events: Array<Record<string, any>> = [];
  const deltas: Array<{ threadId: string; text: string }> = [];
  const deletedLocalThreadIds: string[] = [];
  const threads = new Map<string, Record<string, any>>([
    ["parent", { id: "parent", source: "appServer", parentThreadId: null, name: "主任务", updatedAt: 1, turns: [] }],
    ["child", { id: "child", source: { subAgent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } }, parentThreadId: "parent", updatedAt: 3, turns: [] }]
  ]);
  const publicState = { tasks: [{ threadId: "parent", title: "主任务", cwd: "", status: "active", updatedAt: 1, engine: "codex" }], activities: [] };
  const context = {
    ...adapter,
    crypto: globalThis.crypto,
    publicState, taskStore: new TaskStore(),
    clientUpdateController: null,
    clientOperations: 0,
    activeTurnByThread: new Map([["parent", "parent-turn"]]),
    lastProgressAtByThread: new Map(), turnUsageByThread: new Map(), pendingUsageByThread: new Map(),
    usageFlushTimers: new Map(), turnStartingByThread: new Set(), pendingCodexSteeringByThread: new Map(),
    externalHandoffCountByThread: new Map<string, number>(),
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
    deleteLocalThread: async (threadId: string) => { deletedLocalThreadIds.push(threadId); },
    scheduleDrainTurnQueue: () => {}, maybeReloadCodexAppServerWhenIdle: async () => {}, handleError: () => {},
    updateState: (patch: object) => { Object.assign(publicState, patch); },
    publish: async (event: Record<string, any>) => { events.push(event); },
    logInfo: () => {}, logWarn: () => {},
    acceptFullAccessApproval: () => false,
    socket: { readyState: 1 }, WebSocket: { OPEN: 1 },
    hiddenCodexSubagentIds: new Set(),
    reportedCodexProductTaskConflicts: new Set(),
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
    normalizeTaskCwd: async (cwd: string) => cwd,
    taskGitBranch: async () => undefined, gitBranchCache: new Map(),
    isThreadDeleted: () => false,
    isInProgressStoredStatus: (status: string) => status === "active",
    sanitizeTranscriptMessages: (messages: unknown[]) => messages, windowTranscriptMessages,
    queuedTurnsForThread: () => [],
    isHeadlessCliEngine: () => false,
    isThreadTurnBusy: () => false,
    threadHasPendingCursorApproval: () => false,
    clearThreadCursorApprovals: () => {},
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
    reconcileOrphanedActiveTasks(): Promise<number>;
    hideCodexSubagentTask(threadId: string): Promise<void>;
    pruneJunkCliImports(threadIds: string[]): Promise<void>;
    evictStaleNativeCliImports(threadIds: string[]): Promise<void>;
    retainExternalHandoff(threadId: string): number;
    releaseExternalHandoff(threadId: string): boolean;
  };
  return { ...functions, context, events, deltas, threads, publicState, deletedLocalThreadIds };
}

describe("Codex subagent task visibility", () => {
  it("does not hide a task created by AnytimeVibe when Codex metadata marks its thread as a subagent", async () => {
    const f = fixture();
    f.context.codexThreads.observeThread({ id: "parent", source: { subAgent: "review" } });
    await f.context.taskStore.upsert({
      threadId: "parent", engine: "codex", providerSessionId: "parent", cwd: "D:/project",
      title: "由 Web 创建的任务", status: "active", createdAt: 1, updatedAt: 2,
      permissionMode: "ask-for-approval", managedByAnytimeVibe: true, messages: []
    });

    await f.hideCodexSubagentTask("parent");

    expect(f.publicState.tasks.some((task) => task.threadId === "parent")).toBe(true);
    expect(f.context.activeTurnByThread.get("parent")).toBe("parent-turn");
    expect(f.events.filter((event) => event.type === "thread.deleted")).toEqual([]);
  });

  it("recognizes product tasks saved before the explicit ownership marker", async () => {
    const f = fixture();
    f.context.codexThreads.observeThread({ id: "parent", source: { subAgent: "review" } });
    await f.context.taskStore.upsert({
      threadId: "parent", engine: "codex", providerSessionId: "parent", cwd: "D:/project",
      title: "旧版本产品任务", status: "active", createdAt: 1, updatedAt: 2,
      permissionMode: "full-access", messages: []
    });

    await f.hideCodexSubagentTask("parent");

    expect(f.publicState.tasks.some((task) => task.threadId === "parent")).toBe(true);
    expect(f.context.activeTurnByThread.get("parent")).toBe("parent-turn");
    expect(f.events.filter((event) => event.type === "thread.deleted")).toEqual([]);
  });

  it("preserves active turn and task row when the native thread list reports stale subagent metadata", async () => {
    const f = fixture();
    f.threads.set("parent", { ...f.threads.get("parent"), source: { subAgent: "review" } });
    await f.context.taskStore.upsert({
      threadId: "parent", engine: "codex", providerSessionId: "parent", cwd: "D:/project",
      title: "Web 任务", status: "active", createdAt: 1, updatedAt: 2,
      permissionMode: "ask-for-approval", messages: []
    });

    await f.listCodexThreadsForSync({ limit: 10 });

    expect(f.publicState.tasks.some((task) => task.threadId === "parent")).toBe(true);
    expect(f.context.activeTurnByThread.get("parent")).toBe("parent-turn");
    expect(f.events.filter((event) => event.type === "thread.deleted").map((event) => event.threadId)).toEqual(["child"]);
  });

  it("does not prune or evict product tasks even if they match imported-session cleanup criteria", async () => {
    const f = fixture();
    await f.context.taskStore.upsert({
      threadId: "parent", engine: "codex", providerSessionId: "parent", cwd: "C:/Temp",
      title: "Web 任务", status: "active", createdAt: 1, updatedAt: 2,
      permissionMode: "ask-for-approval", messages: []
    });

    await f.pruneJunkCliImports(["parent"]);
    await f.evictStaleNativeCliImports(["parent"]);

    expect(f.context.taskStore.get("parent")).toBeDefined();
    expect(f.events.filter((event) => event.type === "thread.deleted")).toEqual([]);
  });

  it("protects a managed task when automatic cleanup only has its provider session id", async () => {
    const f = fixture();
    await f.context.taskStore.upsert({
      threadId: "web-task", engine: "claude", providerSessionId: "native-session", cwd: "D:/project",
      title: "Web 任务", status: "active", createdAt: 1, updatedAt: 2,
      managedByAnytimeVibe: true, messages: []
    });

    await f.pruneJunkCliImports(["native-session"]);
    await f.evictStaleNativeCliImports(["native-session"]);

    expect(f.deletedLocalThreadIds).toEqual([]);
    expect(f.context.taskStore.get("web-task")).toBeDefined();
    expect(f.events.filter((event) => event.type === "thread.deleted")).toEqual([]);
  });

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

  it("persists a Codex task loaded from native history before a fail-fast turn", async () => {
    const f = fixture();
    expect(f.context.taskStore.get("parent")).toBeUndefined();

    await f.publishThread("parent");

    expect(f.context.taskStore.get("parent")).toMatchObject({
      threadId: "parent",
      engine: "codex",
      providerSessionId: "parent",
      title: "主任务"
    });
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

  it("keeps active tasks outside the recent refresh window", async () => {
    const f = fixture();
    await f.context.taskStore.upsert({
      threadId: "active-old", engine: "claude", providerSessionId: "active-old", cwd: "",
      title: "仍在运行", status: "active", createdAt: 1, updatedAt: 1, messages: []
    });
    f.publicState.tasks.push({ threadId: "active-old", title: "仍在运行", cwd: "", status: "active", updatedAt: 1, engine: "claude" });
    for (let index = 0; index < 12; index += 1) {
      await f.context.taskStore.upsert({
        threadId: `recent-${index}`, engine: "claude", providerSessionId: `recent-${index}`, cwd: "",
        title: `最近任务 ${index}`, status: "completed", createdAt: 10 + index, updatedAt: 10 + index, messages: []
      });
    }

    await f.refreshLocalTasks(10);

    expect(f.publicState.tasks.some((task) => task.threadId === "active-old")).toBe(true);
  });

  it("keeps a task that becomes active while refresh metadata is still loading", async () => {
    const f = fixture();
    await f.context.taskStore.upsert({
      threadId: "baseline", engine: "claude", providerSessionId: "baseline", cwd: "baseline",
      title: "基准任务", status: "completed", createdAt: 1, updatedAt: 1, messages: []
    });

    let releaseMetadata!: () => void;
    let metadataEntered!: () => void;
    const metadataReady = new Promise<void>((resolve) => { metadataEntered = resolve; });
    const metadataRelease = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    let injected = false;
    f.context.normalizeTaskCwd = async (cwd: string) => {
      if (cwd === "baseline" && !injected) {
        injected = true;
        metadataEntered();
        await metadataRelease;
      }
      return cwd;
    };

    const refresh = f.refreshLocalTasks(10);
    await metadataReady;
    await f.context.taskStore.upsert({
      threadId: "late-active", engine: "claude", providerSessionId: "late-active", cwd: "late-active",
      title: "刷新期间启动", status: "active", createdAt: 2, updatedAt: 2, messages: []
    });
    f.context.activeTurnByThread.set("late-active", "late-turn");
    f.publicState.tasks.push({
      threadId: "late-active", title: "刷新期间启动", cwd: "late-active", status: "active", updatedAt: 2, engine: "claude"
    });
    releaseMetadata();
    await refresh;

    expect(f.publicState.tasks.some((task) => task.threadId === "late-active")).toBe(true);
  });

  it("materializes a live turn even when refresh has no stored or public task row", async () => {
    const f = fixture();
    f.publicState.tasks = [];
    f.context.activeTurnByThread.set("turn-without-row", "live-turn");

    await f.refreshLocalTasks(1);

    expect(f.publicState.tasks).toContainEqual(expect.objectContaining({
      threadId: "turn-without-row", status: "active", engine: "codex"
    }));
  });

  it("keeps an old task visible while its desktop CLI handoff is still open", async () => {
    const f = fixture();
    await f.context.taskStore.upsert({
      threadId: "external-handoff", engine: "codex", providerSessionId: "external-handoff", cwd: "D:/talk-bot",
      title: "谈话机器人项目", status: "completed", createdAt: 1, updatedAt: 1, messages: []
    });
    f.context.externalHandoffCountByThread.set("external-handoff", 1);

    await f.refreshLocalTasks(1);

    expect(f.publicState.tasks).toContainEqual(expect.objectContaining({
      threadId: "external-handoff", title: "谈话机器人项目", status: "active"
    }));
    expect(f.busyCodingEngines()).toContain("codex");
  });

  it("ignores a stale Codex completion after a newer turn has started on the same thread", async () => {
    const f = fixture();
    await f.context.taskStore.upsert({
      threadId: "parent", engine: "codex", providerSessionId: "parent", cwd: "D:/talk-bot",
      title: "谈话机器人项目", status: "active", createdAt: 1, updatedAt: 2,
      permissionMode: "full-access", messages: []
    });
    f.context.activeTurnByThread.set("parent", "new-turn");
    f.context.activeNativeCodexTurns.set("parent", "new-turn");

    await f.handleCodexMessage({
      method: "turn/completed",
      params: { threadId: "parent", turn: { id: "old-turn", status: "completed" } }
    });

    expect(f.context.activeTurnByThread.get("parent")).toBe("new-turn");
    expect(f.context.taskStore.get("parent")?.status).toBe("active");
    expect(f.events.filter((event) => event.type === "turn.completed")).toEqual([]);
  });

  it("keeps a task busy until every external handoff terminal has closed", () => {
    const f = fixture();

    expect(f.retainExternalHandoff("parent")).toBe(1);
    expect(f.retainExternalHandoff("parent")).toBe(2);
    expect(f.releaseExternalHandoff("parent")).toBe(false);
    expect(f.context.externalHandoffCountByThread.get("parent")).toBe(1);
    expect(f.releaseExternalHandoff("parent")).toBe(true);
    expect(f.context.externalHandoffCountByThread.has("parent")).toBe(false);
  });

  it("does not convert an active Codex task to interrupted without a terminal native status", async () => {
    const f = fixture();
    await f.context.taskStore.upsert({
      threadId: "parent", engine: "codex", providerSessionId: "parent", cwd: "",
      title: "主任务", status: "active", createdAt: 1, updatedAt: 1, messages: []
    });
    f.context.activeTurnByThread.clear();
    f.threads.set("parent", { ...f.threads.get("parent"), status: "idle", turns: [] });

    const fixed = await f.reconcileOrphanedActiveTasks();

    expect(fixed).toBe(0);
    expect(f.context.taskStore.get("parent")?.status).toBe("active");
    expect(f.events.filter((event) => event.type === "turn.completed")).toEqual([]);
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
