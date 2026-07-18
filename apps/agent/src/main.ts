import {
  app,
  autoUpdater as electronNativeUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray
} from "electron";
import { execFile, spawn } from "node:child_process";
import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { autoUpdater } from "electron-updater";
import {
  agentEventSchema,
  base64ToBytes,
  bytesToBase64,
  clientCommandSchema,
  createEnvelope,
  derivePairingKey,
  encryptPayload,
  generatePairingKeyPair,
  importAesKey,
  openEnvelope,
  randomKeyBytes,
  type AgentEvent,
  type CliEngine,
  type CliEngineInfo,
  type ClientCommand,
  type EncryptedEnvelope,
  type PermissionMode,
  type ReasoningEffort,
  type EngineQuota,
  type Workspace,
  PRODUCT_VERSION
} from "@anytimevibe/protocol";
import {
  CodexAdapter,
  extractCodexTurnError,
  isTerminalTurnStatus,
  normalizeUnixSeconds,
  threadResumeParams,
  threadStartParams,
  threadToSnapshot
} from "./codex-adapter";
import { clearEngineBinaryCache, detectAvailableEngines, resolveEngineBinary } from "./cli/detect";
import { queryEngineQuotas, sanitizeEngineQuota } from "./cli/engine-quota";
import { interruptHeadlessThread, isHeadlessThreadActive, runHeadlessTurn } from "./cli/headless-runner";
import { importLocalCliSessions } from "./cli/import-sessions";
import { discoverEngineCapabilities, type EngineCapability } from "./cli/model-catalog";
import { appendEngineDiffChunk, buildTurnDiff, clearEngineDiffChunks, extractFileChangeDiff } from "./cli/task-diff";
import { TaskStore } from "./cli/task-store";
import { normalizeCliEngine, type BackendStreamEvent } from "./cli/types";
import { ensureWorkspaceTrusted, ensureWorkspaceTrustedForAllEngines } from "./cli/workspace-trust";
import { collectLocalProxyEnv, mergeProxyIntoEnv, proxyShellPrefix } from "./local-proxy";
import { normalizeWindowsCommandPath, windowsCmdArguments } from "./windows-command";

const execFileAsync = promisify(execFile);
const DEFAULT_RELAY_URL = "https://vibe.demonrain.top";

type StoredPairing = {
  id: string;
  code: string;
  secret: string;
  expiresAt: number;
};

type AgentConfig = {
  relayUrl: string;
  agentId: string;
  displayName: string;
  hostId?: string;
  encryptedAgentToken?: string;
  encryptedSyncKey?: string;
  encryptedPrivateKey?: string;
  publicKey?: JsonWebKey;
  pairing?: StoredPairing;
  workspaces: Workspace[];
  sequence: number;
};

type PublicState = {
  relayUrl: string;
  displayName: string;
  status: "unconfigured" | "waiting_pairing" | "pairing" | "connecting" | "online" | "offline" | "incompatible";
  detail: string;
  pairingCode?: string | undefined;
  pairingExpiresAt?: number | undefined;
  hostId?: string | undefined;
  codexVersion: string;
  /** Default coding CLI for new tasks. */
  cliEngine: CliEngine;
  availableEngines: CliEngineInfo[];
  engineCapabilities: EngineCapability[];
  workspaces: Workspace[];
  environment: EnvironmentState;
  update: UpdateState;
  tasks: AgentTask[];
  /** @deprecated Prefer activities + selectedActivityThreadId (kept for older UI paint paths). */
  activity?: ActivityState;
  /** Concurrent remote tasks currently tracked in the agent panel. */
  activities: ActivityState[];
  selectedActivityThreadId?: string;
};

type AgentTask = {
  threadId: string;
  title: string;
  cwd: string;
  status: string;
  updatedAt: number;
  engine?: CliEngine;
};

type ActivityState = {
  threadId: string;
  title: string;
  prompt: string;
  status: "processing" | "completed" | "failed" | "interrupted";
  output: string;
  engine?: CliEngine;
  updatedAt: number;
};

type EnvironmentState = {
  platform: "windows" | "macos" | "other";
  nodeInstalled: boolean;
  nodeVersion?: string;
  codexInstalled: boolean;
  codexVersion?: string;
  codexCompatible: boolean;
};

type UpdateState = {
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  version?: string;
  progress?: number;
  message?: string;
};

let windowRef: BrowserWindow | null = null;
let tray: Tray | null = null;
let config: AgentConfig;
let configPath = "";
let codexCommand = "codex.cmd";
let codexVersion = "unknown";
const initialEnvironment: EnvironmentState = { platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "other", nodeInstalled: false, codexInstalled: false, codexCompatible: false };
let publicState: PublicState = {
  relayUrl: DEFAULT_RELAY_URL,
  displayName: "",
  status: "unconfigured",
  detail: "请先配置中继地址。",
  codexVersion,
  cliEngine: "codex",
  availableEngines: [],
  engineCapabilities: [],
  workspaces: [],
  environment: initialEnvironment,
  update: { status: "idle" },
  tasks: [],
  activities: []
};
const taskStore = new TaskStore();

function productIconPath(): string {
  const candidates = [
    path.join(__dirname, "..", "assets", "icon.ico"),
    path.join(__dirname, "..", "assets", "icon.png"),
    path.join(process.resourcesPath, "assets", "icon.ico"),
    path.join(process.resourcesPath, "assets", "icon.png")
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return path.join(__dirname, "..", "assets", "icon.png");
}

function loadProductIcon() {
  const fromFile = nativeImage.createFromPath(productIconPath());
  if (!fromFile.isEmpty()) return fromFile;
  return nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," +
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#17211b"/><path d="M13 20h38v25H13z" fill="#f2eadb"/><path d="m19 27 7 5-7 6" fill="none" stroke="#e25832" stroke-width="5"/><path d="M31 39h14" stroke="#2d7653" stroke-width="5"/><circle cx="46" cy="24" r="3" fill="#3bab70"/></svg>'
      ).toString("base64")
  );
}

function resolvedDisplayName(): string {
  const name = config?.displayName?.trim();
  return name || os.hostname();
}
let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pairingTimer: NodeJS.Timeout | null = null;
let codex: CodexAdapter | null = null;
let syncKey: CryptoKey | null = null;
let quitting = false;
/** True while quitAndInstall is in progress — suppress all UI/side-effect callbacks. */
let installingUpdate = false;
/** Bumped on every intentional connect(); stale socket handlers ignore events. */
let connectGeneration = 0;
let reconnectAttempt = 0;
/** Permanent auth failures must not flap reconnect forever. */
let reconnectBlockedReason: string | null = null;
const pendingPrompts = new Map<string, string>();
const pendingRequestTypes = new Map<string, "command" | "file" | "permission" | "input">();
/** threadId -> active turnId for streaming turn.delta to web */
const activeTurnByThread = new Map<string, string>();
/** Per-thread local activity buffers (multi-task concurrent remote runs). */
const activityOutputBuffers = new Map<string, string>();
const activityFlushTimers = new Map<string, NodeJS.Timeout>();
const activityItemsByThread = new Map<string, Map<string, string>>();
/** Pending remote stream chunks: key = threadId\\0itemId */
const remoteDeltaBuffers = new Map<string, string>();
let remoteDeltaFlushTimer: NodeJS.Timeout | null = null;

/**
 * Durable per-thread follow-up queue queue.
 * Web may close the browser after enqueueing a second task while the first still runs;
 * the agent must own the queue so prompts still execute after the active turn ends.
 */
type QueuedTurnStart = {
  commandId: string;
  prompt: string;
  permissionMode?: PermissionMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
};
const turnQueueByThread = new Map<string, QueuedTurnStart[]>();
/** Covers the gap between accepting turn.start and activeTurnByThread being set. */
const turnStartingByThread = new Set<string>();
let turnQueueFilePath = "";
const WS_CONNECT_TIMEOUT_MS = 15_000;
const PATH_REFRESH_TIMEOUT_MS = 8_000;

/** In-app diagnostics ring buffer + append-only log file for user troubleshooting. */
type AgentLogLevel = "info" | "warn" | "error";
type AgentLogEntry = {
  id: string;
  ts: string;
  level: AgentLogLevel;
  message: string;
};
const MAX_AGENT_LOGS = 1_000;
const agentLogs: AgentLogEntry[] = [];
let agentLogFilePath = "";

function formatLogExtra(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendAgentLog(level: AgentLogLevel, message: string, extra?: unknown): void {
  const extraText = formatLogExtra(extra);
  const full = (extraText ? `${message} ${extraText}` : message).replace(/\s+/g, " ").trim().slice(0, 4_000);
  if (!full) return;
  const entry: AgentLogEntry = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    level,
    message: full
  };
  agentLogs.push(entry);
  while (agentLogs.length > MAX_AGENT_LOGS) agentLogs.shift();
  if (agentLogFilePath) {
    const line = `${entry.ts} [${entry.level}] ${entry.message}\n`;
    void fs.appendFile(agentLogFilePath, line, "utf8").catch(() => undefined);
  }
  if (level === "error") console.error(`[agent] ${entry.message}`);
  else if (level === "warn") console.warn(`[agent] ${entry.message}`);
  // Live push to open log panel (does not go through agent:state to avoid UI thrash).
  if (!quitting && !installingUpdate) {
    try {
      if (isWindowAlive()) windowRef!.webContents.send("agent:log", entry);
    } catch {
      // ignore
    }
  }
}

function logInfo(message: string, extra?: unknown): void {
  appendAgentLog("info", message, extra);
}
function logWarn(message: string, extra?: unknown): void {
  appendAgentLog("warn", message, extra);
}
function logError(message: string, extra?: unknown): void {
  appendAgentLog("error", message, extra);
}

async function initAgentLogFile(userDataDir: string): Promise<void> {
  agentLogFilePath = path.join(userDataDir, "agent.log");
  try {
    await fs.mkdir(userDataDir, { recursive: true });
    // Soft-rotate when file grows large so disk use stays bounded.
    try {
      const stat = await fs.stat(agentLogFilePath);
      if (stat.size > 2 * 1024 * 1024) {
        const bak = `${agentLogFilePath}.1`;
        await fs.rm(bak, { force: true }).catch(() => undefined);
        await fs.rename(agentLogFilePath, bak).catch(() => undefined);
      }
    } catch {
      // first run / missing file
    }
    logInfo(`客户端启动 v${PRODUCT_VERSION}`, `${process.platform} ${os.release()} · ${process.arch}`);
  } catch {
    agentLogFilePath = "";
  }
}

function resolveActivityEngine(threadId: string): CliEngine | undefined {
  return taskStore.get(threadId)?.engine
    || publicState.tasks.find((item) => item.threadId === threadId)?.engine;
}

function isThreadTurnBusy(threadId: string): boolean {
  return turnStartingByThread.has(threadId)
    || activeTurnByThread.has(threadId)
    || isHeadlessThreadActive(threadId);
}

async function persistTurnQueue(): Promise<void> {
  if (!turnQueueFilePath) return;
  const payload: Record<string, QueuedTurnStart[]> = {};
  for (const [threadId, items] of turnQueueByThread) {
    if (items.length > 0) payload[threadId] = items;
  }
  try {
    await fs.mkdir(path.dirname(turnQueueFilePath), { recursive: true });
    await fs.writeFile(turnQueueFilePath, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // ignore disk errors — in-memory queue still works for the current process
  }
}

async function loadTurnQueue(userDataDir: string): Promise<void> {
  turnQueueFilePath = path.join(userDataDir, "turn-queue.json");
  turnQueueByThread.clear();
  try {
    const raw = JSON.parse(await fs.readFile(turnQueueFilePath, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return;
    for (const [threadId, items] of Object.entries(raw)) {
      if (!threadId || !Array.isArray(items)) continue;
      const cleaned: QueuedTurnStart[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const prompt = String((item as QueuedTurnStart).prompt ?? "").trim();
        const commandId = String((item as QueuedTurnStart).commandId ?? "").trim() || crypto.randomUUID();
        if (!prompt) continue;
        const entry: QueuedTurnStart = { commandId, prompt };
        const mode = (item as QueuedTurnStart).permissionMode;
        if (
          mode === "read-only"
          || mode === "ask-for-approval"
          || mode === "approve-for-me"
          || mode === "full-access"
          || mode === "inherit"
          || mode === "workspace-write"
        ) {
          entry.permissionMode = mode;
        }
        const model = String((item as QueuedTurnStart).model ?? "").trim();
        if (model) entry.model = model;
        const effort = (item as QueuedTurnStart).reasoningEffort;
        if (
          effort === "low"
          || effort === "medium"
          || effort === "high"
          || effort === "xhigh"
          || effort === "max"
        ) {
          entry.reasoningEffort = effort;
        }
        cleaned.push(entry);
      }
      if (cleaned.length) turnQueueByThread.set(threadId, cleaned);
    }
  } catch {
    // missing or corrupt file — start empty
  }
}

async function enqueueTurnStart(command: Extract<ClientCommand, { type: "turn.start" }>): Promise<void> {
  const list = turnQueueByThread.get(command.threadId) ?? [];
  const entry: QueuedTurnStart = {
    commandId: command.commandId,
    prompt: command.prompt
  };
  if (command.permissionMode) entry.permissionMode = command.permissionMode;
  if (command.model) entry.model = command.model;
  if (command.reasoningEffort) entry.reasoningEffort = command.reasoningEffort;
  list.push(entry);
  turnQueueByThread.set(command.threadId, list);
  await persistTurnQueue();
  logInfo(`线程 ${command.threadId.slice(0, 8)} 忙碌，后续指令已入队`, `queue=${list.length}`);
  updateState({
    detail: `任务「${command.threadId.slice(0, 8)}…」当前忙碌，已排队第 ${list.length} 条后续指令（关闭浏览器后仍会执行）。`
  });
}

async function clearTurnQueue(threadId: string): Promise<void> {
  if (!turnQueueByThread.has(threadId)) return;
  turnQueueByThread.delete(threadId);
  await persistTurnQueue();
}

function scheduleDrainTurnQueue(threadId: string): void {
  setImmediate(() => {
    void drainTurnQueue(threadId).catch(handleError);
  });
}

async function drainTurnQueue(threadId: string): Promise<void> {
  if (isThreadTurnBusy(threadId)) return;
  const list = turnQueueByThread.get(threadId);
  if (!list?.length) return;
  const next = list.shift()!;
  if (list.length === 0) turnQueueByThread.delete(threadId);
  else turnQueueByThread.set(threadId, list);
  await persistTurnQueue();
  logInfo(`执行排队指令`, `thread=${threadId.slice(0, 8)} remaining=${list.length}`);
  await handleCommand({
    type: "turn.start",
    commandId: next.commandId,
    threadId,
    prompt: next.prompt,
    ...(next.permissionMode ? { permissionMode: next.permissionMode } : {}),
    ...(next.model ? { model: next.model } : {}),
    ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {})
  });
}

function scheduleDrainAllTurnQueues(): void {
  for (const threadId of turnQueueByThread.keys()) {
    scheduleDrainTurnQueue(threadId);
  }
}

/** Bound PATH refresh so a hung shell never blocks relay reconnect forever. */
async function applyLoginPathToProcessBounded(): Promise<void> {
  try {
    await Promise.race([
      applyLoginPathToProcess(),
      new Promise<void>((resolve) => setTimeout(resolve, PATH_REFRESH_TIMEOUT_MS))
    ]);
  } catch {
    // ignore
  }
}

function syncActivitiesState(nextActivities: ActivityState[], selectedThreadId?: string): void {
  const selected = selectedThreadId
    ?? publicState.selectedActivityThreadId
    ?? nextActivities.find((item) => item.status === "processing")?.threadId
    ?? nextActivities[0]?.threadId;
  const selectedActivity = nextActivities.find((item) => item.threadId === selected);
  const next: PublicState = {
    ...publicState,
    activities: nextActivities,
    relayUrl: config?.relayUrl ?? publicState.relayUrl,
    displayName: config ? resolvedDisplayName() : publicState.displayName,
    codexVersion,
    workspaces: config?.workspaces ?? publicState.workspaces
  };
  if (selected) next.selectedActivityThreadId = selected;
  else delete next.selectedActivityThreadId;
  if (selectedActivity) next.activity = selectedActivity;
  else delete next.activity;
  publicState = next;
  if (quitting || installingUpdate) return;
  try {
    if (isWindowAlive()) windowRef!.webContents.send("agent:state", publicState);
  } catch {
    // ignore
  }
  try {
    rebuildTray();
  } catch {
    // ignore
  }
}

function startLocalActivity(threadId: string, prompt: string, title = "远程任务", engine?: CliEngine): void {
  activityOutputBuffers.set(threadId, "");
  activityItemsByThread.set(threadId, new Map());
  const existingTimer = activityFlushTimers.get(threadId);
  if (existingTimer) clearTimeout(existingTimer);
  activityFlushTimers.delete(threadId);
  const now = Date.now() / 1000;
  const resolvedEngine = engine || resolveActivityEngine(threadId);
  const entry: ActivityState = {
    threadId,
    title,
    prompt,
    status: "processing",
    output: "",
    updatedAt: now,
    ...(resolvedEngine ? { engine: resolvedEngine } : {})
  };
  const next = [
    entry,
    ...publicState.activities.filter((item) => item.threadId !== threadId)
  ].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  syncActivitiesState(next, threadId);
  // Bump task list so the active thread rises to the top by last activity.
  touchAgentTask(threadId, { title, status: "active", ...(resolvedEngine ? { engine: resolvedEngine } : {}) });
}

function appendLocalActivityStage(threadId: string, text: string): void {
  if (!text.trim()) return;
  const buf = activityOutputBuffers.get(threadId) ?? "";
  const current = publicState.activities.find((item) => item.threadId === threadId)?.output ?? "";
  appendLocalActivity(threadId, `${buf || current ? "\n\n" : ""}${text.trim()}`);
}

function touchAgentTask(threadId: string, patch: Partial<AgentTask> = {}): void {
  const now = Date.now() / 1000;
  const existing = publicState.tasks.find((item) => item.threadId === threadId);
  const stored = taskStore.get(threadId);
  const engine = patch.engine || existing?.engine || stored?.engine;
  const task: AgentTask = {
    threadId,
    title: patch.title || existing?.title || stored?.title || "远程任务",
    cwd: preferTaskCwd(patch.cwd, existing?.cwd, stored?.cwd),
    status: patch.status || existing?.status || stored?.status || "active",
    updatedAt: now,
    ...(engine ? { engine } : {})
  };
  updateState({
    tasks: [task, ...publicState.tasks.filter((item) => item.threadId !== threadId)]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 200)
  });
}

function activityItemKey(params: Record<string, any>): string {
  return String(params.item?.id ?? params.itemId ?? "");
}

function activityItemLabel(item: Record<string, any>): string | null {
  if (item.type === "agentMessage") return "Codex 回复";
  if (item.type === "commandExecution") return `执行命令\n${String(item.command ?? "").trim()}`;
  if (item.type === "fileChange") {
    const paths = (item.changes ?? []).map((change: Record<string, any>) => change.path).filter(Boolean).join("\n");
    return `修改文件${paths ? `\n${paths}` : ""}`;
  }
  if (item.type === "mcpToolCall") return `调用工具\n${String(item.tool ?? item.name ?? "")}`;
  if (item.type === "webSearch") return `搜索资料\n${String(item.query ?? "")}`;
  if (item.type === "reasoning") return "思考中";
  return null;
}

function activityItemResult(item: Record<string, any>): string {
  if (item.type === "agentMessage") return "";
  if (item.type === "commandExecution") {
    const output = String(item.aggregatedOutput ?? item.output ?? item.stdout ?? "").trim();
    return output ? `命令输出\n${output}` : `命令${item.status ? ` ${item.status}` : "已完成"}`;
  }
  if (item.type === "fileChange") return `文件修改${item.status ? ` ${item.status}` : "已完成"}`;
  if (item.type === "mcpToolCall") return `工具调用${item.status ? ` ${item.status}` : "已完成"}`;
  if (item.type === "webSearch") return "搜索完成";
  return "";
}

function appendLocalActivity(threadId: string, delta: string): void {
  if (!publicState.activities.some((item) => item.threadId === threadId)) return;
  activityOutputBuffers.set(threadId, (activityOutputBuffers.get(threadId) ?? "") + delta);
  if (activityFlushTimers.has(threadId)) return;
  const timer = setTimeout(() => {
    activityFlushTimers.delete(threadId);
    const activity = publicState.activities.find((item) => item.threadId === threadId);
    if (!activity) return;
    const chunk = activityOutputBuffers.get(threadId) ?? "";
    activityOutputBuffers.set(threadId, "");
    const output = (activity.output + chunk).slice(-100_000);
    const next = publicState.activities.map((item) =>
      item.threadId === threadId
        ? { ...item, output, updatedAt: Date.now() / 1000 }
        : item
    ).sort((a, b) => b.updatedAt - a.updatedAt);
    syncActivitiesState(next, publicState.selectedActivityThreadId);
  }, 50);
  activityFlushTimers.set(threadId, timer);
}

function finishLocalActivity(threadId: string, status: string): void {
  const activity = publicState.activities.find((item) => item.threadId === threadId);
  if (!activity) return;
  const chunk = activityOutputBuffers.get(threadId) ?? "";
  activityOutputBuffers.set(threadId, "");
  const timer = activityFlushTimers.get(threadId);
  if (timer) clearTimeout(timer);
  activityFlushTimers.delete(threadId);
  const normalized = status.toLowerCase();
  const finalStatus: ActivityState["status"] = normalized.includes("interrupt")
    ? "interrupted"
    : normalized.includes("fail")
      ? "failed"
      : "completed";
  const now = Date.now() / 1000;
  const next = publicState.activities.map((item) =>
    item.threadId === threadId
      ? { ...item, output: (item.output + chunk).slice(-100_000), status: finalStatus, updatedAt: now }
      : item
  ).sort((a, b) => b.updatedAt - a.updatedAt);
  syncActivitiesState(next, publicState.selectedActivityThreadId);
  touchAgentTask(threadId, { status: finalStatus });
}

function queueRemoteDelta(threadId: string, itemId: string, delta: string): void {
  if (!delta || !threadId || !itemId) return;
  if (!activeTurnByThread.has(threadId)) return;
  const key = `${threadId}\0${itemId}`;
  remoteDeltaBuffers.set(key, (remoteDeltaBuffers.get(key) ?? "") + delta);
  if (remoteDeltaFlushTimer) return;
  remoteDeltaFlushTimer = setTimeout(() => {
    remoteDeltaFlushTimer = null;
    void flushRemoteDeltas();
  }, 60);
}

async function flushRemoteDeltas(): Promise<void> {
  if (!remoteDeltaBuffers.size) return;
  const pending = [...remoteDeltaBuffers.entries()];
  remoteDeltaBuffers.clear();
  for (const [key, delta] of pending) {
    if (!delta) continue;
    const sep = key.indexOf("\0");
    const threadId = key.slice(0, sep);
    const itemId = key.slice(sep + 1);
    const turnId = activeTurnByThread.get(threadId);
    if (!turnId) continue;
    try {
      // Live stream — do not persist every chunk to the relay DB.
      await publish({
        type: "turn.delta",
        eventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        threadId,
        turnId,
        itemId,
        delta
      }, false);
    } catch (error) {
      handleError(error);
    }
  }
}

function encryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储当前不可用");
  return safeStorage.encryptString(value).toString("base64");
}

function decryptSecret(value: string): string {
  return safeStorage.decryptString(Buffer.from(value, "base64"));
}

async function saveConfig(): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

function isWindowAlive(): boolean {
  return Boolean(windowRef && !windowRef.isDestroyed() && !windowRef.webContents.isDestroyed());
}

function updateState(patch: Partial<PublicState>): void {
  publicState = {
    ...publicState,
    ...patch,
    relayUrl: config?.relayUrl ?? publicState.relayUrl,
    displayName: config ? resolvedDisplayName() : publicState.displayName,
    codexVersion,
    workspaces: config?.workspaces ?? publicState.workspaces
  };
  // During quit/update the BrowserWindow/Tray may already be destroyed; never touch them.
  if (quitting || installingUpdate) return;
  try {
    if (isWindowAlive()) {
      windowRef!.webContents.send("agent:state", publicState);
    }
  } catch {
    // Window can race-destroy between isDestroyed checks and send.
  }
  try {
    rebuildTray();
  } catch {
    // Tray may already be destroyed during shutdown.
  }
}

function rebuildTray(): void {
  if (!tray || quitting || installingUpdate) return;
  if (typeof (tray as Tray & { isDestroyed?: () => boolean }).isDestroyed === "function"
    && (tray as Tray & { isDestroyed: () => boolean }).isDestroyed()) {
    return;
  }
  tray.setToolTip(`${resolvedDisplayName()} · ${publicState.status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `状态：${publicState.status}`, enabled: false },
    { label: `名称：${resolvedDisplayName()}`, enabled: false },
    { label: "打开控制面板", click: () => showWindow() },
    { label: "添加工作区", click: () => addWorkspace() },
    { label: "重新连接", click: () => connect().catch(handleError) },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]));
}

function showWindow(): void {
  if (!windowRef) createWindow();
  windowRef?.show();
  windowRef?.focus();
}

function createWindow(): void {
  const icon = loadProductIcon();
  windowRef = new BrowserWindow({
    width: 460,
    height: 680,
    minWidth: 400,
    minHeight: 520,
    resizable: true,
    maximizable: false,
    // Transparent frameless shell — chrome is drawn by the renderer.
    frame: false,
    transparent: true,
    hasShadow: true,
    backgroundColor: "#00000000",
    title: "随码",
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.platform === "win32") windowRef.setIcon(icon);
  windowRef.setMenuBarVisibility(false);
  windowRef.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rendererHtml())}`);
  windowRef.webContents.on("did-finish-load", () => {
    // Push latest state after the page boots (covers races with first getState).
    try {
      if (windowRef && !windowRef.isDestroyed() && !windowRef.webContents.isDestroyed()) {
        windowRef.webContents.send("agent:state", publicState);
      }
    } catch {
      // ignore
    }
  });
  windowRef.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.error("[renderer]", message);
  });
  windowRef.on("close", (event) => {
    // When quitting for update/install, allow the window to close so quitAndInstall can proceed.
    if (!quitting) {
      event.preventDefault();
      windowRef?.hide();
    }
  });
}

function rendererHtml(): string {
  const platformLabel = process.platform === "darwin" ? "MACOS" : "WINDOWS";
  const iconDataUrl = (() => {
    try {
      return `data:image/png;base64,${readFileSync(productIconPath()).toString("base64")}`;
    } catch {
      return "";
    }
  })();
  // Snapshot state into the page so UI never depends solely on first IPC round-trip.
  const initialStateJson = JSON.stringify(publicState).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const vendorLogo = (name: string): string => {
    const candidates = [
      path.join(__dirname, "..", "assets", "vendors", `${name}.png`),
      path.join(process.resourcesPath, "assets", "vendors", `${name}.png`)
    ];
    for (const file of candidates) {
      try {
        return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
      } catch {
        // try next
      }
    }
    return "";
  };
  const logoMapJson = JSON.stringify({
    codex: vendorLogo("codex"),
    claude: vendorLogo("claude"),
    grok: vendorLogo("grok"),
    cursor: vendorLogo("cursor")
  }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>随码</title><style>
  :root{font-family:"Bahnschrift","Aptos","Segoe UI",sans-serif;color:#17211b}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:transparent}
  body{overflow:hidden}
  .frame{height:100%;padding:10px;display:flex}
  .shell{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;padding:12px 12px 10px;border-radius:18px;background:rgba(242,234,219,.92);border:1px solid rgba(23,33,27,.14);box-shadow:0 18px 40px rgba(23,33,27,.18);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);overflow:hidden}
  .titlebar{display:flex;align-items:center;gap:10px;-webkit-app-region:drag;app-region:drag;padding:2px 2px 4px;cursor:default;user-select:none;-webkit-user-select:none}
  .titlebar,.titlebar *{user-select:none;-webkit-user-select:none}
  .titlebar .win-actions{-webkit-app-region:no-drag;app-region:no-drag;margin-left:auto;display:flex;gap:4px;align-items:center}
  .titlebar .win-actions button{width:28px;height:24px;padding:0;border-radius:7px;background:#e7ddcd;color:#17211b;font-size:12px;line-height:1}
  .titlebar .win-actions button.logs-btn{width:auto;min-width:36px;padding:0 8px;font-size:11px;font-weight:800}
  .titlebar .win-actions button.close{background:#e25832;color:#fff}
  .log-modal-backdrop{position:fixed;inset:0;z-index:80;display:none;align-items:center;justify-content:center;padding:14px;background:rgba(23,33,27,.48);-webkit-app-region:no-drag;app-region:no-drag}
  .log-modal-backdrop.open{display:flex}
  .log-modal{width:100%;max-width:440px;height:min(74vh,540px);display:flex;flex-direction:column;background:rgba(255,250,240,.98);border:1px solid rgba(23,33,27,.14);border-radius:14px;box-shadow:0 22px 48px rgba(23,33,27,.28);overflow:hidden}
  .log-modal header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(23,33,27,.1)}
  .log-modal header h3{margin:0;font:700 13px Rockwell,serif}
  .log-modal header .log-actions{display:flex;flex-wrap:wrap;gap:4px}
  .log-modal header button{padding:5px 8px;font-size:10px}
  .log-view{flex:1;min-height:0;overflow:auto;background:#17211b;color:#c8d0c8;padding:10px;font:10px/1.5 "Cascadia Code",Consolas,monospace;white-space:pre-wrap;word-break:break-word;user-select:text;-webkit-user-select:text}
  .log-view .log-line{display:block;margin:0 0 3px;border-bottom:1px solid rgba(255,255,255,.04);padding-bottom:2px}
  .log-view .log-line .ts{color:#7a857a;margin-right:6px}
  .log-view .log-line.info .lvl{color:#7ec8a3}
  .log-view .log-line.warn .lvl{color:#e6c07b}
  .log-view .log-line.error .lvl{color:#ff8f7a}
  .log-view .log-line .msg{color:#e8eee8}
  .log-modal footer{padding:8px 12px;border-top:1px solid rgba(23,33,27,.08);font-size:10px;color:#6b726b}
  .scroll{flex:1;min-height:0;overflow-x:hidden;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px}
  .mark{width:34px;height:34px;border-radius:10px;overflow:hidden;background:#17211b;flex:0 0 auto;box-shadow:0 6px 14px rgba(23,33,27,.16)}
  .mark img{width:100%;height:100%;display:block;object-fit:cover}
  .titlebar h1{font:700 16px Rockwell,serif;margin:0;line-height:1.1}
  .titlebar p{margin:2px 0 0;color:#6b726b;font-size:9px;letter-spacing:.12em}
  .card{background:rgba(255,250,240,.96);border:1px solid rgba(23,33,27,.12);border-radius:12px;padding:10px 11px;box-shadow:0 8px 18px rgba(34,39,31,.05)}
  .card.grow{display:flex;flex-direction:column;min-height:0}
  .status{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
  .status b{text-transform:uppercase;font-size:10px;letter-spacing:.1em}
  .dot{width:8px;height:8px;border-radius:50%;background:#999;flex:0 0 auto}
  .dot.online{background:#3bab70;box-shadow:0 0 0 4px rgba(59,171,112,.14)}
  .detail{color:#6b726b;font-size:11px;line-height:1.4;margin:6px 0 0;white-space:pre-wrap}
  .meta{font:10px/1.4 "Cascadia Code",monospace;color:#687068;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nav-tabs{display:flex;gap:4px;padding:2px;background:rgba(23,33,27,.07);border-radius:11px;flex:0 0 auto;-webkit-app-region:no-drag;app-region:no-drag}
  .nav-tabs button{flex:1 1 0;min-width:0;border:0;border-radius:9px;padding:7px 4px;background:transparent;color:#5c645c;font-size:10px;font-weight:850;cursor:pointer;white-space:nowrap}
  .nav-tabs button.active{background:#17211b;color:#fff;box-shadow:0 4px 10px rgba(23,33,27,.16)}
  .tab-panel{display:none;flex-direction:column;gap:8px;min-height:0}
  .tab-panel.active{display:flex}
  .guide-steps{display:grid;gap:7px;margin-top:8px}
  .guide-step{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:8px;align-items:start;padding:8px 9px;background:#eee6d8;border-radius:10px;min-width:0}
  .guide-step .n{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#d9d0c0;color:#17211b;font-size:10px;font-weight:900;flex:0 0 auto}
  .guide-step.done .n{background:#3bab70;color:#fff}
  .guide-step.current .n{background:#e25832;color:#fff}
  .guide-step .body{min-width:0}
  .guide-step strong{display:block;font-size:11px;font-weight:850;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .guide-step small{display:block;margin-top:2px;color:#6b726b;font-size:10px;line-height:1.35;word-break:break-word}
  .guide-step button{padding:5px 8px;font-size:10px}
  .guide-tip{margin:0;padding:8px 10px;border-radius:10px;background:rgba(45,118,83,.08);border:1px solid rgba(45,118,83,.18);color:#2d4a3a;font-size:11px;line-height:1.45}
  .hint{margin:6px 0 0;color:#7a827a;font-size:10px;line-height:1.4}
  h2{font:700 12px Rockwell,serif;margin:0}
  .row{display:flex;gap:6px;align-items:center;min-width:0}
  .row.wrap{flex-wrap:wrap}
  input{flex:1 1 auto;min-width:0;border:1px solid rgba(23,33,27,.15);border-radius:8px;padding:7px 9px;background:white;font-size:12px}
  button{border:0;border-radius:8px;padding:7px 10px;background:#17211b;color:white;font-weight:800;font-size:11px;cursor:pointer;white-space:nowrap;flex:0 0 auto}
  button:disabled{opacity:.4;cursor:not-allowed}
  button.secondary{background:#e7ddcd;color:#17211b}
  button.ghost{background:transparent;color:#a43b25;padding:4px 6px}
  .checks{display:grid;gap:5px;margin-top:7px}
  .check{display:flex;align-items:center;gap:7px;padding:6px 8px;background:#eee6d8;border-radius:8px;font-size:11px;min-width:0}
  .check:before{content:"";width:7px;height:7px;border-radius:50%;background:#d35a3b;flex:0 0 auto}
  .check.ok:before{background:#3bab70}
  .check.warn:before{background:#e25832}
  .check.err:before{background:#a63b28}
  .check b{font-weight:800;flex:0 0 auto}
  .check span{flex:1 1 auto;margin-left:6px;color:#687068;font:10px "Cascadia Code",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;text-align:right}
  .check button{flex:0 0 auto;margin-left:8px;padding:5px 8px;font-size:10px}
  .update-row{display:flex;align-items:center;gap:6px;margin-top:6px;min-width:0}
  .update-row .check{flex:1 1 auto;margin:0}
  .pair{font:900 28px/1 monospace;letter-spacing:.18em;text-align:center;color:#e25832;margin:8px 0 4px;padding-left:.18em}
  .workspaces{display:grid;gap:5px;margin-top:7px}
  .workspace{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;background:#eee6d8;border-radius:8px;min-width:0}
  .workspace div{flex:1 1 auto;min-width:0;overflow:hidden}
  .workspace strong,.workspace small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .workspace small{color:#747a73;margin-top:1px;font-size:10px}
  .task-main{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}
  .engine-badge{width:18px;height:18px;border-radius:5px;object-fit:cover;flex:0 0 auto;background:#fff;box-shadow:0 0 0 1px rgba(23,33,27,.08)}
  .engine-filter{display:flex;align-items:center;gap:6px;margin-top:7px;flex-wrap:wrap}
  .engine-filter-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(23,33,27,.14);background:rgba(255,250,240,.72);color:#17211b;border-radius:10px;padding:5px 8px;cursor:pointer;font-weight:800;font-size:10px}
  .engine-filter-btn.active{border-color:rgba(45,118,83,.5);background:rgba(45,118,83,.1);box-shadow:0 0 0 2px rgba(45,118,83,.1)}
  .engine-filter-btn .engine-badge{width:16px;height:16px}
  .engine-filter-clear{border:0;background:transparent;color:#2d7653;padding:4px 6px;font-size:10px;font-weight:850;cursor:pointer}
  .activity-tabs{display:flex;gap:5px;overflow-x:auto;padding:2px 0 6px;margin-top:4px}
  .activity-tab{display:inline-flex;align-items:center;gap:5px;max-width:160px;border:1px solid rgba(23,33,27,.12);background:#eee6d8;color:#17211b;border-radius:9px;padding:5px 8px;font-size:10px;font-weight:800;cursor:pointer;flex:0 0 auto}
  .activity-tab.active{background:#17211b;color:#fff;border-color:#17211b}
  .activity-tab .engine-badge{width:14px;height:14px}
  .activity-tab span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px}
  .activity-tab .dot-mini{width:6px;height:6px;border-radius:50%;background:#9a9f98;flex:0 0 auto}
  .activity-tab .dot-mini.run{background:#3bab70;box-shadow:0 0 0 3px rgba(59,171,112,.16)}
  .empty{text-align:center;color:#888;padding:8px;font-size:11px}
  .stack{display:grid;gap:6px;margin-top:6px}
  .label{font-size:10px;font-weight:800;color:#6b726b;letter-spacing:.04em}
  pre.activity{margin:6px 0 0;max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#17211b;color:#e8eee8;border-radius:8px;padding:8px;font:10px/1.45 Cascadia Code,monospace}
  .footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 4px 0;border-top:1px solid rgba(23,33,27,.08);margin-top:2px;-webkit-app-region:no-drag;app-region:no-drag;flex-wrap:wrap}
  .footer .author{font-size:10px;color:#6b726b;line-height:1.35}
  .footer .author strong{color:#17211b}
  .footer .footer-actions{display:flex;gap:6px;align-items:center}
  .footer button.feedback{background:transparent;color:#e25832;border:1px solid rgba(226,88,50,.35);padding:5px 9px}
  .footer .lang-switch{display:inline-flex;border:1px solid rgba(23,33,27,.12);border-radius:8px;overflow:hidden}
  .footer .lang-switch button{border:0;border-radius:0;background:#eee6d8;color:#6b726b;padding:5px 8px;font-size:10px}
  .footer .lang-switch button.active{background:#17211b;color:#fff}
  </style></head><body><div class="frame"><main class="shell">
  <div class="titlebar">${iconDataUrl ? `<div class="mark"><img src="${iconDataUrl}" alt=""></div>` : `<div class="mark"></div>`}<div><h1 id="brandTitle">随码</h1><p id="brandTag">随时续上你的代码 · ${platformLabel}</p></div><div class="win-actions"><button type="button" id="openLogs" class="logs-btn" title="运行日志">日志</button><button type="button" id="winMin" title="最小化">–</button><button type="button" id="winClose" class="close" title="关闭">×</button></div></div>
  <section class="card" style="flex:0 0 auto"><div class="status"><b id="status">loading</b><span id="dot" class="dot"></span></div><p id="detail" class="detail">正在读取状态…</p><div class="meta" id="meta"></div></section>
  <nav class="nav-tabs" role="tablist" aria-label="客户端功能">
    <button type="button" role="tab" data-tab="guide" class="active" id="tabGuide">指引</button>
    <button type="button" role="tab" data-tab="env" id="tabEnv">环境</button>
    <button type="button" role="tab" data-tab="pair" id="tabPair">配对</button>
    <button type="button" role="tab" data-tab="ws" id="tabWs">工作区</button>
    <button type="button" role="tab" data-tab="tasks" id="tabTasks">任务</button>
  </nav>
  <div class="scroll">
  <div class="tab-panel active" data-panel="guide" id="panelGuide">
    <section class="card">
      <h2 id="guideTitle">快速上手</h2>
      <p class="guide-tip" id="guideTip">按下面步骤完成后，即可在网页端远程下发任务到本机编码引擎。</p>
      <div id="guideSteps" class="guide-steps"></div>
    </section>
  </div>
  <div class="tab-panel" data-panel="env" id="panelEnv">
    <section class="card"><div class="status"><h2 id="envTitle">本机环境</h2><button id="recheck" class="secondary">重新检测</button></div><p class="hint" id="envHint">先安装 Node（Codex 需要）与至少一个编码引擎 CLI，再去做配对。</p><div id="environment" class="checks"></div><div id="updateBox" class="update-row"></div></section>
  </div>
  <div class="tab-panel" data-panel="pair" id="panelPair">
    <section class="card"><h2 id="pairTitle">中继与配对</h2><p class="hint" id="pairHint">保存中继地址后生成配对码，在 Web 端输入即可绑定本机。</p><div class="stack"><div class="label" id="relayLabel">中继服务器</div><div class="row"><input id="relay" placeholder="https://vibe.demonrain.top"><button id="saveRelay" class="secondary">保存</button></div><div class="row"><button id="startPair">生成配对码</button></div><div id="pairBox"></div><div class="label" id="nameLabel">客户端名称</div><div class="row"><input id="displayName" placeholder="例如：公司电脑" maxlength="64"><button id="saveName" class="secondary">保存名称</button></div></div></section>
  </div>
  <div class="tab-panel" data-panel="ws" id="panelWs">
    <section class="card grow"><div class="status"><h2 id="wsTitle">允许的工作区</h2><button id="addWorkspace" class="secondary">添加目录</button></div><p class="hint" id="wsHint">只有白名单目录可被远程任务读写。至少添加一个项目路径。</p><div id="workspaces" class="workspaces"></div></section>
  </div>
  <div class="tab-panel" data-panel="tasks" id="panelTasks">
    <section class="card" id="activityBox" style="display:none"></section>
    <section class="card" id="taskBox"></section>
  </div>
  </div>
  <footer class="footer"><div class="author"><strong id="authorStrong">随码 AnytimeVibe</strong><br><span id="authorLine">作者 · demonrain · 开源项目</span></div><div class="footer-actions"><div class="lang-switch"><button type="button" id="langZh" class="active">中文</button><button type="button" id="langEn">EN</button></div><button type="button" id="feedback" class="feedback">反馈问题</button></div></footer>
  </main></div>
  <div id="logModal" class="log-modal-backdrop" aria-hidden="true">
    <div class="log-modal" role="dialog" aria-labelledby="logModalTitle">
      <header>
        <h3 id="logModalTitle">运行日志</h3>
        <div class="log-actions">
          <button type="button" id="logRefresh" class="secondary">刷新</button>
          <button type="button" id="logCopy" class="secondary">复制</button>
          <button type="button" id="logClear" class="secondary">清空</button>
          <button type="button" id="logOpenFile" class="secondary">打开文件</button>
          <button type="button" id="logClose">关闭</button>
        </div>
      </header>
      <div id="logView" class="log-view"></div>
      <footer id="logFooter">最近运行记录 · 便于排查连接与任务问题</footer>
    </div>
  </div>
  <script>
  (function(){
  var platformLabel=${JSON.stringify(platformLabel)};
  var initialState=${initialStateJson};
  var vendorLogos=${logoMapJson};
  var api=window.anytimeVibe;
  function engineLogo(engine){
    var src=vendorLogos&&vendorLogos[engine];
    if(!src) return '';
    return '<img class="engine-badge '+(engine||'')+'" src="'+src+'" alt="'+(engine||'')+'" width="18" height="18">';
  }
  function detectEngine(task){
    if(task&&task.engine) return task.engine;
    var title=String(task&&task.title||'');
    if(/^\\[claude\\]/i.test(title)) return 'claude';
    if(/^\\[grok\\]/i.test(title)) return 'grok';
    if(/^\\[cursor\\]/i.test(title)) return 'cursor';
    return 'codex';
  }
  var I18N={
    'zh-CN':{brand:'随码',tag:'随时续上你的代码 · '+platformLabel,authorStrong:'随码 AnytimeVibe',authorLine:'作者 · demonrain · 开源项目',feedback:'反馈问题',logs:'日志',logTitle:'运行日志',logRefresh:'刷新',logCopy:'复制',logClear:'清空',logOpenFile:'打开文件',logClose:'关闭',logEmpty:'暂无日志',logFooter:'最近运行记录 · 便于排查连接与任务问题',logCopied:'已复制到剪贴板',search:'搜索任务标题 / 路径 / 状态',relay:'任务接力',noTask:'暂无可接力任务',noMatch:'没有匹配的任务',latest:'已是最新',checking:'检查中',available:'发现新版本',downloading:'下载中',ready:'更新就绪',error:'更新失败',checkUpdate:'检查更新',installUpdate:'重启并更新',expand:'展开',collapse:'收起',open:'接力',tabGuide:'指引',tabEnv:'环境',tabPair:'配对',tabWs:'工作区',tabTasks:'任务',guideTitle:'快速上手',guideTip:'按下面步骤完成后，即可在网页端远程下发任务到本机编码引擎。',envTitle:'本机环境',envHint:'先安装 Node（Codex 需要）与至少一个编码引擎 CLI，再去做配对。',pairTitle:'中继与配对',pairHint:'保存中继地址后生成配对码，在 Web 端输入即可绑定本机。',relayLabel:'中继服务器',nameLabel:'客户端名称',wsTitle:'允许的工作区',wsHint:'只有白名单目录可被远程任务读写。至少添加一个项目路径。',stepEnv:'安装前置环境',stepEnvDesc:'安装 Node.js（Codex 需要）以及 Codex / Claude / Grok / Cursor 中至少一个 CLI 并登录。',stepRelay:'配置中继服务器',stepRelayDesc:'确认中继地址正确并保存（默认体验站可用）。',stepPair:'生成配对码并绑定',stepPairDesc:'点击生成配对码，在网页「添加主机」中输入。码约 10 分钟有效。',stepWs:'添加工作区目录',stepWsDesc:'允许至少一个本机项目目录，远程任务才能在该路径执行。',stepReady:'开始使用',stepReadyDesc:'网页端在线后即可新建任务。本页「任务」可接力到本机终端。',goEnv:'去环境',goPair:'去配对',goWs:'去工作区',goTasks:'看任务',done:'完成',todo:'待办',onlineReady:'已在线，可在网页下发任务。'},
    en:{brand:'AnytimeVibe',tag:'Pick up your code · '+platformLabel,authorStrong:'AnytimeVibe',authorLine:'Author · demonrain · open source',feedback:'Feedback',logs:'Logs',logTitle:'Runtime logs',logRefresh:'Refresh',logCopy:'Copy',logClear:'Clear',logOpenFile:'Open file',logClose:'Close',logEmpty:'No logs yet',logFooter:'Recent runtime events for troubleshooting',logCopied:'Copied to clipboard',search:'Search title / path / status',relay:'Task handoff',noTask:'No tasks yet',noMatch:'No matches',latest:'Up to date',checking:'Checking',available:'Update available',downloading:'Downloading',ready:'Ready to install',error:'Update failed',checkUpdate:'Check update',installUpdate:'Restart & install',expand:'Expand',collapse:'Collapse',open:'Open',tabGuide:'Guide',tabEnv:'Setup',tabPair:'Pair',tabWs:'Folders',tabTasks:'Tasks',guideTitle:'Get started',guideTip:'Finish the steps below so the web app can send coding tasks to this machine.',envTitle:'Local environment',envHint:'Install Node (for Codex) and at least one coding CLI, then pair.',pairTitle:'Relay & pairing',pairHint:'Save the relay URL, generate a code, and enter it on the web.',relayLabel:'Relay server',nameLabel:'Client name',wsTitle:'Allowed workspaces',wsHint:'Only allowlisted folders can be used by remote tasks. Add at least one project path.',stepEnv:'Install prerequisites',stepEnvDesc:'Install Node.js (needed for Codex) and at least one of Codex / Claude / Grok / Cursor CLI, then sign in.',stepRelay:'Configure relay',stepRelayDesc:'Confirm and save the relay URL (public demo works by default).',stepPair:'Pair with the web app',stepPairDesc:'Generate a pairing code and enter it under Add host on the web. Codes expire in ~10 minutes.',stepWs:'Allow a workspace folder',stepWsDesc:'Add at least one local project directory for remote tasks to run in.',stepReady:'You are ready',stepReadyDesc:'When online, create tasks from the web. Use Tasks here to hand off to a local terminal.',goEnv:'Setup',goPair:'Pair',goWs:'Folders',goTasks:'Tasks',done:'Done',todo:'Todo',onlineReady:'Online — send tasks from the web.'}
  };
  var locale=(function(){try{return localStorage.getItem('anytimevibe-locale')==='en'?'en':'zh-CN';}catch(e){return 'zh-CN';}})();
  function t(key){return (I18N[locale]&&I18N[locale][key])||I18N.en[key]||key}
  var activeTab=(function(){try{return localStorage.getItem('anytimevibe-tab')||'guide';}catch(e){return 'guide';}})();
  function setActiveTab(name){
    activeTab=name||'guide';
    try{localStorage.setItem('anytimevibe-tab',activeTab);}catch(e){}
    document.querySelectorAll('.nav-tabs [data-tab]').forEach(function(btn){
      btn.classList.toggle('active',btn.getAttribute('data-tab')===activeTab);
    });
    document.querySelectorAll('.tab-panel').forEach(function(panel){
      panel.classList.toggle('active',panel.getAttribute('data-panel')===activeTab);
    });
  }
  function applyLocale(){
    var el;
    if(el=document.querySelector('#brandTitle')) el.textContent=t('brand');
    if(el=document.querySelector('#brandTag')) el.textContent=t('tag');
    if(el=document.querySelector('#authorStrong')) el.textContent=t('authorStrong');
    if(el=document.querySelector('#authorLine')) el.textContent=t('authorLine');
    if(el=document.querySelector('#feedback')) el.textContent=t('feedback');
    if(el=document.querySelector('#openLogs')) el.textContent=t('logs');
    if(el=document.querySelector('#logModalTitle')) el.textContent=t('logTitle');
    if(el=document.querySelector('#logRefresh')) el.textContent=t('logRefresh');
    if(el=document.querySelector('#logCopy')) el.textContent=t('logCopy');
    if(el=document.querySelector('#logClear')) el.textContent=t('logClear');
    if(el=document.querySelector('#logOpenFile')) el.textContent=t('logOpenFile');
    if(el=document.querySelector('#logClose')) el.textContent=t('logClose');
    if(el=document.querySelector('#logFooter')) el.textContent=t('logFooter');
    if(el=document.querySelector('#tabGuide')) el.textContent=t('tabGuide');
    if(el=document.querySelector('#tabEnv')) el.textContent=t('tabEnv');
    if(el=document.querySelector('#tabPair')) el.textContent=t('tabPair');
    if(el=document.querySelector('#tabWs')) el.textContent=t('tabWs');
    if(el=document.querySelector('#tabTasks')) el.textContent=t('tabTasks');
    if(el=document.querySelector('#guideTitle')) el.textContent=t('guideTitle');
    if(el=document.querySelector('#guideTip')) el.textContent=t('guideTip');
    if(el=document.querySelector('#envTitle')) el.textContent=t('envTitle');
    if(el=document.querySelector('#envHint')) el.textContent=t('envHint');
    if(el=document.querySelector('#pairTitle')) el.textContent=t('pairTitle');
    if(el=document.querySelector('#pairHint')) el.textContent=t('pairHint');
    if(el=document.querySelector('#relayLabel')) el.textContent=t('relayLabel');
    if(el=document.querySelector('#nameLabel')) el.textContent=t('nameLabel');
    if(el=document.querySelector('#wsTitle')) el.textContent=t('wsTitle');
    if(el=document.querySelector('#wsHint')) el.textContent=t('wsHint');
    if(el=document.querySelector('#langZh')) el.classList.toggle('active',locale==='zh-CN');
    if(el=document.querySelector('#langEn')) el.classList.toggle('active',locale==='en');
  }
  var status=document.querySelector('#status');
  var dot=document.querySelector('#dot');
  var detail=document.querySelector('#detail');
  var relay=document.querySelector('#relay');
  var displayName=document.querySelector('#displayName');
  var pairBox=document.querySelector('#pairBox');
  var startPair=document.querySelector('#startPair');
  var workspaces=document.querySelector('#workspaces');
  var meta=document.querySelector('#meta');
  var environment=document.querySelector('#environment');
  var updateBox=document.querySelector('#updateBox');
  var activityBox=document.querySelector('#activityBox');
  var taskBox=document.querySelector('#taskBox');
  var tasksOpen=false;
  var lastTasks=[];
  var taskQuery='';
  var engineFilter=null;
  var lastActivities=[];
  var selectedActivityId=null;
  var lastPaintState=null;
  var guidedOnce=false;
  function escapeHtml(value){return String(value||'').replace(/[&<>"']/g,function(char){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[char];});}
  function renderGuide(state){
    var box=document.querySelector('#guideSteps');
    if(!box) return;
    state=state||{};
    var env=state.environment||{};
    var engines=state.availableEngines||[];
    var anyEngine=!!env.codexCompatible||engines.some(function(item){return item&&item.ready;});
    var hasRelay=!!(state.relayUrl&&String(state.relayUrl).trim());
    var paired=!!state.hostId||state.status==='online'||state.status==='connecting';
    var online=state.status==='online';
    var hasWs=!!(state.workspaces&&state.workspaces.length);
    var steps=[
      {id:'env',done:anyEngine,title:t('stepEnv'),desc:t('stepEnvDesc'),action:'env',actionLabel:t('goEnv')},
      {id:'relay',done:hasRelay,title:t('stepRelay'),desc:t('stepRelayDesc'),action:'pair',actionLabel:t('goPair')},
      {id:'pair',done:paired,title:t('stepPair'),desc:t('stepPairDesc'),action:'pair',actionLabel:t('goPair')},
      {id:'ws',done:hasWs,title:t('stepWs'),desc:t('stepWsDesc'),action:'ws',actionLabel:t('goWs')},
      {id:'ready',done:online&&hasWs&&anyEngine,title:t('stepReady'),desc:online?t('onlineReady'):t('stepReadyDesc'),action:'tasks',actionLabel:t('goTasks')}
    ];
    var currentIdx=steps.findIndex(function(s){return !s.done;});
    if(currentIdx<0) currentIdx=steps.length-1;
    box.innerHTML=steps.map(function(step,idx){
      var cls='guide-step'+(step.done?' done':'')+(idx===currentIdx&&!step.done?' current':'');
      var badge=step.done?t('done'):String(idx+1);
      var btn=(!step.done||step.id==='ready')
        ? '<button type="button" class="secondary" data-goto="'+escapeHtml(step.action)+'">'+escapeHtml(step.actionLabel)+'</button>'
        : '<span class="label">'+escapeHtml(t('done'))+'</span>';
      return '<div class="'+cls+'"><span class="n">'+escapeHtml(badge)+'</span><div class="body"><strong>'+escapeHtml(step.title)+'</strong><small>'+escapeHtml(step.desc)+'</small></div>'+btn+'</div>';
    }).join('');
    box.querySelectorAll('[data-goto]').forEach(function(btn){
      btn.addEventListener('click',function(){ setActiveTab(btn.getAttribute('data-goto')||'guide'); });
    });
    // First successful paint: jump to first incomplete step's tab if still on default guide.
    if(!guidedOnce){
      guidedOnce=true;
      try{
        var stored=localStorage.getItem('anytimevibe-tab');
        if(!stored){
          var first=steps.find(function(s){return !s.done;});
          if(first&&first.action) setActiveTab(first.action==='env'||first.action==='pair'||first.action==='ws'||first.action==='tasks'?first.action:'guide');
          else setActiveTab('guide');
        }
      }catch(e){}
    }
  }
  function formatActivityTime(ts){
    var n=Number(ts)||0;
    if(!n) return '';
    if(n>1e12) n=n/1000;
    try{
      return new Date(n*1000).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    }catch(e){ return ''; }
  }
  function paint(state){
    try{
      if(!state) return;
      lastPaintState=state;
      if(status) status.textContent=state.status||'';
      if(dot) dot.className='dot '+(state.status==='online'?'online':'');
      if(detail) detail.textContent=state.detail||'';
      if(relay && document.activeElement!==relay) relay.value=state.relayUrl||'';
      if(displayName && document.activeElement!==displayName) displayName.value=state.displayName||'';
      if(meta) meta.textContent='客户端 v'+${JSON.stringify(PRODUCT_VERSION)}+(state.hostId?' · '+String(state.hostId).slice(0,8):'');
      var env=state.environment||{nodeInstalled:false,codexCompatible:false,codexInstalled:false};
      var engines=state.availableEngines||[];
      var nodeAction=!env.nodeInstalled?'<button data-install="node" class="secondary">一键安装</button>':'';
      // Codex install needs npm; only show after Node is present (unlike Claude/Grok).
      var codexAction=env.nodeInstalled&&!env.codexCompatible?'<button data-install="codex" class="secondary">'+(env.codexInstalled?'安装兼容版':'一键安装')+'</button>':'';
      if(environment){
        var engineExtra=engines.filter(function(item){return item.engine!=='codex';}).map(function(item){
          var label=item.engine==='claude'?'Claude Code':(item.engine==='cursor'?'Cursor Agent':'Grok Build');
          var action=!item.ready?'<button data-install="'+escapeHtml(item.engine)+'" class="secondary">一键安装</button>':'';
          return '<div class="check '+(item.ready?'ok':'')+'"><b>'+escapeHtml(label)+'</b><span>'+escapeHtml(item.version||item.detail||(item.ready?'就绪':'未安装'))+'</span>'+action+'</div>';
        }).join('');
        environment.innerHTML='<div class="check '+(env.nodeInstalled?'ok':'')+'"><b>Node.js</b><span>'+escapeHtml(env.nodeVersion||'未安装')+'</span>'+nodeAction+'</div><div class="check '+(env.codexCompatible?'ok':'')+'"><b>Codex CLI</b><span>'+escapeHtml(env.codexVersion||(env.codexInstalled?'版本不兼容':'未安装'))+'</span>'+codexAction+'</div>'+engineExtra;
        environment.querySelectorAll('button[data-install]').forEach(function(button){
          button.addEventListener('click',function(){
            if(!api) return;
            var target=button.getAttribute('data-install');
            button.disabled=true;
            api.installEnvironment(target).catch(function(error){alert(error&&error.message?error.message:String(error));}).finally(function(){try{button.disabled=false;}catch(e){}});
          });
        });
      }
      var anyEngineReady=env.codexCompatible||engines.some(function(item){return item.ready;});
      if(startPair) startPair.disabled=!anyEngineReady||!state.relayUrl;
      if(pairBox) pairBox.innerHTML=state.pairingCode?'<div class="pair">'+escapeHtml(state.pairingCode)+'</div><p class="detail">'+(locale==='en'?'Enter this code on the web. Expires in ~10 minutes.':'在 Web 端输入配对码，约 10 分钟后失效。')+'</p>':'';
      if(workspaces){
        workspaces.innerHTML=(state.workspaces&&state.workspaces.length)?state.workspaces.map(function(w){return '<div class="workspace"><div><strong>'+escapeHtml(w.name)+'</strong><small>'+escapeHtml(w.path)+'</small></div><button class="ghost" data-id="'+escapeHtml(w.id)+'">'+(locale==='en'?'Remove':'移除')+'</button></div>';}).join(''):'<div class="empty">'+(locale==='en'?'No folders allowed yet':'尚未允许任何目录')+'</div>';
        workspaces.querySelectorAll('button[data-id]').forEach(function(button){
          button.addEventListener('click',function(){ if(api) api.removeWorkspace(button.getAttribute('data-id')); });
        });
      }
      renderUpdate(state.update||{status:'idle'});
      lastActivities=state.activities&&state.activities.length?state.activities:(state.activity?[state.activity]:[]);
      selectedActivityId=state.selectedActivityThreadId||(lastActivities[0]&&lastActivities[0].threadId)||null;
      renderActivity(lastActivities, selectedActivityId);
      renderTasks(state.tasks||[]);
      renderGuide(state);
    }catch(err){
      if(detail) detail.textContent='界面渲染异常：'+(err&&err.message?err.message:String(err));
      console.error(err);
    }
  }
  function renderUpdate(update){
    if(!updateBox) return;
    update=update||{status:'idle'};
    var labels={idle:t('latest'),checking:t('checking'),available:t('available'),downloading:t('downloading'),ready:t('ready'),error:t('error')};
    var tone=update.status==='idle'?'ok':update.status==='error'?'err':(update.status==='available'||update.status==='downloading'||update.status==='ready')?'warn':'';
    var text=update.version||update.message||(update.progress!==undefined?update.progress+'%':'');
    updateBox.innerHTML='<div class="check '+tone+'"><b>'+(labels[update.status]||update.status)+'</b><span>'+escapeHtml(text)+'</span></div><button id="checkUpdate" class="secondary">'+escapeHtml(t('checkUpdate'))+'</button>'+(update.status==='ready'?'<button id="installUpdate">'+escapeHtml(t('installUpdate'))+'</button>':'');
    var checkBtn=document.querySelector('#checkUpdate');
    var installBtn=document.querySelector('#installUpdate');
    if(checkBtn&&api) checkBtn.addEventListener('click',function(){api.checkUpdate();});
    if(installBtn&&api) installBtn.addEventListener('click',function(){api.installUpdate();});
  }
  function renderActivity(activities, selectedId){
    if(!activityBox) return;
    activities=activities||[];
    if(!activities.length){activityBox.style.display='none';activityBox.innerHTML='';return;}
    activityBox.style.display='block';
    var labels={processing:'处理中',completed:'已完成',failed:'失败',interrupted:'已停止'};
    var selected=activities.find(function(item){return item.threadId===selectedId;})||activities[0];
    var tabs=activities.map(function(item){
      var eng=item.engine||detectEngine(item);
      var active=selected&&item.threadId===selected.threadId;
      return '<button type="button" class="activity-tab'+(active?' active':'')+'" data-activity="'+escapeHtml(item.threadId)+'">'
        +engineLogo(eng)
        +'<span class="dot-mini'+(item.status==='processing'?' run':'')+'"></span>'
        +'<span title="'+escapeHtml(item.title||'')+'">'+escapeHtml(item.title||item.threadId.slice(0,8))+'</span>'
        +'</button>';
    }).join('');
    activityBox.innerHTML='<div class="status"><h2>当前远程任务</h2><b>'+(labels[selected.status]||selected.status)+'</b></div>'
      +(activities.length>1?'<div class="activity-tabs">'+tabs+'</div>':'')
      +'<p class="detail">'+engineLogo(selected.engine||detectEngine(selected))+' <strong>'+escapeHtml(selected.title)+'</strong> · '+escapeHtml(selected.prompt)+'</p>'
      +'<pre class="activity">'+escapeHtml(selected.output||'等待引擎输出…')+'</pre>';
    var output=activityBox.querySelector('pre');
    if(output) output.scrollTop=output.scrollHeight;
    activityBox.querySelectorAll('[data-activity]').forEach(function(button){
      button.addEventListener('click',function(){
        var id=button.getAttribute('data-activity');
        if(!id) return;
        selectedActivityId=id;
        if(api&&api.selectActivity){
          api.selectActivity(id).then(function(state){ if(state) paint(state); }).catch(function(){
            renderActivity(lastActivities, id);
          });
        } else {
          renderActivity(lastActivities, id);
        }
      });
    });
  }
  function renderTasks(tasks){
    if(!taskBox) return;
    lastTasks=(tasks||[]).slice().sort(function(a,b){return (Number(b.updatedAt)||0)-(Number(a.updatedAt)||0);});
    var q=taskQuery.trim().toLowerCase();
    var filtered=lastTasks.filter(function(task){
      var eng=detectEngine(task);
      if(engineFilter&&eng!==engineFilter) return false;
      if(!q) return true;
      var hay=((task.title||'')+' '+(task.cwd||'')+' '+(task.status||'')+' '+(eng||'')).toLowerCase();
      return hay.indexOf(q)>=0;
    });
    var counts={codex:0,claude:0,grok:0,cursor:0};
    lastTasks.forEach(function(task){ var e=detectEngine(task); if(counts[e]!=null) counts[e]+=1; });
    var filterBar='<div class="engine-filter" role="toolbar" aria-label="engine filter">'
      +['codex','claude','grok','cursor'].map(function(eng){
        return '<button type="button" class="engine-filter-btn'+(engineFilter===eng?' active':'')+'" data-engine-filter="'+eng+'" title="'+eng+' · '+counts[eng]+'">'
          +engineLogo(eng)+'<span>'+counts[eng]+'</span></button>';
      }).join('')
      +(engineFilter?'<button type="button" class="engine-filter-clear" data-engine-filter-clear="1">'+(locale==='en'?'All':'全部')+'</button>':'')
      +'</div>';
    taskBox.innerHTML='<div class="status"><h2>'+escapeHtml(t('relay'))+'</h2><button id="toggleTasks" class="secondary">'+(tasksOpen?t('collapse'):t('expand'))+' · '+filtered.length+(q||engineFilter?'/'+lastTasks.length:'')+'</button></div>'
      +(tasksOpen?filterBar:'')
      +(tasksOpen?'<div class="stack" style="margin-top:7px"><input id="taskSearch" placeholder="'+escapeHtml(t('search'))+'" value="'+escapeHtml(taskQuery)+'"></div>':'')
      +(tasksOpen?(filtered.length?'<div class="workspaces" style="margin-top:7px">'+filtered.map(function(task){
          var engine=detectEngine(task);
          var when=formatActivityTime(task.updatedAt);
          return '<div class="workspace"><div class="task-main">'+engineLogo(engine)+'<div><strong>'+escapeHtml(task.title)+'</strong><small>'+escapeHtml(task.cwd)+' · '+escapeHtml(task.status)+(when?' · '+when:'')+'</small></div></div><button data-relay="'+escapeHtml(task.threadId)+'">'+escapeHtml(t('open'))+'</button></div>';
        }).join('')+'</div>':'<div class="empty">'+(q||engineFilter?t('noMatch'):t('noTask'))+'</div>'):'');
    var toggle=document.querySelector('#toggleTasks');
    if(toggle) toggle.addEventListener('click',function(){
      tasksOpen=!tasksOpen;
      renderTasks(lastTasks);
      // Expand: re-read local Codex threads (not web-driven).
      if(tasksOpen&&api&&api.refreshTasks){
        api.refreshTasks().then(function(state){ if(state&&state.tasks) paint(state); }).catch(function(){});
      }
    });
    var search=document.querySelector('#taskSearch');
    if(search){
      search.addEventListener('input',function(){taskQuery=search.value;renderTasks(lastTasks);var el=document.querySelector('#taskSearch');if(el){el.focus();var n=el.value.length;try{el.setSelectionRange(n,n);}catch(e){}}});
    }
    taskBox.querySelectorAll('[data-engine-filter]').forEach(function(button){
      button.addEventListener('click',function(){
        var eng=button.getAttribute('data-engine-filter');
        engineFilter=engineFilter===eng?null:eng;
        renderTasks(lastTasks);
      });
    });
    var clearFilter=taskBox.querySelector('[data-engine-filter-clear]');
    if(clearFilter) clearFilter.addEventListener('click',function(){ engineFilter=null; renderTasks(lastTasks); });
    taskBox.querySelectorAll('[data-relay]').forEach(function(button){
      button.addEventListener('click',function(){
        if(!api) return;
        button.disabled=true;
        api.relayTask(button.getAttribute('data-relay')).then(function(){
          if(detail) detail.textContent='已打开接力终端。';
        }).catch(function(error){
          alert(error&&error.message?error.message:String(error));
        }).finally(function(){ try{ button.disabled=false; }catch(e){} });
      });
    });
  }
  var logEntries=[];
  var logStickBottom=true;
  var logView=document.querySelector('#logView');
  var logModal=document.querySelector('#logModal');
  function formatLogTs(ts){
    try{
      var d=new Date(ts);
      if(isNaN(d.getTime())) return String(ts||'');
      return d.toLocaleTimeString(undefined,{hour12:false})+'.'+String(d.getMilliseconds()).padStart(3,'0');
    }catch(e){ return String(ts||''); }
  }
  function renderLogView(){
    if(!logView) return;
    if(!logEntries.length){
      logView.innerHTML='<div class="log-line info"><span class="msg">'+escapeHtml(t('logEmpty'))+'</span></div>';
      return;
    }
    var html=logEntries.map(function(entry){
      var level=entry.level==='error'||entry.level==='warn'?entry.level:'info';
      return '<div class="log-line '+level+'"><span class="ts">'+escapeHtml(formatLogTs(entry.ts))+'</span><span class="lvl">['+escapeHtml(level)+']</span> <span class="msg">'+escapeHtml(entry.message||'')+'</span></div>';
    }).join('');
    var nearBottom=logView.scrollHeight-logView.scrollTop-logView.clientHeight<48;
    logView.innerHTML=html;
    if(logStickBottom||nearBottom) logView.scrollTop=logView.scrollHeight;
  }
  function loadLogs(){
    if(!api||!api.getLogs) return Promise.resolve();
    return api.getLogs().then(function(list){
      logEntries=Array.isArray(list)?list:[];
      renderLogView();
    }).catch(function(err){
      logEntries=[{ts:new Date().toISOString(),level:'error',message:'读取日志失败：'+(err&&err.message?err.message:String(err))}];
      renderLogView();
    });
  }
  function openLogModal(){
    if(!logModal) return;
    logModal.classList.add('open');
    logModal.setAttribute('aria-hidden','false');
    logStickBottom=true;
    loadLogs();
  }
  function closeLogModal(){
    if(!logModal) return;
    logModal.classList.remove('open');
    logModal.setAttribute('aria-hidden','true');
  }
  function bindUi(){
    var el;
    document.querySelectorAll('.nav-tabs [data-tab]').forEach(function(btn){
      btn.addEventListener('click',function(){ setActiveTab(btn.getAttribute('data-tab')||'guide'); });
    });
    setActiveTab(activeTab);
    if((el=document.querySelector('#saveRelay'))&&api) el.addEventListener('click',function(){api.setRelayUrl(relay.value);});
    if((el=document.querySelector('#saveName'))&&api) el.addEventListener('click',function(){api.setDisplayName(displayName.value);});
    if(startPair&&api) startPair.addEventListener('click',function(){api.startPairing();});
    if((el=document.querySelector('#addWorkspace'))&&api) el.addEventListener('click',function(){api.addWorkspace();});
    if((el=document.querySelector('#recheck'))&&api) el.addEventListener('click',function(){
      el.disabled=true;
      if(detail) detail.textContent=locale==='en'?'Detecting Node / Codex / Claude / Grok / Cursor…':'正在检测 Node / Codex / Claude / Grok / Cursor…';
      Promise.resolve(api.checkEnvironment()).then(function(state){
        if(state) paint(state);
      }).catch(function(error){
        alert(error&&error.message?error.message:String(error));
      }).finally(function(){ try{ el.disabled=false; }catch(e){} });
    });
    if((el=document.querySelector('#winMin'))&&api) el.addEventListener('click',function(){api.windowMinimize();});
    if((el=document.querySelector('#winClose'))&&api) el.addEventListener('click',function(){api.windowClose();});
    if((el=document.querySelector('#feedback'))&&api) el.addEventListener('click',function(){api.openFeedback();});
    if(el=document.querySelector('#openLogs')) el.addEventListener('click',function(){ openLogModal(); });
    if(el=document.querySelector('#logClose')) el.addEventListener('click',function(){ closeLogModal(); });
    if(logModal) logModal.addEventListener('click',function(ev){ if(ev.target===logModal) closeLogModal(); });
    if(logView) logView.addEventListener('scroll',function(){
      logStickBottom=logView.scrollHeight-logView.scrollTop-logView.clientHeight<48;
    });
    if((el=document.querySelector('#logRefresh'))&&api) el.addEventListener('click',function(){ loadLogs(); });
    if((el=document.querySelector('#logCopy'))&&api) el.addEventListener('click',function(){
      var text=logEntries.map(function(e){return (e.ts||'')+' ['+(e.level||'info')+'] '+(e.message||'');}).join('\\n');
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(function(){ alert(t('logCopied')); }).catch(function(){ prompt('Copy logs:', text); });
      } else {
        prompt('Copy logs:', text);
      }
    });
    if((el=document.querySelector('#logClear'))&&api) el.addEventListener('click',function(){
      api.clearLogs().then(function(list){
        logEntries=Array.isArray(list)?list:[];
        renderLogView();
      }).catch(function(error){ alert(error&&error.message?error.message:String(error)); });
    });
    if((el=document.querySelector('#logOpenFile'))&&api) el.addEventListener('click',function(){
      api.openLogFile().catch(function(error){ alert(error&&error.message?error.message:String(error)); });
    });
    if(el=document.querySelector('#langZh')) el.addEventListener('click',function(){locale='zh-CN';try{localStorage.setItem('anytimevibe-locale',locale);}catch(e){} applyLocale(); paint(lastPaintState||initialState); refresh();});
    if(el=document.querySelector('#langEn')) el.addEventListener('click',function(){locale='en';try{localStorage.setItem('anytimevibe-locale',locale);}catch(e){} applyLocale(); paint(lastPaintState||initialState); refresh();});
  }
  function refresh(){
    if(!api||!api.getState) return;
    api.getState().then(function(state){ paint(state); }).catch(function(err){
      if(detail) detail.textContent='读取状态失败：'+(err&&err.message?err.message:String(err));
    });
  }
  applyLocale();
  paint(initialState);
  bindUi();
  if(!api){
    if(detail) detail.textContent='预加载桥接失败：window.anytimeVibe 不可用。请重装客户端。';
  } else {
    try{ api.onState(function(state){ paint(state); }); }catch(e){ console.error(e); }
    try{
      if(api.onLog) api.onLog(function(entry){
        if(!entry) return;
        logEntries.push(entry);
        if(logEntries.length>1000) logEntries=logEntries.slice(-1000);
        if(logModal&&logModal.classList.contains('open')) renderLogView();
      });
    }catch(e){ console.error(e); }
    refresh();
  }
  })();
  </script></body></html>`;
}


async function loadConfig(): Promise<void> {
  configPath = path.join(app.getPath("userData"), "agent-config.json");
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8")) as AgentConfig;
  } catch {
    config = {
      relayUrl: process.env.ANYTIMEVIBE_RELAY_URL ?? DEFAULT_RELAY_URL,
      agentId: crypto.randomUUID(),
      displayName: os.hostname(),
      workspaces: [],
      sequence: 0
    };
  }
  let dirty = false;
  if (!config.agentId) {
    config.agentId = crypto.randomUUID();
    dirty = true;
  }
  // Local test: ANYTIMEVIBE_RELAY_URL always wins so dev:agent:local does not stick to prod.
  const envRelay = process.env.ANYTIMEVIBE_RELAY_URL?.trim().replace(/\/$/, "");
  if (envRelay && /^https?:\/\//.test(envRelay) && config.relayUrl !== envRelay) {
    config.relayUrl = envRelay;
    dirty = true;
  }
  if (!config.relayUrl) {
    config.relayUrl = envRelay || DEFAULT_RELAY_URL;
    dirty = true;
  }
  if (!config.displayName?.trim()) {
    config.displayName = os.hostname();
    dirty = true;
  }
  config.workspaces ??= [];
  config.sequence ??= 0;
  if (dirty) await saveConfig();
  publicState = {
    ...publicState,
    relayUrl: config.relayUrl,
    displayName: resolvedDisplayName(),
    workspaces: config.workspaces
  };
}

// ---------------------------------------------------------------------------
// Toolchain discovery / install — platform implementations are deliberately
// separate so Windows fixes never change macOS behavior (and vice versa).
// ---------------------------------------------------------------------------

let cachedMacLoginPath: string | null = null;
let cachedWindowsPath: string | null = null;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---- macOS PATH (login shell + Homebrew/nvm) ----

/** GUI apps on macOS often miss Homebrew/nvm PATH; rebuild from login shell + common locations. */
async function resolveMacLoginPath(): Promise<string> {
  if (cachedMacLoginPath) return cachedMacLoginPath;
  const parts = new Set((process.env.PATH ?? "").split(":").filter(Boolean));
  const home = os.homedir();
  for (const dir of [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".nvm", "current", "bin"),
    path.join(home, ".fnm", "current", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, "Library", "Application Support", "fnm", "aliases", "default")
  ]) {
    parts.add(dir);
  }
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    try {
      const result = await execFileAsync(shell, ["-ilc", "printf %s \"$PATH\""], {
        env: process.env,
        timeout: 8_000,
        maxBuffer: 1024 * 1024
      });
      for (const segment of String(result.stdout).trim().split(":")) {
        if (segment) parts.add(segment);
      }
      break;
    } catch {
      // try next shell
    }
  }
  cachedMacLoginPath = [...parts].join(":");
  return cachedMacLoginPath;
}

async function applyMacLoginPathToProcess(): Promise<void> {
  if (process.platform !== "darwin") return;
  cachedMacLoginPath = null;
  const home = os.homedir();
  const extras = [
    path.join(home, ".grok", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ].join(":");
  const login = await resolveMacLoginPath();
  process.env.PATH = `${extras}:${login}`;
}

async function findOnMacPath(command: string): Promise<string | null> {
  const loginPath = await resolveMacLoginPath();
  const home = os.homedir();
  const candidates: string[] = [];
  for (const dir of loginPath.split(":")) {
    if (dir) candidates.push(path.join(dir, command));
  }
  candidates.unshift(
    path.join(home, ".grok", "bin", command),
    path.join(home, ".local", "bin", command),
    path.join(home, ".claude", "local", command),
    path.join("/opt/homebrew/bin", command),
    path.join("/usr/local/bin", command),
    path.join("/usr/bin", command)
  );
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await pathExists(candidate)) return candidate;
  }
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    try {
      const result = await execFileAsync(shell, ["-ilc", `command -v ${command}`], {
        env: { ...process.env, PATH: loginPath },
        timeout: 8_000
      });
      const found = String(result.stdout).trim().split(/\r?\n/).find(Boolean);
      if (found && !found.includes("not found") && await pathExists(found)) return found;
    } catch {
      // try next shell
    }
  }
  return null;
}

async function macCommandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const loginPath = await resolveMacLoginPath();
    const result = await execFileAsync(command, args, {
      env: { ...process.env, PATH: loginPath },
      timeout: 8_000
    });
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return text || null;
  } catch {
    return null;
  }
}

// ---- Windows PATH (registry + common Node/npm dirs) ----

function expandWindowsEnvVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? "");
}

async function readWindowsRegistryPath(rootKey: string): Promise<string[]> {
  try {
    const result = await execFileAsync("reg.exe", ["query", rootKey, "/v", "Path"], {
      windowsHide: true,
      timeout: 5_000
    });
    const line = String(result.stdout)
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => /^Path\s+REG_/i.test(item));
    if (!line) return [];
    const value = line.replace(/^Path\s+REG_\w+\s+/i, "").trim();
    return expandWindowsEnvVars(value).split(";").map((part) => part.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** GUI apps on Windows often inherit a stripped PATH; rebuild from registry + Node install dirs. */
async function resolveWindowsPath(): Promise<string> {
  if (cachedWindowsPath) return cachedWindowsPath;
  const parts = new Set((process.env.PATH ?? "").split(";").filter(Boolean));
  const home = os.homedir();
  for (const dir of await readWindowsRegistryPath("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")) parts.add(dir);
  for (const dir of await readWindowsRegistryPath("HKCU\\Environment")) parts.add(dir);
  for (const dir of [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs"),
    path.join(process.env.APPDATA || "", "npm"),
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "AppData", "Local", "fnm"),
    path.join(home, ".fnm"),
    path.join(home, "scoop", "shims"),
    path.join(home, "AppData", "Local", "Programs", "fnm")
  ]) {
    if (dir) parts.add(dir);
  }
  cachedWindowsPath = [...parts].join(";");
  return cachedWindowsPath;
}

async function applyWindowsPathToProcess(): Promise<void> {
  if (process.platform !== "win32") return;
  cachedWindowsPath = null;
  process.env.PATH = await resolveWindowsPath();
}

async function findOnWindowsPath(command: string): Promise<string | null> {
  const winPath = await resolveWindowsPath();
  try {
    const result = await execFileAsync("where.exe", [command], {
      env: { ...process.env, PATH: winPath },
      windowsHide: true,
      timeout: 8_000
    });
    const found = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (found) return found;
  } catch {
    // fall through
  }
  const names = /\.(cmd|exe|bat)$/i.test(command)
    ? [command]
    : [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`];
  for (const dir of winPath.split(";")) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await pathExists(candidate)) return candidate;
    }
  }
  return null;
}

async function windowsCommandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const winPath = await resolveWindowsPath();
    const result = await execFileAsync(process.env.ComSpec ?? "cmd.exe", windowsCmdArguments(command, args), {
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env, PATH: winPath },
      timeout: 15_000
    });
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return text || null;
  } catch {
    return null;
  }
}

// ---- Shared thin dispatchers (no platform-specific logic inside) ----

/** Apply platform tool PATH for child processes. Windows and macOS implementations are independent. */
async function applyLoginPathToProcess(): Promise<void> {
  if (process.platform === "win32") {
    await applyWindowsPathToProcess();
    return;
  }
  if (process.platform === "darwin") {
    await applyMacLoginPathToProcess();
  }
}

async function findOnPath(command: string): Promise<string | null> {
  if (process.platform === "win32") return findOnWindowsPath(command);
  if (process.platform === "darwin") return findOnMacPath(command);
  return null;
}

async function commandVersion(command: string, args: string[]): Promise<string | null> {
  if (process.platform === "win32") return windowsCommandVersion(command, args);
  if (process.platform === "darwin") return macCommandVersion(command, args);
  return null;
}

async function detectEnvironment(): Promise<EnvironmentState> {
  await applyLoginPathToProcess();
  const nodeCommand = process.platform === "win32"
    ? await findOnWindowsPath("node.exe")
    : await findOnMacPath("node");
  const nodeOutput = nodeCommand ? await commandVersion(nodeCommand, ["--version"]) : null;
  const configuredCodex = process.env.CODEX_COMMAND
    ? (process.platform === "win32" ? normalizeWindowsCommandPath(process.env.CODEX_COMMAND) : process.env.CODEX_COMMAND)
    : null;
  const discoveredCodex = configuredCodex
    ?? (process.platform === "win32" ? await findOnWindowsPath("codex.cmd") : await findOnMacPath("codex"));
  if (discoveredCodex) {
    codexCommand = process.platform === "win32" ? normalizeWindowsCommandPath(discoveredCodex) : discoveredCodex;
  }
  const codexOutput = discoveredCodex ? await commandVersion(codexCommand, ["--version"]) : null;
  const detectedVersion = codexOutput?.replace(/^codex-cli\s+/i, "").trim();
  if (detectedVersion) codexVersion = detectedVersion;
  return {
    platform: initialEnvironment.platform,
    nodeInstalled: Boolean(nodeOutput),
    ...(nodeOutput ? { nodeVersion: nodeOutput } : {}),
    codexInstalled: Boolean(detectedVersion),
    ...(detectedVersion ? { codexVersion: detectedVersion } : {}),
    codexCompatible: Boolean(detectedVersion && /^0\.144\./.test(detectedVersion))
  };
}

/** Codex-only probe for Codex install/login helpers. Never gates the relay connection. */
async function findCodex(): Promise<void> {
  const environment = await detectEnvironment();
  updateState({ environment });
  if (!environment.nodeInstalled) throw new Error("未检测到 Node.js，请先完成环境安装。");
  if (!environment.codexInstalled) throw new Error("未检测到 Codex CLI，请点击环境检测区域的一键安装。");
  if (!environment.codexCompatible) {
    throw new Error(
      environment.codexVersion
        ? `Codex CLI 版本不兼容（需要 0.144.x，当前 ${environment.codexVersion}）。Claude / Grok 任务不受影响。`
        : "Codex CLI 版本不兼容（需要 0.144.x）。Claude / Grok 任务不受影响。"
    );
  }
}

/** True when at least one of Codex / Claude / Grok is usable for remote tasks. */
function anyCodingEngineReady(
  environment: EnvironmentState = publicState.environment,
  engines: CliEngineInfo[] = publicState.availableEngines
): boolean {
  if (environment.codexCompatible) return true;
  return engines.some((item) => item.ready);
}

/** Status for the agent panel — never mark incompatible solely because Codex is missing. */
function statusForEngineAvailability(options: {
  environment?: EnvironmentState;
  engines?: CliEngineInfo[];
  paired?: boolean;
}): PublicState["status"] {
  const environment = options.environment ?? publicState.environment;
  const engines = options.engines ?? publicState.availableEngines;
  const paired = options.paired ?? Boolean(config.hostId && config.encryptedAgentToken && config.encryptedSyncKey);
  if (!anyCodingEngineReady(environment, engines)) return "incompatible";
  if (socket?.readyState === WebSocket.OPEN) return "online";
  if (paired) return publicState.status === "connecting" ? "connecting" : "offline";
  if (config.pairing) return "pairing";
  if (config.relayUrl) return "waiting_pairing";
  return "unconfigured";
}

// ---- Windows-only Codex install (in-process npm; console only for login) ----

async function runWindowsCommand(
  command: string,
  args: string[],
  onChunk?: (text: string) => void
): Promise<void> {
  if (process.platform !== "win32") throw new Error("runWindowsCommand is Windows-only");
  await applyWindowsPathToProcess();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", windowsCmdArguments(command, args), {
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: process.env,
      cwd: os.homedir()
    });
    let combined = "";
    const handleChunk = (buf: Buffer) => {
      const text = buf.toString("utf8");
      combined = `${combined}${text}`.slice(-4_000);
      onChunk?.(combined);
    };
    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(combined.trim() || `命令失败，退出码 ${code ?? "unknown"}`));
    });
  });
}

/** Visible console from Electron GUI on Windows (WScript is more reliable than cmd start). */
async function openWindowsVisibleConsole(lines: string[]): Promise<void> {
  if (process.platform !== "win32") throw new Error("openWindowsVisibleConsole is Windows-only");
  const stamp = Date.now();
  const scriptPath = path.join(app.getPath("temp"), `anytimevibe-console-${stamp}.cmd`);
  const vbsPath = path.join(app.getPath("temp"), `anytimevibe-console-${stamp}.vbs`);
  const script = [
    "@echo off",
    "setlocal EnableExtensions",
    "chcp 65001 >nul",
    "title AnytimeVibe",
    "for /f \"tokens=2*\" %%A in ('reg query \"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\" /v Path 2^>nul') do set \"SYSPATH=%%B\"",
    "for /f \"tokens=2*\" %%A in ('reg query \"HKCU\\Environment\" /v Path 2^>nul') do set \"USERPATH=%%B\"",
    "set \"PATH=%SYSPATH%;%USERPATH%;%ProgramFiles%\\nodejs;%APPDATA%\\npm;%PATH%\"",
    ...lines,
    "echo.",
    "pause",
    "endlocal",
    ""
  ].join("\r\n");
  await fs.writeFile(scriptPath, script, "utf8");
  const quoted = scriptPath.replace(/"/g, '""');
  const vbs = `CreateObject("WScript.Shell").Run "cmd /k ""${quoted}""", 1, False`;
  await fs.writeFile(vbsPath, vbs, "utf8");
  const wscript = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const child = spawn(wscript, [vbsPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: os.homedir()
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`无法打开控制台：${error.message}`)));
    child.once("spawn", () => resolve());
    setTimeout(() => resolve(), 800);
  });
  child.unref();
}

async function installCodexOnWindows(): Promise<void> {
  if (process.platform !== "win32") throw new Error("installCodexOnWindows is Windows-only");
  await applyWindowsPathToProcess();
  updateState({ detail: "正在查找 npm…" });
  const npm = (await findOnWindowsPath("npm.cmd")) ?? (await findOnWindowsPath("npm"));
  if (!npm) {
    throw new Error("未找到 npm。请确认 Node.js 安装时包含 npm，然后重启随码客户端再试。");
  }

  updateState({ detail: `正在安装 @openai/codex@0.144.0…\nnpm: ${npm}` });
  await runWindowsCommand(npm, ["install", "-g", "@openai/codex@0.144.0"], (log) => {
    const tail = log.replace(/\r/g, "").split("\n").filter(Boolean).slice(-4).join(" | ");
    updateState({ detail: `正在安装 Codex CLI… ${tail}` });
  });

  cachedWindowsPath = null;
  await applyWindowsPathToProcess();
  const environment = await detectEnvironment();
  updateState({ environment });

  if (!environment.codexCompatible) {
    throw new Error(
      environment.codexInstalled
        ? `已安装但版本不兼容（当前 ${environment.codexVersion}，需要 0.144.x）。`
        : "npm 安装已结束，但仍未检测到 codex 命令。请重启客户端后再点「重新检测」。"
    );
  }

  updateState({ environment, detail: "Codex 安装成功，正在打开登录窗口…" });
  try {
    await openWindowsVisibleConsole([
      "echo ============================================",
      "echo   AnytimeVibe - codex login",
      "echo ============================================",
      "echo.",
      "where codex",
      "echo.",
      "call codex login",
      "echo.",
      "echo Login finished. Close this window and return to AnytimeVibe."
    ]);
    updateState({
      environment,
      detail: "Codex 已安装。请在弹出的登录窗口完成 codex login，然后点击「重新检测」。"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateState({
      environment,
      detail: `Codex 已安装，但无法自动打开登录窗口（${message}）。请手动打开终端运行：codex login`
    });
  }
}

// ---- macOS-only Codex install (Terminal.app; unchanged from prior mac behavior) ----

async function installCodexOnMac(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("installCodexOnMac is macOS-only");
  updateState({ detail: "正在打开 Terminal 安装 Codex…" });
  await openMacTerminalScript(`
echo "Installing Codex CLI 0.144.0…"
if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请先安装 Node.js。"
else
  npm install -g @openai/codex@0.144.0
  if command -v codex >/dev/null 2>&1; then
    codex --version
    echo "安装成功，开始登录…"
    codex login || true
  else
    echo "安装结束但未找到 codex 命令，请检查 npm 全局 bin 是否在 PATH。"
  fi
fi
`);
  updateState({ detail: "已打开 Terminal 安装 Codex。完成后请点击「重新检测」。" });
}

/** Build shell export/set lines for the current machine proxy (so curl/irm work offline-LAN). */
async function proxyShellLines(platform: "win32" | "darwin" | "powershell"): Promise<string[]> {
  const proxy = await collectLocalProxyEnv();
  const entries = Object.entries(proxy).filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (!entries.length) return [];
  if (platform === "powershell") {
    return entries.map(([key, value]) => `$env:${key} = ${JSON.stringify(value)}`);
  }
  if (platform === "win32") {
    return entries.map(([key, value]) => `set "${key}=${value.replace(/"/g, "")}"`);
  }
  return entries.map(([key, value]) => `export ${key}=${JSON.stringify(value)}`);
}

/** macOS Terminal: run a multi-line bash script (proxy + PATH already injected). */
async function openMacTerminalScript(scriptBody: string): Promise<void> {
  await applyMacLoginPathToProcess();
  const proxyLines = await proxyShellLines("darwin");
  const stamp = Date.now();
  const scriptPath = path.join(os.tmpdir(), `anytimevibe-install-${stamp}.sh`);
  const full = [
    "#!/bin/bash",
    "set +e",
    ...proxyLines,
    'export PATH="$HOME/.grok/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
    "echo \"Proxy: HTTP_PROXY=${HTTP_PROXY:-none}\"",
    scriptBody,
    "echo \"\"",
    "echo \"---\"",
    "echo \"可关闭此窗口，回到随码客户端点击「重新检测」。\""
  ].join("\n");
  await fs.writeFile(scriptPath, full, "utf8");
  try {
    await fs.chmod(scriptPath, 0o755);
  } catch {
    // ignore
  }
  const launch = `bash ${JSON.stringify(scriptPath)}`;
  await execFileAsync("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(launch)}`]);
  await execFileAsync("osascript", ["-e", "tell application \"Terminal\" to activate"]);
}

/** Windows: visible PowerShell window (never WSL/bash — those install Linux binaries). */
async function openWindowsPowerShellScript(scriptBody: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("openWindowsPowerShellScript is Windows-only");
  const stamp = Date.now();
  const ps1Path = path.join(app.getPath("temp"), `anytimevibe-ps-${stamp}.ps1`);
  const vbsPath = path.join(app.getPath("temp"), `anytimevibe-ps-${stamp}.vbs`);
  const proxyLines = await proxyShellLines("powershell");
  const full = [
    "$ErrorActionPreference = 'Continue'",
    "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
    "$ProgressPreference = 'SilentlyContinue'",
    ...proxyLines,
    scriptBody,
    "Write-Host ''",
    "Write-Host 'Press Enter to close...'",
    "[void](Read-Host)"
  ].join("\r\n");
  await fs.writeFile(ps1Path, full, "utf8");
  const quoted = ps1Path.replace(/"/g, '""');
  const vbs = `CreateObject("WScript.Shell").Run "powershell.exe -NoLogo -ExecutionPolicy Bypass -File ""${quoted}""", 1, False`;
  await fs.writeFile(vbsPath, vbs, "utf8");
  const wscript = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const child = spawn(wscript, [vbsPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: os.homedir()
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`无法打开 PowerShell：${error.message}`)));
    child.once("spawn", () => resolve());
    setTimeout(() => resolve(), 800);
  });
  child.unref();
}

async function installClaudeOnWindows(): Promise<void> {
  await applyWindowsPathToProcess();
  updateState({ detail: "正在打开 Claude Code 安装窗口…" });
  const proxyLines = await proxyShellLines("win32");
  await openWindowsVisibleConsole([
    "echo ============================================",
    "echo   AnytimeVibe - install Claude Code",
    "echo ============================================",
    "echo.",
    ...proxyLines,
    "where winget >nul 2>&1 && (",
    "  echo [1] winget install Anthropic.ClaudeCode ...",
    "  winget install --id Anthropic.ClaudeCode -e --accept-package-agreements --accept-source-agreements",
    ") || echo winget not found, trying npm ...",
    "where claude >nul 2>&1 || (",
    "  echo [2] npm install -g @anthropic-ai/claude-code ...",
    "  call npm install -g @anthropic-ai/claude-code",
    ")",
    "echo.",
    "where claude",
    "claude --version 2>nul",
    "echo.",
    "echo Done. Close this window and click 重新检测 in AnytimeVibe."
  ]);
  updateState({ detail: "已打开 Claude Code 安装窗口。完成后请点击「重新检测」。" });
}

async function installClaudeOnMac(): Promise<void> {
  updateState({ detail: "正在打开 Terminal 安装 Claude Code…" });
  // Prefer official install.sh (no Homebrew auto-update hang). brew as last resort with NO_AUTO_UPDATE.
  await openMacTerminalScript(`
echo "Installing Claude Code…"
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_ENV_HINTS=1
OK=0
if curl -fsSL --connect-timeout 25 --max-time 300 https://claude.ai/install.sh | bash; then
  OK=1
elif command -v npm >/dev/null 2>&1; then
  echo "official installer failed, trying npm…"
  npm install -g @anthropic-ai/claude-code && OK=1
elif command -v brew >/dev/null 2>&1; then
  echo "trying brew cask (no auto-update)…"
  brew install --cask claude-code && OK=1
fi
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v claude >/dev/null 2>&1; then
  claude --version
  echo "安装成功"
else
  echo "安装失败：请检查网络/代理后重试，或手动安装 Claude Code。"
  echo "  curl -fsSL https://claude.ai/install.sh | bash"
fi
`);
  updateState({ detail: "已打开 Terminal 安装 Claude Code。完成后请点击「重新检测」。" });
}

async function installGrokOnWindows(): Promise<void> {
  await applyWindowsPathToProcess();
  updateState({ detail: "正在打开安装窗口安装 Grok Build（Windows 原生，不用 WSL）…" });
  // Use cmd-visible console (same as other installers) so the window never flashes closed.
  // NEVER call bash/WSL — that installs linux-x86_64 into the WSL root.
  const proxyLines = await proxyShellLines("win32");
  const stamp = Date.now();
  const ps1Path = path.join(app.getPath("temp"), `anytimevibe-grok-install-${stamp}.ps1`);
  const ps1 = [
    "$ErrorActionPreference = 'Continue'",
    "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}",
    "$ProgressPreference = 'SilentlyContinue'",
    "Write-Host '============================================'",
    "Write-Host '  AnytimeVibe - Grok Build (Windows native)'",
    "Write-Host '============================================'",
    "Write-Host ''",
    "Write-Host ('HTTPS_PROXY=' + $(if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } else { 'none' }))",
    "$bin = Join-Path $env:USERPROFILE '.grok\\bin'",
    "$grokExe = Join-Path $bin 'grok.exe'",
    "New-Item -ItemType Directory -Force -Path $bin | Out-Null",
    "try {",
    "  Write-Host '[1] Download official install.ps1 ...'",
    "  $script = Invoke-RestMethod -Uri 'https://x.ai/cli/install.ps1' -TimeoutSec 120",
    "  Write-Host '[2] Running installer ...'",
    "  Invoke-Expression $script",
    "} catch {",
    "  Write-Host ('Installer error: ' + $_.Exception.Message)",
    "  Write-Host 'If this is a network error, configure system proxy or set HTTPS_PROXY.'",
    "}",
    "if (Test-Path $grokExe) {",
    "  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "  if (-not $userPath) { $userPath = '' }",
    "  if ($userPath -notlike ('*' + $bin + '*')) {",
    "    [Environment]::SetEnvironmentVariable('Path', ($bin + ';' + $userPath), 'User')",
    "    Write-Host ('Added user PATH: ' + $bin)",
    "  }",
    "  $env:Path = $bin + ';' + $env:Path",
    "  Write-Host ''",
    "  & $grokExe --version",
    "  Write-Host ''",
    "  Write-Host 'Install OK. Close this window and click 重新检测.'",
    "} else {",
    "  Write-Host ''",
    "  Write-Host ('FAILED: grok.exe not found at ' + $grokExe)",
    "  Write-Host 'Manual: open PowerShell and run:'",
    "  Write-Host '  irm https://x.ai/cli/install.ps1 | iex'",
    "}"
  ].join("\r\n");
  await fs.writeFile(ps1Path, ps1, "utf8");
  await openWindowsVisibleConsole([
    "echo ============================================",
    "echo   AnytimeVibe - install Grok Build (Windows)",
    "echo ============================================",
    "echo.",
    ...proxyLines,
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps1Path.replace(/"/g, "")}"`,
    "echo.",
    "if exist \"%USERPROFILE%\\.grok\\bin\\grok.exe\" (\"%USERPROFILE%\\.grok\\bin\\grok.exe\" --version) else (echo grok.exe not found yet)",
    "echo.",
    "echo Close this window and click 重新检测 in AnytimeVibe."
  ]);
  updateState({ detail: "已打开 Grok Build 安装窗口。完成后请点击「重新检测」。" });
}

async function installGrokOnMac(): Promise<void> {
  updateState({ detail: "正在打开 Terminal 安装 Grok Build…" });
  await openMacTerminalScript(`
echo "Installing Grok Build CLI…"
echo "If curl times out, ensure system proxy / VPN can reach x.ai"
OK=0
if curl -fsSL --connect-timeout 25 --max-time 300 https://x.ai/cli/install.sh | bash; then
  OK=1
fi
export PATH="$HOME/.grok/bin:$HOME/.local/bin:$PATH"
if command -v grok >/dev/null 2>&1 || [ -x "$HOME/.grok/bin/grok" ]; then
  if command -v grok >/dev/null 2>&1; then grok --version; else "$HOME/.grok/bin/grok" --version; fi
  echo "安装成功"
else
  echo "安装失败：无法从 x.ai 下载（常见原因：网络超时、未配置代理）。"
  echo "可手动执行："
  echo "  export https_proxy=http://127.0.0.1:端口"
  echo "  curl -fsSL https://x.ai/cli/install.sh | bash"
fi
`);
  updateState({ detail: "已打开 Terminal 安装 Grok Build。完成后请点击「重新检测」。" });
}

async function installNodeOnWindows(): Promise<void> {
  if (process.platform !== "win32") throw new Error("installNodeOnWindows is Windows-only");
  await applyWindowsPathToProcess();
  updateState({ detail: "正在打开 Node.js 一键安装窗口…" });
  const proxyLines = await proxyShellLines("win32");
  await openWindowsVisibleConsole([
    "echo ============================================",
    "echo   AnytimeVibe - install Node.js LTS",
    "echo ============================================",
    "echo.",
    ...proxyLines,
    "where node >nul 2>&1 && (",
    "  echo Node.js already on PATH:",
    "  node --version",
    "  npm --version 2>nul",
    "  goto :done",
    ")",
    "where winget >nul 2>&1 && (",
    "  echo [1] winget install OpenJS.NodeJS.LTS ...",
    "  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements",
    "  goto :after",
    ")",
    "echo winget not found, downloading official LTS MSI ...",
    "set \"MSI=%TEMP%\\anytimevibe-nodejs-lts.msi\"",
    "powershell -NoLogo -ExecutionPolicy Bypass -Command \"try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi' -OutFile $env:TEMP\\anytimevibe-nodejs-lts.msi -UseBasicParsing } catch { exit 1 }\"",
    "if exist \"%MSI%\" (",
    "  echo [2] msiexec install ...",
    "  msiexec /i \"%MSI%\" /qn /norestart",
    ") else (",
    "  echo Download failed. Opening nodejs.org ...",
    "  start \"\" \"https://nodejs.org/en/download\"",
    ")",
    ":after",
    "echo.",
    "for /f \"tokens=2*\" %%A in ('reg query \"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\" /v Path 2^>nul') do set \"SYSPATH=%%B\"",
    "for /f \"tokens=2*\" %%A in ('reg query \"HKCU\\Environment\" /v Path 2^>nul') do set \"USERPATH=%%B\"",
    "set \"PATH=%ProgramFiles%\\nodejs;%APPDATA%\\npm;%SYSPATH%;%USERPATH%;%PATH%\"",
    "where node 2>nul",
    "node --version 2>nul",
    "npm --version 2>nul",
    ":done",
    "echo.",
    "echo Done. Close this window, restart AnytimeVibe, then click 重新检测."
  ]);
  updateState({ detail: "已打开 Node.js 安装窗口。完成后请重启随码并点击「重新检测」。" });
}

async function installNodeOnMac(): Promise<void> {
  updateState({ detail: "正在打开 Terminal 安装 Node.js…" });
  await openMacTerminalScript(`
echo "Installing Node.js LTS…"
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_ENV_HINTS=1
OK=0
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  node --version
  npm --version
  echo "Node.js already installed"
  OK=1
elif command -v brew >/dev/null 2>&1; then
  echo "[1] brew install node@22 …"
  brew install node@22 && brew link --overwrite --force node@22 && OK=1
  if [ "$OK" != "1" ]; then
    brew install node && OK=1
  fi
fi
if [ "$OK" != "1" ]; then
  echo "[2] official pkg installer …"
  PKG="/tmp/anytimevibe-node-lts.pkg"
  if curl -fsSL --connect-timeout 25 --max-time 300 -o "$PKG" "https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg"; then
    sudo installer -pkg "$PKG" -target / && OK=1
  fi
fi
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if command -v node >/dev/null 2>&1; then
  node --version
  npm --version 2>/dev/null || true
  echo "安装成功"
else
  echo "安装失败：请检查网络/代理，或打开 https://nodejs.org/en/download 手动安装。"
  open "https://nodejs.org/en/download" 2>/dev/null || true
fi
`);
  updateState({ detail: "已打开 Terminal 安装 Node.js。完成后请重启随码并点击「重新检测」。" });
}

async function installCursorAgent(): Promise<void> {
  updateState({ detail: "正在打开 Cursor Agent CLI 安装窗口…" });
  if (process.platform === "win32") {
    const proxyLines = await proxyShellLines("win32");
    await openWindowsVisibleConsole([
      "echo ============================================",
      "echo   AnytimeVibe - install Cursor Agent CLI",
      "echo ============================================",
      "echo.",
      ...proxyLines,
      "echo [1] Official installer (cursor.com/install) ...",
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"irm 'https://cursor.com/install?win32=true' | iex\"",
      "echo.",
      "set \"PATH=%USERPROFILE%\\.local\\bin;%PATH%\"",
      "where agent 2>nul",
      "where cursor-agent 2>nul",
      "agent --version 2>nul",
      "echo.",
      "echo If agent is Cursor CLI: run  agent login",
      "echo Note: do not confuse with Grok's agent.exe under %%USERPROFILE%%\\.grok\\bin",
      "echo.",
      "echo Done. Close this window and click 重新检测 in AnytimeVibe."
    ]);
    updateState({ detail: "已打开 Cursor Agent 安装窗口。完成后请登录（agent login）并点「重新检测」。" });
    return;
  }
  if (process.platform === "darwin") {
    await openMacTerminalScript(`
echo "Installing Cursor Agent CLI…"
curl -fsS https://cursor.com/install | bash
export PATH="$HOME/.local/bin:$PATH"
agent --version || true
echo "Install finished. Run: agent login"
`);
    updateState({ detail: "已打开 Terminal 安装 Cursor Agent。完成后请执行 agent login 并点「重新检测」。" });
    return;
  }
  throw new Error("当前系统暂不支持一键安装 Cursor Agent CLI。");
}

async function installEnvironment(target: "node" | "codex" | "claude" | "grok" | "cursor"): Promise<void> {
  if (target === "node") {
    if (process.platform === "win32") {
      await installNodeOnWindows();
      return;
    }
    if (process.platform === "darwin") {
      await installNodeOnMac();
      return;
    }
    throw new Error("当前系统暂不支持一键安装 Node.js。");
  }
  if (target === "claude") {
    if (process.platform === "win32") {
      await installClaudeOnWindows();
      return;
    }
    if (process.platform === "darwin") {
      await installClaudeOnMac();
      return;
    }
    throw new Error("当前系统暂不支持一键安装 Claude Code。");
  }
  if (target === "grok") {
    if (process.platform === "win32") {
      await installGrokOnWindows();
      return;
    }
    if (process.platform === "darwin") {
      await installGrokOnMac();
      return;
    }
    throw new Error("当前系统暂不支持一键安装 Grok Build。");
  }
  if (target === "cursor") {
    await installCursorAgent();
    return;
  }
  // Strict platform split: do not share install implementation across OS.
  if (process.platform === "win32") {
    await installCodexOnWindows();
    return;
  }
  if (process.platform === "darwin") {
    await installCodexOnMac();
    return;
  }
  throw new Error("当前系统暂不支持一键打开安装终端。");
}

async function ensurePairingKeys(): Promise<void> {
  if (config.encryptedPrivateKey && config.publicKey) return;
  const keyPair = await generatePairingKeyPair();
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  config.publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  config.encryptedPrivateKey = encryptSecret(JSON.stringify(privateJwk));
  await saveConfig();
}

async function startPairing(): Promise<PublicState> {
  if (!config.relayUrl) throw new Error("请先配置中继地址");
  await ensurePairingKeys();
  const secret = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  const response = await fetch(`${config.relayUrl}/api/agent/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret,
      agentId: config.agentId,
      agentName: resolvedDisplayName(),
      platform: `${process.platform} ${os.release()}`,
      codexVersion,
      agentPublicKey: config.publicKey
    })
  });
  if (!response.ok) throw new Error(`中继返回 HTTP ${response.status}`);
  const result = await response.json() as { pairingId: string; code: string; expiresInSeconds: number };
  config.pairing = { id: result.pairingId, code: result.code, secret, expiresAt: Date.now() + result.expiresInSeconds * 1000 };
  await saveConfig();
  updateState({ status: "pairing", detail: "等待移动端确认并交换端到端加密密钥。", pairingCode: result.code, pairingExpiresAt: config.pairing.expiresAt });
  schedulePairingPoll();
  return publicState;
}

let pairingPollInFlight = false;

function schedulePairingPoll(): void {
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = setTimeout(() => pollPairing().catch(handleError), 1800);
}

async function pollPairing(): Promise<void> {
  if (pairingPollInFlight) return;
  const pairing = config.pairing;
  if (!pairing) return;
  pairingPollInFlight = true;
  try {
    if (pairing.expiresAt <= Date.now()) {
      delete config.pairing;
      await saveConfig();
      updateState({ status: "waiting_pairing", detail: "配对码已过期，请重新生成配对码。", pairingCode: undefined, pairingExpiresAt: undefined });
      return;
    }
    const response = await fetch(`${config.relayUrl}/api/agent/pairings/${pairing.id}?secret=${encodeURIComponent(pairing.secret)}`);
    if (!response.ok) throw new Error(`配对状态查询失败：HTTP ${response.status}`);
    const result = await response.json() as Record<string, any>;
    if (result.status === "consumed") throw new Error("配对凭据已被读取但代理未完成保存，请重新生成配对码。");
    if (result.status !== "claimed") {
      schedulePairingPoll();
      return;
    }
    // Claim ownership of this pairing immediately to prevent concurrent poll races.
    delete config.pairing;
    await saveConfig();
    updateState({ pairingCode: undefined, pairingExpiresAt: undefined });

    const privateJwk = JSON.parse(decryptSecret(config.encryptedPrivateKey!)) as JsonWebKey;
    const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const pairingKey = await derivePairingKey(privateKey, result.clientPublicKey as JsonWebKey, pairing.id);
    const syncKeyValue = config.encryptedSyncKey
      ? decryptSecret(config.encryptedSyncKey)
      : bytesToBase64(randomKeyBytes());
    const wrappedSyncKey = await encryptPayload(pairingKey, { syncKey: syncKeyValue }, pairing.id);
    const authorization = await fetch(`${config.relayUrl}/api/agent/pairings/${pairing.id}/authorize?secret=${encodeURIComponent(pairing.secret)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wrappedSyncKey })
    });
    if (!authorization.ok) throw new Error(`浏览器密钥授权失败：HTTP ${authorization.status}`);
    config.hostId = String(result.hostId);
    config.encryptedAgentToken = encryptSecret(String(result.agentToken));
    config.encryptedSyncKey = encryptSecret(syncKeyValue);
    await saveConfig();
    syncKey = await importAesKey(base64ToBytes(syncKeyValue));
    updateState({ status: "connecting", detail: "新浏览器已获得主机密钥授权，正在建立连接。", hostId: config.hostId });
    await connect(true);
  } finally {
    pairingPollInFlight = false;
  }
}

function wsUrl(relayUrl: string): string {
  return relayUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

let connecting = false;

const FATAL_WS_CODES = new Set([
  4001, // missing_credentials
  4003 // unauthorized / revoked
]);

async function connect(force = false): Promise<void> {
  if (!config.hostId || !config.encryptedAgentToken || !config.encryptedSyncKey) {
    if (config.pairing) schedulePairingPoll();
    else updateState({ status: "waiting_pairing", detail: "等待配对连接，请生成配对码并在 Web 端完成授权。" });
    return;
  }
  if (reconnectBlockedReason && !force) {
    updateState({ status: "offline", detail: reconnectBlockedReason });
    return;
  }
  // Never hard-gate relay on Codex alone — Claude/Grok-only hosts must still connect.
  // PATH refresh is best-effort and time-bounded so a hung shell cannot freeze reconnect.
  await applyLoginPathToProcessBounded();

  if (!force && socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  // force=true always proceeds even if a previous attempt left connecting=true.
  if (connecting && !force) return;
  logInfo(force ? "开始连接中继（强制）" : "开始连接中继", config.relayUrl);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connecting = true;
  if (force) {
    reconnectBlockedReason = null;
    reconnectAttempt = 0;
  }
  const generation = ++connectGeneration;
  const previousSocket = socket;
  socket = null;
  if (previousSocket) {
    previousSocket.removeAllListeners();
    try {
      previousSocket.terminate();
    } catch {
      try {
        previousSocket.close();
      } catch {
        // ignore
      }
    }
  }
  try {
    syncKey ??= await importAesKey(base64ToBytes(decryptSecret(config.encryptedSyncKey)));
  } catch (error) {
    connecting = false;
    handleError(error);
    return;
  }
  updateState({ status: "connecting", detail: "正在连接加密中继…", hostId: config.hostId });
  let token: string;
  try {
    token = decryptSecret(config.encryptedAgentToken);
  } catch (error) {
    connecting = false;
    handleError(error);
    return;
  }
  let connection: WebSocket;
  try {
    connection = new WebSocket(`${wsUrl(config.relayUrl)}/ws/agent?hostId=${encodeURIComponent(config.hostId)}`, {
      headers: { authorization: `Bearer ${token}` }
    });
  } catch (error) {
    connecting = false;
    const message = error instanceof Error ? error.message : String(error);
    scheduleReconnect(`无法创建中继连接：${message}，正在重试。`);
    return;
  }
  socket = connection;
  let pingTimer: NodeJS.Timeout | null = null;
  let connectTimer: NodeJS.Timeout | null = null;
  const clearPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };
  const clearConnectTimer = () => {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  };
  // If open never fires (hung TCP / dead proxy), free connecting and retry.
  connectTimer = setTimeout(() => {
    if (generation !== connectGeneration || socket !== connection) return;
    if (connection.readyState === WebSocket.OPEN) return;
    clearConnectTimer();
    connecting = false;
    try {
      connection.removeAllListeners();
      connection.terminate();
    } catch {
      // ignore
    }
    if (socket === connection) socket = null;
    logWarn(`连接中继超时（${Math.round(WS_CONNECT_TIMEOUT_MS / 1000)}s）`, config.relayUrl);
    scheduleReconnect(`连接中继超时（${Math.round(WS_CONNECT_TIMEOUT_MS / 1000)}s），正在重试。`);
  }, WS_CONNECT_TIMEOUT_MS);
  connectTimer.unref?.();

  connection.on("open", () => {
    if (generation !== connectGeneration || socket !== connection) {
      try {
        connection.close();
      } catch {
        // ignore
      }
      return;
    }
    clearConnectTimer();
    connecting = false;
    reconnectAttempt = 0;
    reconnectBlockedReason = null;
    logInfo("中继 WebSocket 已连接", config.relayUrl);
    // Keepalive: reverse proxies often idle-drop sockets without ping frames.
    clearPing();
    pingTimer = setInterval(() => {
      if (generation !== connectGeneration || socket !== connection) {
        clearPing();
        return;
      }
      if (connection.readyState === WebSocket.OPEN) {
        try {
          connection.ping();
        } catch {
          // ignore
        }
      }
    }, 25_000);
    pingTimer.unref?.();
    // Keep the relay socket online even if Codex bootstrap fails, otherwise macOS
    // (missing GUI PATH / codex shebang) will flap between offline and reconnect.
    void (async () => {
      updateState({ status: "online", detail: "代理在线。凭据和项目文件均保留在本机。" });
      // Resume any durable follow-up prompts queued while a prior turn was running.
      scheduleDrainAllTurnQueues();
      // Always push workspaces/online status — must not depend on Codex being ready.
      try {
        if (generation === connectGeneration && socket === connection) await publishHostStatus();
      } catch {
        // ignore; connect path continues
      }
      // Codex is optional; failures must not mark the host offline or block the UI.
      // Skip ensureCodex entirely when Codex is absent so Claude/Grok-only hosts stay clean.
      const codexOk = Boolean(publicState.environment.codexCompatible || /^0\.144\./.test(codexVersion));
      if (!codexOk) {
        logInfo("中继已连接（未安装兼容 Codex，使用 Claude / Grok 即可）");
        updateState({
          status: "online",
          detail: "代理在线。未安装 Codex 也可使用 Claude Code / Grok Build 下发任务。"
        });
        return;
      }
      try {
        await ensureCodex();
        if (generation !== connectGeneration || socket !== connection) return;
        // Local 接力 list reads Codex threads directly (not gated on web sync).
        await refreshLocalTasks();
        // Do not auto syncAllThreads on every reconnect — it floods the link and can
        // look like flapping; user can sync from web when needed.
      } catch (error) {
        if (generation !== connectGeneration || socket !== connection) return;
        const message = error instanceof Error ? error.message : String(error);
        logWarn("中继已连接，但 Codex 未就绪", message);
        updateState({
          status: "online",
          detail: `中继已连接（Codex 可选未就绪：${message}）`
        });
        // Still report meta so admin sees live status even if ensureCodex failed mid-way.
        publishAgentMeta();
      }
    })();
  });
  connection.on("message", (data) => {
    if (generation !== connectGeneration || socket !== connection) return;
    handleRelayMessage(String(data)).catch(handleError);
  });
  connection.on("close", (code, reason) => {
    if (generation !== connectGeneration) return;
    clearConnectTimer();
    clearPing();
    connecting = false;
    if (socket === connection) socket = null;
    const why = reason?.toString?.() || `code ${code}`;
    logWarn("中继连接已关闭", `${why}`);
    // 4002 = replaced by a newer agent socket for the same host — do not fight it.
    if (code === 4002) {
      updateState({ status: "offline", detail: "连接已被新的代理实例替换。" });
      return;
    }
    // Normal close during intentional reconnect/shutdown.
    if (code === 1000 && (quitting || installingUpdate)) return;
    if (FATAL_WS_CODES.has(code) || /unauthorized|revoked|missing_credentials|user_deleted/i.test(why)) {
      reconnectBlockedReason = `中继拒绝连接（${why}）。请重新配对。`;
      logError("中继拒绝连接（停止自动重试）", why);
      updateState({ status: "offline", detail: reconnectBlockedReason });
      return;
    }
    scheduleReconnect(`中继连接已断开（${why}），正在重试。`);
  });
  connection.on("error", (error) => {
    if (generation !== connectGeneration) return;
    // Do not close here — the 'close' event will follow and owns reconnect.
    // If close never comes (rare), the connect timer still recovers us.
    logError("中继 WebSocket 错误", error.message || "网络错误");
    if (socket === connection) {
      updateState({ status: "offline", detail: `无法连接中继：${error.message || "网络错误"}，正在重试。` });
    }
  });
}

function scheduleReconnect(detail: string): void {
  if (quitting) return;
  // "incompatible" used to mean Codex-only; multi-CLI hosts should still retry relay.
  // Only skip auto-reconnect when auth is permanently blocked.
  if (reconnectBlockedReason) {
    updateState({ status: "offline", detail: reconnectBlockedReason });
    return;
  }
  if (!config.hostId || !config.encryptedAgentToken || !config.encryptedSyncKey) {
    updateState({ status: "waiting_pairing", detail: "等待配对连接，请生成配对码并在 Web 端完成授权。" });
    return;
  }
  // Ensure we never stay stuck with connecting=true after a failed attempt.
  connecting = false;
  updateState({ status: "offline", detail });
  if (reconnectTimer) return;
  reconnectAttempt += 1;
  // Exponential backoff with jitter: ~2s, 3s, 5s … capped at 30s.
  const base = Math.min(30_000, 1500 * 2 ** Math.min(reconnectAttempt - 1, 4));
  const delay = base + Math.floor(Math.random() * 800);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(handleError);
  }, delay);
  reconnectTimer.unref?.();
}

async function ensureCodex(): Promise<void> {
  if (codex) return;
  await applyLoginPathToProcess();
  if (!/^0\.144\./.test(codexVersion)) {
    const environment = await detectEnvironment();
    updateState({ environment });
    if (!environment.codexCompatible) {
      // Codex is optional — callers that need Codex catch this; relay stays connected.
      throw new Error(environment.codexInstalled
        ? `Codex 版本不兼容（需要 0.144.x，当前 ${environment.codexVersion}）；可用 Claude / Grok`
        : "未检测到 Codex CLI（可选）；可用 Claude / Grok");
    }
  }
  codex = new CodexAdapter(codexCommand, (message) => {
    if (quitting || installingUpdate) return;
    handleCodexMessage(message).catch(handleError);
  }, (detail) => {
    codex = null;
    // Ignore exit noise while shutting down for update/quit — UI may already be destroyed.
    if (quitting || installingUpdate) return;
    // Do not tear down the relay socket when Codex exits; keep online for reconnect of Codex only.
    updateState({
      status: socket?.readyState === WebSocket.OPEN ? "online" : publicState.status,
      detail: `Codex 已停止：${detail}（Claude / Grok 任务不受影响）`
    });
  });
  await codex.start();
}

/** Write project trust, then restart app-server if config changed so the new trust is loaded. */
async function ensureCodexTrustedAndReady(cwd: string): Promise<void> {
  const trustChanged = await ensureWorkspaceTrusted("codex", cwd);
  if (trustChanged && codex) {
    logInfo("Codex 项目信任已更新，正在重载 app-server", cwd);
    try {
      codex.stop();
    } catch {
      // ignore
    }
    codex = null;
  }
  await ensureCodex();
}

async function handleRelayMessage(raw: string): Promise<void> {
  const parsed = JSON.parse(raw) as Record<string, any>;
  if (parsed.type === "relay.key_authorization") {
    if (!config.encryptedSyncKey) throw new Error("Missing encrypted sync key");
    await ensurePairingKeys();
    const pairingId = String(parsed.pairingId);
    const privateJwk = JSON.parse(decryptSecret(config.encryptedPrivateKey!)) as JsonWebKey;
    const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const pairingKey = await derivePairingKey(privateKey, parsed.clientPublicKey as JsonWebKey, pairingId);
    const wrappedSyncKey = await encryptPayload(pairingKey, { syncKey: decryptSecret(config.encryptedSyncKey) }, pairingId);
    socket?.send(JSON.stringify({ type: "agent.key_authorization", pairingId, wrappedSyncKey }));
    return;
  }
  if (parsed.type === "relay.host_hello" || parsed.type === "relay.host_rename") {
    // Server DB is the source of truth for web-driven renames (and offline renames on reconnect).
    const name = String(parsed.name ?? "").trim().slice(0, 64);
    if (name && name !== resolvedDisplayName()) {
      config.displayName = name;
      await saveConfig();
      updateState({
        displayName: name,
        detail: parsed.type === "relay.host_rename"
          ? `Web 端已将客户端名称更新为“${name}”。`
          : `已同步服务器主机名称“${name}”。`
      });
    }
    return;
  }
  const envelope = parsed as EncryptedEnvelope;
  if (!syncKey) throw new Error("Missing sync key");
  const command = clientCommandSchema.parse(await openEnvelope<ClientCommand>(syncKey, envelope));
  await handleCommand(command);
}

function isAllowedWorkspace(requestedPath: string): boolean {
  const requested = path.resolve(requestedPath).toLowerCase();
  return config.workspaces.some((workspace) => {
    const root = path.resolve(workspace.path).toLowerCase();
    const relative = path.relative(root, requested);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

/** Always persist/publish absolute task working directories (subdir under a workspace stays the full path). */
function resolveAbsoluteCwd(cwd: string | undefined | null, fallback = ""): string {
  const raw = String(cwd ?? "").trim();
  if (!raw) return fallback;
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
}

/** Prefer the more specific absolute path when merging snapshot vs local store. */
function preferTaskCwd(...candidates: Array<string | undefined | null>): string {
  const resolved = candidates
    .map((item) => resolveAbsoluteCwd(item))
    .filter(Boolean);
  if (!resolved.length) return "";
  // Longer path wins when one is a parent of another (workspace root vs task subdir).
  resolved.sort((left, right) => right.length - left.length);
  return resolved[0]!;
}

async function handleBackendStreamEvent(event: BackendStreamEvent): Promise<void> {
  if (event.type === "delta") {
    const itemId = event.kind === "assistant"
      ? event.itemId
      : event.kind === "exec"
        ? (event.itemId.startsWith("exec:") ? event.itemId : `exec:${event.itemId}`)
        : event.kind === "stage"
          ? (event.itemId.startsWith("stage:") ? event.itemId : `stage:${event.itemId}`)
          : event.kind === "thought"
            ? `stage:thought:${event.itemId}`
            : "cli-log";
    queueRemoteDelta(event.threadId, itemId, event.delta);
    appendLocalActivity(event.threadId, event.delta);
    return;
  }
  if (event.type === "turn.started") {
    activeTurnByThread.set(event.threadId, event.turnId);
    clearEngineDiffChunks(event.threadId);
    // Headless path already upserts the user message + snapshot before spawning the CLI.
    // Omitting prompt here avoids the web adding a second YOU bubble for the same turn.
    const stored = taskStore.get(event.threadId);
    const lastUser = stored
      ? [...stored.messages].reverse().find((message) => message.role === "user")
      : undefined;
    const promptAlreadyPersisted = Boolean(
      event.prompt
      && lastUser
      && lastUser.text.trim() === event.prompt.trim()
    );
    await publish({
      type: "turn.started",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      threadId: event.threadId,
      turnId: event.turnId,
      ...(!promptAlreadyPersisted && event.prompt ? { prompt: event.prompt } : {})
    }, true);
    return;
  }
  if (event.type === "session") {
    await taskStore.setProviderSession(event.threadId, event.providerSessionId);
    return;
  }
  if (event.type === "usage") {
    const task = taskStore.get(event.threadId);
    if (task) {
      task.contextUsage = event.contextUsage;
      task.updatedAt = Date.now() / 1000;
      await taskStore.upsert(task);
    }
    return;
  }
  if (event.type === "error") {
    handleError(new Error(event.message));
    const threadId = event.threadId;
    if (threadId) {
      const task = taskStore.get(threadId);
      if (task) {
        const text = event.message.trim();
        const already = task.messages.some(
          (message) => message.role === "system" && message.text.trim() === text
        );
        if (text && !already) {
          task.messages.push({
            id: crypto.randomUUID(),
            role: "system",
            text: text.startsWith("错误") || text.startsWith("Error") ? text : `错误：${text}`
          });
        }
        if (!/failed|error|interrupt|stop|cancel/i.test(task.status)) {
          task.status = "failed";
        }
        task.updatedAt = Date.now() / 1000;
        await taskStore.upsert(task);
      }
    }
    // Also surface to web clients as a persisted error event when possible.
    await publish({
      type: "error",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      message: event.message,
      ...(threadId ? { threadId } : {})
    }, true).catch(() => undefined);
    if (threadId) {
      try {
        await publishStoredTaskSnapshot(threadId);
      } catch {
        // ignore
      }
    }
    return;
  }
  if (event.type === "turn.completed") {
    await flushRemoteDeltas();
    activeTurnByThread.delete(event.threadId);
    finishLocalActivity(event.threadId, event.status);
    await taskStore.setStatus(event.threadId, event.status);
    const failed = isTerminalTurnStatus(event.status) && /error|fail/i.test(event.status);
    if (event.contextUsage) {
      const task = taskStore.get(event.threadId);
      if (task) {
        task.contextUsage = event.contextUsage;
        await taskStore.upsert(task);
      }
    }
    // Ensure a visible system error when the CLI only reported a failed status.
    if (failed) {
      const task = taskStore.get(event.threadId);
      if (task) {
        const hasSystem = task.messages.some((message) => message.role === "system" && message.text.trim());
        if (!hasSystem) {
          task.messages.push({
            id: crypto.randomUUID(),
            role: "system",
            text: `任务失败（${event.status}）。请在电脑端打开「任务 → 接力」查看本机 CLI 输出，或重试。`
          });
          task.updatedAt = Date.now() / 1000;
          await taskStore.upsert(task);
        }
      }
    }
    const failedSystemText = failed
      ? taskStore.get(event.threadId)?.messages
        .slice()
        .reverse()
        .find((message) => message.role === "system")
        ?.text
        ?.trim()
      : undefined;
    await publish({
      type: "turn.completed",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      threadId: event.threadId,
      turnId: event.turnId,
      status: event.status,
      ...(event.contextUsage ? { contextUsage: event.contextUsage } : {}),
      ...(failedSystemText ? { errorMessage: failedSystemText } : {})
    }, true, "completed");
    // Collect workspace / engine diffs for the Diff tab (Claude / Grok headless path).
    try {
      await publishTaskDiff(event.threadId, event.turnId);
    } catch {
      // ignore
    }
    // Push latest snapshot so web sees contextUsage / final status / lastDiff / system errors.
    try {
      await publishStoredTaskSnapshot(event.threadId);
    } catch {
      // ignore
    }
  }
}

/** Build + publish task Diff for the web Diff tab; persist on StoredTask. */
async function publishTaskDiff(threadId: string, turnId: string): Promise<void> {
  const stored = taskStore.get(threadId);
  const listed = publicState.tasks.find((item) => item.threadId === threadId);
  const cwd = preferTaskCwd(stored?.cwd, listed?.cwd);
  const diff = await buildTurnDiff(threadId, cwd);
  if (!diff.trim()) return;
  if (stored) {
    stored.lastDiff = diff;
    stored.updatedAt = Date.now() / 1000;
    await taskStore.upsert(stored);
  }
  await publish({
    type: "diff.updated",
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    threadId,
    turnId,
    diff
  }, true);
}

async function publishStoredTaskSnapshot(threadId: string): Promise<void> {
  const task = taskStore.get(threadId);
  if (!task) return;
  const cwd = resolveAbsoluteCwd(task.cwd);
  if (cwd && task.cwd !== cwd) {
    task.cwd = cwd;
    await taskStore.upsert(task);
  }
  const agentTask: AgentTask = {
    threadId: task.threadId,
    title: task.title,
    cwd,
    status: task.status,
    updatedAt: task.updatedAt,
    engine: task.engine
  };
  updateState({
    tasks: [agentTask, ...publicState.tasks.filter((item) => item.threadId !== task.threadId)]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 200)
  });
  await publish({
    type: "thread.snapshot",
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    threadId: task.threadId,
    title: task.title,
    cwd,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    cliEngine: task.engine,
    ...(task.providerSessionId ? { providerSessionId: task.providerSessionId } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}),
    ...(task.contextUsage ? { contextUsage: task.contextUsage } : {}),
    ...(task.lastDiff ? { diff: task.lastDiff } : {}),
    messages: task.messages
  }, true);
}

async function runHeadlessTaskTurn(options: {
  engine: Exclude<CliEngine, "codex">;
  threadId: string;
  cwd: string;
  prompt: string;
  title?: string;
  permissionMode: PermissionMode;
  isNew: boolean;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<void> {
  const turnId = crypto.randomUUID();
  const now = Date.now() / 1000;
  let stored = taskStore.get(options.threadId);
  const absoluteCwd = resolveAbsoluteCwd(options.cwd);
  if (options.isNew || !stored) {
    stored = {
      threadId: options.threadId,
      engine: options.engine,
      providerSessionId: "",
      cwd: absoluteCwd,
      title: options.title || options.prompt.slice(0, 80),
      status: "active",
      createdAt: now,
      updatedAt: now,
      messages: [],
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {})
    };
  } else if (absoluteCwd) {
    // Keep the real absolute working dir (subdir under a workspace root stays full path).
    stored.cwd = preferTaskCwd(absoluteCwd, stored.cwd);
  }
  if (options.model) stored.model = options.model;
  if (options.reasoningEffort) stored.reasoningEffort = options.reasoningEffort;
  stored.messages.push({ id: crypto.randomUUID(), role: "user", text: options.prompt });
  stored.status = "active";
  stored.updatedAt = now;
  await taskStore.upsert(stored);
  await publishStoredTaskSnapshot(options.threadId);
  startLocalActivity(options.threadId, options.prompt, stored.title, options.engine);
  activeTurnByThread.set(options.threadId, turnId);

  // Ensure GUI-spawned agent can see user-installed CLIs on PATH.
  try {
    await applyLoginPathToProcess();
  } catch {
    // ignore PATH enrichment failures
  }
  clearEngineBinaryCache();

  // Resume only when we already have a provider-native session id from a prior turn.
  const resumeId = stored.providerSessionId.trim() || undefined;
  const result = await runHeadlessTurn(options.engine, {
    threadId: options.threadId,
    turnId,
    cwd: options.cwd,
    prompt: options.prompt,
    permissionMode: options.permissionMode,
    ...(resumeId ? { providerSessionId: resumeId } : {}),
    ...(options.model || stored.model ? { model: options.model || stored.model } : {}),
    ...(options.reasoningEffort || stored.reasoningEffort
      ? { reasoningEffort: options.reasoningEffort || stored.reasoningEffort }
      : {})
  }, async (event) => {
    // Must await so publish sequence numbers and delta flush stay ordered.
    await handleBackendStreamEvent(event);
  });

  const latest = taskStore.get(options.threadId) ?? stored;
  if (result.providerSessionId) latest.providerSessionId = result.providerSessionId;
  if (result.contextUsage) latest.contextUsage = result.contextUsage;
  if (result.model) latest.model = result.model;
  latest.status = result.status;
  latest.updatedAt = Date.now() / 1000;
  if (result.text.trim()) {
    // Never dump long model replies into role=system — false failure banner on web (Grok non-zero exit).
    const text = result.text.trim();
    const looksLikeErrorOnly = result.status === "failed"
      && text.length < 600
      && /失败|错误|exit|退出码|未找到|无法|not found|error|failed|login|auth/i.test(text);
    if (result.status === "failed" && looksLikeErrorOnly) {
      latest.messages.push({
        id: crypto.randomUUID(),
        role: "system",
        text: text.startsWith("错误") || text.startsWith("任务失败") ? text : ("错误：" + text)
      });
    } else {
      latest.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        text
      });
      if (result.status === "failed") {
        latest.messages.push({
          id: crypto.randomUUID(),
          role: "system",
          text: options.engine === "claude"
            ? "错误：Claude 任务失败（已保留上方模型输出）。请检查登录与模型配置。"
            : options.engine === "cursor"
              ? "错误：Cursor 任务失败（已保留上方模型输出）。请确认 agent 登录 / CURSOR_API_KEY。"
              : "错误：Grok 任务失败（已保留上方模型输出）。请检查本机 Grok CLI 状态。"
        });
      }
    }
  } else if (result.status === "failed") {
    latest.messages.push({
      id: crypto.randomUUID(),
      role: "system",
      text: options.engine === "claude"
        ? "错误：Claude 任务失败。请确认本机已安装 Claude Code 并登录；若提示模型已下线，请设置环境变量 CLAUDE_MODEL（例如 claude-opus-4-7）或在 Claude CLI 中切换模型。"
        : options.engine === "cursor"
          ? "错误：Cursor 任务失败。请确认已安装 Cursor Agent CLI（agent）并登录（agent login 或设置 CURSOR_API_KEY）；勿与 Grok 的 agent 命令混淆。"
          : "错误：Grok 任务失败。请确认本机已安装 Grok Build 并已登录。"
    });
  }
  await taskStore.upsert(latest);
  await publishStoredTaskSnapshot(options.threadId);
  // Headless turn fully settled — run any follow-ups queued while this turn was active.
  scheduleDrainTurnQueue(options.threadId);
}

async function handleCommand(command: ClientCommand): Promise<void> {
  // host.refresh: status + re-import local Claude/Grok sessions for web list.
  if (command.type === "host.refresh") {
    // Always re-push agentVersion first so web update banners clear quickly after client upgrade.
    publishAgentMeta({ agentVersion: PRODUCT_VERSION });
    await publishHostStatus();
    try {
      await importLocalCliSessions(taskStore, DEFAULT_SYNC_LIMIT);
      await publishRecentMultiCliSnapshots(DEFAULT_SYNC_LIMIT);
    } catch {
      // optional
    }
    return;
  }
  if (command.type === "host.quota.refresh") {
    const quotas = (await refreshEngineQuotas(command.cliEngine)).map(sanitizeEngineQuota);
    const summaryRaw = quotas
      .map((item) => {
        const head = item.label || item.engine;
        if (item.amountRemaining != null) {
          return `${head}: 剩余 ${item.currency === "USD" || !item.currency ? "$" : item.currency}${item.amountRemaining}${item.amountLimit != null ? ` / ${item.amountLimit}` : ""}`;
        }
        if (item.remainingPercent != null) return `${head}: 剩余 ${Math.round(item.remainingPercent)}%`;
        if (item.remaining != null && item.limit != null) return `${head}: ${item.remaining}/${item.limit}`;
        return `${head}: ${item.detail?.split("\n")[0] || "见详情"}`;
      })
      .join(" · ");
    const summary = summaryRaw.length > 4000 ? `${summaryRaw.slice(0, 3999)}…` : summaryRaw;
    await publish({
      type: "host.quota",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      engineQuotas: quotas,
      ...(quotas.length
        ? (summary ? { detail: summary } : {})
        : { detail: "未能从本机 CLI 读取订阅额度。请确认对应引擎已安装并登录。" })
    }, true);
    // Also attach to host.status so reconnects keep the last sample briefly.
    await publishHostStatus();
    return;
  }
  // host.set_cli_engine kept for protocol compatibility; engine is chosen per-task on web.
  if (command.type === "host.set_cli_engine") {
    publishAgentMeta({ agentVersion: PRODUCT_VERSION });
    await publishHostStatus();
    return;
  }
  let localThreadId = "threadId" in command ? command.threadId : undefined;
  try {
    if (command.type === "task.create") {
      if (!isAllowedWorkspace(command.cwd)) throw new Error("工作目录不在代理白名单中");
      const mode = command.permissionMode ?? "ask-for-approval";
      if (!command.cliEngine) throw new Error("请在网页端选择编码引擎后再下发任务");
      const engine = normalizeCliEngine(command.cliEngine);
      if (engine === "claude" || engine === "grok" || engine === "cursor") {
        const threadId = crypto.randomUUID();
        localThreadId = threadId;
        await ensureWorkspaceTrusted(engine, command.cwd);
        await runHeadlessTaskTurn({
          engine,
          threadId,
          cwd: command.cwd,
          prompt: command.prompt,
          ...(command.title ? { title: command.title } : {}),
          permissionMode: mode,
          isNew: true,
          ...(command.model ? { model: command.model } : {}),
          ...(command.reasoningEffort ? { reasoningEffort: command.reasoningEffort } : {})
        });
        return;
      }
      // Pre-trust project root so Codex app-server does not hang on the interactive
      // "Do you trust the contents of this directory?" prompt (no TTY in remote mode).
      const absoluteCwd = resolveAbsoluteCwd(command.cwd);
      await ensureCodexTrustedAndReady(absoluteCwd);
      const startParams: Record<string, unknown> = { ...threadStartParams(absoluteCwd, mode) };
      if (command.model) startParams.model = command.model;
      if (command.reasoningEffort) {
        // Codex app-server / config use model_reasoning_effort style values.
        startParams.modelReasoningEffort = command.reasoningEffort;
      }
      let started: any;
      try {
        started = await codex!.request("thread/start", startParams);
      } catch {
        // Older app-server builds may reject model fields — retry bare params.
        started = await codex!.request("thread/start", threadStartParams(absoluteCwd, mode));
      }
      const thread = started.thread;
      localThreadId = thread.id;
      if (command.title) await codex!.request("thread/name/set", { threadId: thread.id, name: command.title });
      const threadCwd = preferTaskCwd(thread?.cwd, absoluteCwd);
      await taskStore.upsert({
        threadId: thread.id,
        engine: "codex",
        providerSessionId: thread.id,
        cwd: threadCwd,
        title: command.title || command.prompt.slice(0, 80),
        status: "active",
        createdAt: Date.now() / 1000,
        updatedAt: Date.now() / 1000,
        messages: [],
        ...(command.model ? { model: command.model } : {}),
        ...(command.reasoningEffort ? { reasoningEffort: command.reasoningEffort } : {})
      });
      await publishThread(thread.id);
      startLocalActivity(thread.id, command.prompt, command.title || command.prompt.slice(0, 80), "codex");
      const turnPayload: Record<string, unknown> = {
        threadId: thread.id,
        clientUserMessageId: command.commandId,
        input: [{ type: "text", text: command.prompt, text_elements: [] }]
      };
      if (command.model) turnPayload.model = command.model;
      if (command.reasoningEffort) turnPayload.modelReasoningEffort = command.reasoningEffort;
      let turn: any;
      try {
        turn = await codex!.request("turn/start", turnPayload);
      } catch {
        // Older app-server builds may reject model/effort fields — retry bare params.
        turn = await codex!.request("turn/start", {
          threadId: thread.id,
          clientUserMessageId: command.commandId,
          input: [{ type: "text", text: command.prompt, text_elements: [] }]
        });
      }
      activeTurnByThread.set(thread.id, String(turn.turn.id));
      await publish({ type: "turn.started", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: thread.id, turnId: turn.turn.id, prompt: command.prompt }, true);
      return;
    }
    if (command.type === "thread.resume") {
      const stored = taskStore.get(command.threadId);
      if (stored && stored.engine !== "codex") {
        await publishStoredTaskSnapshot(command.threadId);
        return;
      }
      if (stored?.cwd) await ensureCodexTrustedAndReady(stored.cwd);
      else await ensureCodex();
      await codex!.request("thread/resume", { threadId: command.threadId });
      await publishThread(command.threadId);
      return;
    }
    if (command.type === "turn.start") {
      // If this thread already has a running turn, durable-queue the follow-up
      // so closing the browser does not drop it (web localStorage alone is not enough).
      if (isThreadTurnBusy(command.threadId)) {
        await enqueueTurnStart(command);
        return;
      }
      turnStartingByThread.add(command.threadId);
      try {
        logInfo("开始执行 turn.start", `thread=${command.threadId.slice(0, 8)} prompt=${command.prompt.slice(0, 80)}`);
        const mode = command.permissionMode ?? "ask-for-approval";
        const stored = taskStore.get(command.threadId);
        if (stored && (stored.engine === "claude" || stored.engine === "grok" || stored.engine === "cursor")) {
          // Persist UI-selected model/effort before the turn so refresh/import keep them.
          if (command.model || command.reasoningEffort) {
            if (command.model) stored.model = command.model;
            if (command.reasoningEffort) stored.reasoningEffort = command.reasoningEffort;
            await taskStore.upsert(stored);
          }
          await ensureWorkspaceTrusted(stored.engine, stored.cwd);
          await runHeadlessTaskTurn({
            engine: stored.engine,
            threadId: command.threadId,
            cwd: stored.cwd,
            prompt: command.prompt,
            title: stored.title,
            permissionMode: mode,
            isNew: false,
            ...(command.model || stored.model ? { model: command.model || stored.model } : {}),
            ...(command.reasoningEffort || stored.reasoningEffort
              ? { reasoningEffort: command.reasoningEffort || stored.reasoningEffort }
              : {})
          });
          return;
        }
        const codexCwd = stored?.cwd || "";
        if (codexCwd) await ensureCodexTrustedAndReady(codexCwd);
        else await ensureCodex();
        await codex!.request("thread/resume", threadResumeParams(command.threadId, mode));
        startLocalActivity(command.threadId, command.prompt, "继续远程任务", "codex");
        if (stored && (command.model || command.reasoningEffort)) {
          if (command.model) stored.model = command.model;
          if (command.reasoningEffort) stored.reasoningEffort = command.reasoningEffort;
          await taskStore.upsert(stored);
        }
        const turnPayload: Record<string, unknown> = {
          threadId: command.threadId,
          clientUserMessageId: command.commandId,
          input: [{ type: "text", text: command.prompt, text_elements: [] }]
        };
        const model = command.model || stored?.model;
        const effort = command.reasoningEffort || stored?.reasoningEffort;
        if (model) turnPayload.model = model;
        if (effort) turnPayload.modelReasoningEffort = effort;
        let result: any;
        try {
          result = await codex!.request("turn/start", turnPayload);
        } catch {
          result = await codex!.request("turn/start", {
            threadId: command.threadId,
            clientUserMessageId: command.commandId,
            input: [{ type: "text", text: command.prompt, text_elements: [] }]
          });
        }
        activeTurnByThread.set(command.threadId, String(result.turn.id));
        await publish({ type: "turn.started", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: command.threadId, turnId: result.turn.id, prompt: command.prompt }, true);
        return;
      } finally {
        turnStartingByThread.delete(command.threadId);
      }
    }
    if (command.type === "turn.steer") {
      await ensureCodex();
      await codex!.request("thread/resume", { threadId: command.threadId });
      if (!publicState.activities.some((item) => item.threadId === command.threadId && item.status === "processing")) {
        startLocalActivity(command.threadId, command.prompt, "追加远程指令", "codex");
      }
      pendingPrompts.set(command.threadId, command.prompt);
      await codex!.request("turn/steer", {
        threadId: command.threadId,
        expectedTurnId: command.turnId,
        clientUserMessageId: command.commandId,
        input: [{ type: "text", text: command.prompt, text_elements: [] }]
      });
      activeTurnByThread.set(command.threadId, String(command.turnId));
      await publish({ type: "turn.started", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: command.threadId, turnId: command.turnId, prompt: command.prompt }, true);
      return;
    }
    if (command.type === "turn.interrupt") {
      // Stop cancels both the active turn and any durable follow-ups for this thread.
      logWarn("收到 turn.interrupt，停止任务并清空队列", command.threadId.slice(0, 8));
      await clearTurnQueue(command.threadId);
      const stored = taskStore.get(command.threadId);
      const listed = publicState.tasks.find((item) => item.threadId === command.threadId);
      const engine = stored?.engine || listed?.engine;
      // Claude/Grok: force-kill process tree (cmd shim leaves orphans if only child.kill()).
      if ((engine && engine !== "codex") || isHeadlessThreadActive(command.threadId)) {
        const killed = interruptHeadlessThread(command.threadId);
        finishLocalActivity(command.threadId, "interrupted");
        activeTurnByThread.delete(command.threadId);
        turnStartingByThread.delete(command.threadId);
        if (stored) await taskStore.setStatus(command.threadId, "interrupted");
        await flushRemoteDeltas();
        await publish({
          type: "turn.completed",
          eventId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          threadId: command.threadId,
          turnId: command.turnId,
          status: "interrupted"
        }, true, "completed");
        if (!killed) {
          await publish({
            type: "error",
            eventId: crypto.randomUUID(),
            occurredAt: new Date().toISOString(),
            threadId: command.threadId,
            message: "未找到正在运行的本地 CLI 进程（可能已结束）。已将任务标记为停止。"
          }, true);
        }
        return;
      }
      await ensureCodex();
      await Promise.race([
        codex!.request("turn/interrupt", { threadId: command.threadId, turnId: command.turnId }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
      finishLocalActivity(command.threadId, "interrupted");
      activeTurnByThread.delete(command.threadId);
      turnStartingByThread.delete(command.threadId);
      await flushRemoteDeltas();
      await publish({ type: "turn.completed", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: command.threadId, turnId: command.turnId, status: "interrupted" }, true, "completed");
      return;
    }
    if (command.type === "approval.resolve") {
      await ensureCodex();
      const requestType = pendingRequestTypes.get(String(command.requestId));
      pendingRequestTypes.delete(String(command.requestId));
      if (requestType === "input") codex!.respond(command.requestId, { answers: {} });
      else if (requestType === "permission") codex!.respondError(command.requestId, "Declined by remote user");
      else codex!.respond(command.requestId, { decision: command.decision });
      return;
    }
    if (command.type === "sync.request") {
      // Refresh workspaces for the web new-task picker before streaming threads.
      await publishHostStatus();
      const syncLimit = command.limit ?? DEFAULT_SYNC_LIMIT;
      // Import local Claude/Grok CLI sessions (up to syncLimit each), then publish them.
      try {
        await importLocalCliSessions(taskStore, syncLimit);
      } catch {
        // ignore
      }
      // Up to syncLimit snapshots per multi-CLI engine (not a single shared pool).
      let multiCliCount = 0;
      try {
        multiCliCount = await publishRecentMultiCliSnapshots(syncLimit, command.query);
      } catch {
        // ignore
      }
      let result = { threadCount: 0, partial: true };
      try {
        await ensureCodex();
        result = await syncAllThreads({
          limit: syncLimit,
          ...(command.query !== undefined ? { query: command.query } : {})
        });
        // Keep local 接力 list aligned with what was just read from Codex.
        await refreshLocalTasks(syncLimit).catch(() => undefined);
      } catch (error) {
        // Codex optional when only Claude/Grok tasks exist.
        handleError(error);
      }
      await publish({
        type: "sync.completed",
        eventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        threadCount: result.threadCount + multiCliCount,
        partial: result.partial,
        ...(command.query ? { query: command.query } : {})
      }, false);
    }
  } catch (error) {
    if (localThreadId) {
      finishLocalActivity(localThreadId, "failed");
      activeTurnByThread.delete(localThreadId);
      turnStartingByThread.delete(localThreadId);
    }
    if (command.type === "turn.start") {
      turnStartingByThread.delete(command.threadId);
      // Failed start should still try the next durable queued prompt.
      scheduleDrainTurnQueue(command.threadId);
    }
    await publish({
      type: "error",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : "Command failed",
      commandId: command.commandId,
      ...("threadId" in command ? { threadId: command.threadId } : {})
    }, true);
  }
}

async function handleCodexMessage(message: Record<string, any>): Promise<void> {
  if (message.method === "item/started") {
    const params = message.params ?? {};
    const item = params.item ?? {};
    const label = activityItemLabel(item);
    const key = activityItemKey(params);
    const threadId = String(params.threadId ?? "");
    const items = activityItemsByThread.get(threadId) ?? new Map<string, string>();
    if (label && key && !items.has(key)) {
      items.set(key, item.type);
      activityItemsByThread.set(threadId, items);
      appendLocalActivityStage(threadId, `▶ ${label}`);
      // Stage markers stream to web progressively (CLI-like phases).
      queueRemoteDelta(threadId, `stage:${key}`, `\n▶ ${label}\n`);
    }
  }
  if (message.method === "item/completed") {
    const params = message.params ?? {};
    const item = params.item ?? {};
    const key = activityItemKey(params);
    const threadId = String(params.threadId ?? "");
    const items = activityItemsByThread.get(threadId);
    if (key && items?.has(key)) {
      items.delete(key);
      const result = activityItemResult(item);
      if (result) {
        appendLocalActivityStage(threadId, `✓ ${result}`);
        queueRemoteDelta(threadId, `stage:${key}:done`, `\n✓ ${result}\n`);
      }
    }
    // Capture file patches for the Diff tab as Codex applies them.
    if (String(item.type ?? "") === "fileChange" && threadId) {
      const patch = extractFileChangeDiff(item);
      if (patch) appendEngineDiffChunk(threadId, patch);
    }
  }
  if (message.method === "item/agentMessage/delta") {
    const threadId = String(message.params?.threadId ?? "");
    const itemId = String(message.params?.itemId ?? message.params?.item?.id ?? "assistant");
    const delta = String(message.params?.delta ?? "");
    appendLocalActivity(threadId, delta);
    queueRemoteDelta(threadId, itemId, delta);
  }
  // Command / tool output chunks when the app-server streams them.
  // Prefix exec: so web concise mode can hide process streams while keeping final replies.
  if (
    message.method === "item/commandExecution/outputDelta"
    || message.method === "item/commandExecution/delta"
    || message.method === "item/mcpToolCall/outputDelta"
  ) {
    const params = message.params ?? {};
    const threadId = String(params.threadId ?? "");
    const rawItemId = String(params.itemId ?? params.item?.id ?? "command");
    const itemId = rawItemId.startsWith("exec:") ? rawItemId : `exec:${rawItemId}`;
    const delta = String(params.delta ?? params.chunk ?? params.output ?? "");
    if (delta) {
      appendLocalActivity(threadId, delta);
      queueRemoteDelta(threadId, itemId, delta);
    }
  }
  if (message.method === "agent/log") {
    const line = String(message.params?.line ?? "").trim();
    if (line) {
      for (const threadId of activeTurnByThread.keys()) {
        appendLocalActivity(threadId, `\n${line}`);
        queueRemoteDelta(threadId, "cli-log", `\n${line}\n`);
      }
    }
  }
  if (message.method === "turn/started") {
    const params = message.params ?? {};
    const threadId = String(params.threadId ?? params.turn?.threadId ?? "");
    const turnId = String(params.turnId ?? params.turn?.id ?? "");
    if (threadId && turnId) activeTurnByThread.set(threadId, turnId);
    if (threadId) {
      clearEngineDiffChunks(threadId);
      touchAgentTask(threadId, { status: "active", engine: "codex" });
    }
  }
  if (message.method === "turn/completed") {
    const params = message.params;
    const threadId = String(params.threadId);
    const turnId = String(params.turn?.id ?? params.turnId ?? "");
    const turnStatus = String(params.turn?.status ?? params.status ?? "unknown");
    const errorMessage = extractCodexTurnError(params.turn) || extractCodexTurnError(params);
    finishLocalActivity(threadId, turnStatus);
    await flushRemoteDeltas();
    activeTurnByThread.delete(threadId);
    turnStartingByThread.delete(threadId);
    const failed = isTerminalTurnStatus(turnStatus) && /error|fail/i.test(turnStatus);
    if (failed && errorMessage) {
      // Persist into multi-cli store when present; always publish for web UI.
      const stored = taskStore.get(threadId);
      if (stored) {
        const text = `任务失败（${turnStatus}）：${errorMessage}`;
        const already = stored.messages.some((m) => m.role === "system" && m.text.includes(errorMessage));
        if (!already) {
          stored.messages.push({ id: crypto.randomUUID(), role: "system", text });
        }
        stored.status = turnStatus;
        stored.updatedAt = Date.now() / 1000;
        await taskStore.upsert(stored);
      }
      await publish({
        type: "error",
        eventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        threadId,
        message: `任务失败（${turnStatus}）：${errorMessage}`
      }, true);
    } else if (failed) {
      await publish({
        type: "error",
        eventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        threadId,
        message: `任务失败（${turnStatus}）。本机 Codex 未返回详细错误信息，请在客户端「任务 → 接力」查看终端输出。`
      }, true);
    }
    await publish({
      type: "turn.completed",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      threadId: params.threadId,
      turnId: params.turn?.id ?? turnId,
      status: turnStatus,
      ...(errorMessage ? { errorMessage } : {})
    }, true, "completed");
    // Workspace git diff + any fileChange patches → Diff tab.
    try {
      if (turnId) await publishTaskDiff(threadId, turnId);
    } catch {
      // ignore
    }
    // Refresh snapshot so final assistant text / lastDiff / system errors are complete.
    // Touch updatedAt so web/agent lists reorder by last activity (not create time).
    try { await publishThread(threadId, { touch: true }); } catch { /* ignore */ }
    // Codex turn finished — drain durable follow-up prompts for this thread.
    scheduleDrainTurnQueue(threadId);
  }
  if (message.method === "serverRequest/resolved") {
    pendingRequestTypes.delete(String(message.params.requestId));
    await publish({ type: "request.resolved", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), requestId: message.params.requestId, threadId: message.params.threadId }, true);
  }
  if (message.id !== undefined && message.method === "item/commandExecution/requestApproval") {
    pendingRequestTypes.set(String(message.id), "command");
    const params = message.params;
    await publish({
      type: "approval.requested", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), requestId: message.id,
      threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, approvalType: "command",
      title: "允许 Codex 执行命令？", detail: [params.command, params.cwd, params.reason].filter(Boolean).join("\n"),
      availableDecisions: ["accept", "decline", "cancel"]
    }, true, "approval");
  }
  if (message.id !== undefined && message.method === "item/fileChange/requestApproval") {
    pendingRequestTypes.set(String(message.id), "file");
    const params = message.params;
    await publish({
      type: "approval.requested", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), requestId: message.id,
      threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, approvalType: "file",
      title: "允许 Codex 修改文件？", detail: params.reason || params.grantRoot || "Codex 请求写入工作区。",
      availableDecisions: ["accept", "decline", "cancel"]
    }, true, "approval");
  }
  if (message.id !== undefined && message.method === "item/tool/requestUserInput") {
    pendingRequestTypes.set(String(message.id), "input");
    const params = message.params;
    await publish({
      type: "approval.requested", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), requestId: message.id,
      threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, approvalType: "input",
      title: "Codex 需要补充信息", detail: JSON.stringify(params.questions, null, 2), availableDecisions: ["cancel"]
    }, true, "approval");
  }
  if (message.id !== undefined && message.method === "item/permissions/requestApproval") {
    pendingRequestTypes.set(String(message.id), "permission");
    const params = message.params;
    await publish({
      type: "approval.requested", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), requestId: message.id,
      threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, approvalType: "permission",
      title: "Codex 请求额外权限", detail: JSON.stringify({ reason: params.reason, permissions: params.permissions }, null, 2), availableDecisions: ["cancel"]
    }, true, "approval");
  }
}

function resolveReportedEngineVersion(engine: CliEngine): string {
  if (engine === "codex") {
    const fromEnv = publicState.environment.codexVersion || codexVersion;
    if (fromEnv && fromEnv !== "unknown") return fromEnv;
    const fromList = publicState.availableEngines.find((item) => item.engine === "codex");
    if (fromList?.version?.trim()) return fromList.version.trim();
    return publicState.environment.codexInstalled || publicState.environment.codexCompatible
      ? "unknown"
      : "not-installed";
  }
  const info = publicState.availableEngines.find((item) => item.engine === engine);
  if (info?.version?.trim()) return info.version.trim();
  if (info?.ready) return "unknown";
  return "not-installed";
}

function publishAgentMeta(fields: {
  name?: string;
  codexVersion?: string;
  claudeVersion?: string;
  grokVersion?: string;
  cursorVersion?: string;
  platform?: string;
  agentVersion?: string;
} = {}): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({
      type: "agent.meta",
      name: fields.name ?? resolvedDisplayName(),
      codexVersion: fields.codexVersion ?? resolveReportedEngineVersion("codex"),
      claudeVersion: fields.claudeVersion ?? resolveReportedEngineVersion("claude"),
      grokVersion: fields.grokVersion ?? resolveReportedEngineVersion("grok"),
      cursorVersion: fields.cursorVersion ?? resolveReportedEngineVersion("cursor"),
      platform: fields.platform ?? `${process.platform} ${os.release()}`,
      agentVersion: fields.agentVersion ?? PRODUCT_VERSION
    }));
  } catch {
    // ignore
  }
}

async function refreshAvailableEngines(): Promise<void> {
  const codexReady = Boolean(publicState.environment.codexCompatible || codex);
  const [availableEngines, engineCapabilities] = await Promise.all([
    detectAvailableEngines({
      codexReady,
      codexVersion: codexVersion || publicState.environment.codexVersion || "unknown"
    }),
    discoverEngineCapabilities().catch(() => [] as EngineCapability[])
  ]);
  updateState({
    availableEngines,
    engineCapabilities,
    cliEngine: taskStore.getDefaultEngine()
  });
}

/** Last quota sample from host.quota.refresh (attached to subsequent host.status). */
let lastEngineQuotas: EngineQuota[] = [];

async function refreshEngineQuotas(filter?: CliEngine): Promise<EngineQuota[]> {
  const quotas = await queryEngineQuotas(filter, {
    codexInstalled: Boolean(
      publicState.environment.codexInstalled || publicState.environment.codexCompatible
    )
  });
  lastEngineQuotas = quotas;
  return quotas;
}

async function publishHostStatus(): Promise<void> {
  // Keep encrypted host.status for workspaces/online UX; version/name also go via agent.meta for DB.
  await refreshAvailableEngines().catch(() => undefined);
  // Always stamp the running build version so web banners update without waiting for a full re-pair.
  publishAgentMeta({ agentVersion: PRODUCT_VERSION });
  await publish({
    type: "host.status", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), online: true,
    name: resolvedDisplayName(), platform: `${process.platform} ${os.release()}`, codexVersion,
    workspaces: config.workspaces,
    cliEngine: taskStore.getDefaultEngine(),
    availableEngines: publicState.availableEngines,
    engineCapabilities: publicState.engineCapabilities,
    agentVersion: PRODUCT_VERSION,
    ...(lastEngineQuotas.length ? { engineQuotas: lastEngineQuotas } : {})
  }, true);
}

async function publishThread(threadId: string, options: { touch?: boolean } = {}): Promise<void> {
  const result = await codex!.request("thread/read", { threadId, includeTurns: true });
  const snapshot = threadToSnapshot(result.thread);
  const stored = taskStore.get(threadId);
  const cwd = preferTaskCwd(snapshot.cwd, stored?.cwd);
  if (stored && cwd && stored.cwd !== cwd) {
    stored.cwd = cwd;
    stored.updatedAt = Date.now() / 1000;
    await taskStore.upsert(stored);
  }
  const updatedAt = options.touch
    ? Math.max(normalizeUnixSeconds(snapshot.updatedAt), Date.now() / 1000)
    : normalizeUnixSeconds(snapshot.updatedAt);
  const task: AgentTask = {
    threadId: snapshot.threadId,
    title: snapshot.title,
    cwd,
    status: snapshot.status,
    updatedAt,
    engine: "codex"
  };
  updateState({
    tasks: [task, ...publicState.tasks.filter((item) => item.threadId !== task.threadId)]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 200)
  });
  // Codex app-server snapshots do not carry our UI model/effort — merge from local task store.
  await publish({
    type: "thread.snapshot",
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    ...snapshot,
    cwd,
    updatedAt,
    cliEngine: "codex",
    ...(stored?.model ? { model: stored.model } : {}),
    ...(stored?.reasoningEffort ? { reasoningEffort: stored.reasoningEffort } : {}),
    ...(stored?.lastDiff ? { diff: stored.lastDiff } : {}),
    ...(stored?.providerSessionId ? { providerSessionId: stored.providerSessionId } : { providerSessionId: threadId })
  }, true);
}

/** Load 接力 task list from local Codex (thread/list) — independent of web sync. */
async function refreshLocalTasks(limit = 50): Promise<void> {
  const listLimit = Math.min(100, Math.max(1, limit));
  // Pull sessions created by local Claude/Grok CLIs into the index so web sync can see them.
  try {
    await importLocalCliSessions(taskStore, listLimit);
  } catch {
    // ignore import failures
  }
  const storedTasks: AgentTask[] = taskStore.list(listLimit).map((task) => ({
    threadId: task.threadId,
    title: task.title,
    cwd: resolveAbsoluteCwd(task.cwd),
    status: task.status,
    updatedAt: task.updatedAt,
    engine: task.engine
  }));
  let codexTasks: AgentTask[] = [];
  try {
    if (!codex) await ensureCodex();
    const response = await codex!.request("thread/list", { limit: listLimit, sortDirection: "desc" });
    let threads: Array<Record<string, any>> = response.data ?? [];
    threads = [...threads].sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
    codexTasks = threads.map((thread) => ({
      threadId: String(thread.id),
      title: String(thread.name || thread.preview || "未命名任务"),
      cwd: resolveAbsoluteCwd(String(thread.cwd || "")),
      status: typeof thread.status === "string" ? thread.status : JSON.stringify(thread.status ?? "unknown"),
      updatedAt: normalizeUnixSeconds(thread.updatedAt),
      engine: "codex" as const
    }));
  } catch {
    // Codex optional when listing Claude/Grok tasks.
  }
  const byId = new Map<string, AgentTask>();
  // Prefer the record with the newer last-activity time when the same id appears twice.
  for (const task of [...storedTasks, ...codexTasks]) {
    const prev = byId.get(task.threadId);
    const normalized: AgentTask = {
      ...task,
      updatedAt: normalizeUnixSeconds(task.updatedAt)
    };
    if (!prev || normalized.updatedAt >= normalizeUnixSeconds(prev.updatedAt)) {
      byId.set(task.threadId, normalized);
    }
  }
  const tasks = [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, listLimit);
  updateState({ tasks });
}

/** Recent tasks to fully sync per coding engine (Codex / Claude / Grok each). */
const DEFAULT_SYNC_LIMIT = 10;
const SEARCH_LIST_LIMIT = 100;

/** Publish up to `limit` recent non-Codex tasks for each multi-CLI engine. */
async function publishRecentMultiCliSnapshots(limit: number, query?: string): Promise<number> {
  const q = query?.trim().toLowerCase() ?? "";
  const counts: Record<"claude" | "grok" | "cursor", number> = { claude: 0, grok: 0, cursor: 0 };
  let published = 0;
  // Pull a wider window so each engine can still fill its quota after filtering.
  for (const task of taskStore.list(Math.max(limit * 10, 50))) {
    if (task.engine !== "claude" && task.engine !== "grok" && task.engine !== "cursor") continue;
    if (counts[task.engine] >= limit) continue;
    if (q && !`${task.title}\n${task.cwd}\n${task.status}`.toLowerCase().includes(q)) continue;
    await publishStoredTaskSnapshot(task.threadId);
    counts[task.engine] += 1;
    published += 1;
  }
  return published;
}

function threadMatchesQuery(thread: Record<string, any>, query: string): boolean {
  const hay = [
    thread.name,
    thread.preview,
    thread.cwd,
    thread.id,
    thread.status
  ].map((value) => String(value ?? "").toLowerCase()).join("\n");
  return hay.includes(query);
}

/**
 * Lazy sync: by default only the most recently updated N threads (desc).
 * With query: scan a larger list window and publish matches so search can find older tasks.
 */
async function syncAllThreads(options: { limit?: number; query?: string } = {}): Promise<{ threadCount: number; partial: boolean }> {
  await ensureCodex();
  const query = options.query?.trim().toLowerCase() ?? "";
  const limit = Math.min(100, Math.max(1, options.limit ?? DEFAULT_SYNC_LIMIT));
  const listLimit = query ? SEARCH_LIST_LIMIT : limit;
  const response = await codex!.request("thread/list", { limit: listLimit, sortDirection: "desc" });
  let threads: Array<Record<string, any>> = response.data ?? [];
  // Ensure newest-first by updatedAt when available.
  threads = [...threads].sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0));
  if (query) {
    threads = threads.filter((thread) => threadMatchesQuery(thread, query));
  } else {
    threads = threads.slice(0, limit);
  }
  const total = threads.length;
  let published = 0;
  for (const thread of threads) {
    try {
      await publish({
        type: "sync.progress",
        eventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        current: published,
        total,
        title: String(thread.name || thread.preview || thread.id || "")
      }, false);
      await publishThread(String(thread.id));
      published += 1;
    } catch (error) {
      handleError(error);
    }
  }
  return {
    threadCount: published,
    // Without a search query we only load the recent window — mark partial for the UI.
    partial: !query
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function resolveRelayTask(threadId: string): Promise<AgentTask & { providerSessionId?: string }> {
  const stored = taskStore.get(threadId);
  if (stored) {
    return {
      threadId: stored.threadId,
      title: stored.title,
      cwd: stored.cwd,
      status: stored.status,
      updatedAt: stored.updatedAt,
      engine: stored.engine,
      providerSessionId: stored.providerSessionId
    };
  }
  const cached = publicState.tasks.find((item) => item.threadId === threadId);
  if (cached?.engine && cached.engine !== "codex") return cached;
  if (cached?.engine === "codex" || !cached) {
    try {
      await ensureCodex();
      const result = await codex!.request("thread/read", { threadId, includeTurns: false });
      const snapshot = threadToSnapshot(result.thread);
      const task: AgentTask = {
        threadId: snapshot.threadId,
        title: snapshot.title,
        cwd: snapshot.cwd,
        status: snapshot.status,
        updatedAt: snapshot.updatedAt,
        engine: "codex"
      };
      updateState({
        tasks: [task, ...publicState.tasks.filter((item) => item.threadId !== task.threadId)]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, 200)
      });
      return task;
    } catch {
      if (cached) return cached;
      throw new Error("任务不存在或会话已失效");
    }
  }
  return cached;
}

async function openExternalTerminal(cwd: string, commandLine: string): Promise<void> {
  const proxy = await collectLocalProxyEnv();
  const env = mergeProxyIntoEnv(process.env, proxy);

  if (process.platform === "win32") {
    // Electron GUI-spawned `cmd /k` with long `set A=… && set B=… && call …` lines is unreliable
    // (window may never appear). Use the same WScript-visible console path as installers.
    const proxyLines = await proxyShellLines("win32");
    const workdir = cwd && cwd.trim() ? cwd : os.homedir();
    await openWindowsVisibleConsole([
      ...proxyLines,
      `cd /d ${quoteWinArg(workdir)}`,
      "echo.",
      "echo [AnytimeVibe] CLI handoff",
      "echo.",
      commandLine
    ]);
    return;
  }
  if (process.platform === "darwin") {
    const prefix = proxyShellPrefix(proxy);
    const fullCommand = `${prefix}${commandLine}`;
    const command = `cd ${shellQuote(cwd || os.homedir())} && ${fullCommand}`;
    await execFileAsync("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`], {
      env
    });
    await execFileAsync("osascript", ["-e", "tell application \"Terminal\" to activate"]);
    return;
  }
  throw new Error("当前系统暂不支持启动接力终端。");
}

function quoteWinArg(value: string): string {
  if (!/[\s"]/g.test(value)) return value;
  return `"${value.replace(/"/g, "\\\"")}"`;
}

/**
 * Build a command line for `cmd.exe /k ...`.
 * `.cmd`/`.bat` must be invoked with `call` when chained after `set ... &&`,
 * otherwise Windows treats the batch as terminating the parent command and Codex resume never runs.
 */
function formatWinCliCommand(binary: string, args: string[]): string {
  const body = [quoteWinArg(binary), ...args.map(quoteWinArg)].join(" ");
  if (/\.(cmd|bat)$/i.test(binary)) return `call ${body}`;
  return body;
}

async function resolveCodexBinaryForRelay(): Promise<string> {
  // Always re-resolve from PATH/registry so GUI-launched shells get an absolute binary.
  try {
    await applyLoginPathToProcess();
  } catch {
    // ignore
  }
  if (process.platform === "win32") {
    const hit = (await findOnWindowsPath("codex.cmd"))
      || (await findOnWindowsPath("codex.exe"))
      || (await findOnWindowsPath("codex"));
    if (hit) {
      codexCommand = normalizeWindowsCommandPath(hit);
      return codexCommand;
    }
  } else {
    try {
      const { stdout } = await execFileAsync("which", ["codex"], { timeout: 5_000, env: process.env });
      const hit = stdout.trim().split(/\r?\n/).find(Boolean);
      if (hit) {
        codexCommand = hit;
        return codexCommand;
      }
    } catch {
      // ignore
    }
  }
  const current = (codexCommand || "").trim();
  if (current && (path.isAbsolute(current) || /[\\/]/.test(current))) return current;
  if (current) return current;
  throw new Error("未找到 Codex CLI，请先在「本机环境」中安装兼容版 Codex。");
}

async function relayTaskToCli(threadId: string): Promise<void> {
  const task = await resolveRelayTask(threadId);
  const stored = taskStore.get(threadId);
  const engine = task.engine ?? stored?.engine ?? "codex";
  const cwd = task.cwd || os.homedir();
  // Only resume with provider-native session ids (not our product thread UUID unless they match).
  const providerSessionId = (stored?.providerSessionId || "").trim();

  // Pre-accept directory trust prompts before opening an interactive handoff terminal.
  await ensureWorkspaceTrusted(
    engine === "claude" || engine === "grok" || engine === "codex" || engine === "cursor"
      ? engine
      : "codex",
    cwd
  );

  if (engine === "claude") {
    const binary = await resolveEngineBinary("claude");
    if (!binary) throw new Error("未找到 Claude Code CLI，无法接力");
    // Do not force --model (default "sonnet" often maps to offline proxy models and
    // drops the user into the interactive model picker). Only pass when explicitly set.
    const model = (stored?.model || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "").trim();
    const args = [
      ...(model ? ["--model", model] : []),
      ...(providerSessionId ? ["--resume", providerSessionId] : [])
    ];
    if (process.platform === "win32") {
      await openExternalTerminal(cwd, formatWinCliCommand(binary, args));
    } else {
      await openExternalTerminal(
        cwd,
        [shellQuote(binary), ...args.map((part) => (part.startsWith("-") ? part : shellQuote(part)))].join(" ")
      );
    }
    return;
  }

  if (engine === "grok") {
    const binary = await resolveEngineBinary("grok");
    if (!binary) throw new Error("未找到 Grok Build CLI，无法接力");
    const model = (process.env.GROK_MODEL || process.env.XAI_MODEL || "").trim();
    const args = [
      ...(providerSessionId ? ["--resume", providerSessionId] : []),
      ...(model ? ["--model", model] : []),
      "--cwd", cwd
    ];
    if (process.platform === "win32") {
      await openExternalTerminal(cwd, formatWinCliCommand(binary, args));
    } else {
      await openExternalTerminal(
        cwd,
        [
          shellQuote(binary),
          ...(providerSessionId ? ["--resume", shellQuote(providerSessionId)] : []),
          ...(model ? ["--model", shellQuote(model)] : []),
          "--cwd", shellQuote(cwd)
        ].join(" ")
      );
    }
    return;
  }

  if (engine === "cursor") {
    const binary = await resolveEngineBinary("cursor");
    if (!binary) throw new Error("未找到 Cursor Agent CLI（cursor-agent / agent），无法接力。请安装 https://cursor.com/cn/cli 并登录（agent login）");
    const { formatCursorModelArg } = await import("./cli/model-catalog");
    const model = formatCursorModelArg(stored?.model, {
      ...(stored?.reasoningEffort ? { reasoningEffort: stored.reasoningEffort } : {})
    });
    const args = [
      ...(providerSessionId ? ["--resume", providerSessionId] : []),
      ...(model ? ["--model", model] : []),
      "--workspace", cwd
    ];
    if (process.platform === "win32") {
      await openExternalTerminal(cwd, formatWinCliCommand(binary, args));
    } else {
      await openExternalTerminal(
        cwd,
        [
          shellQuote(binary),
          ...(providerSessionId ? ["--resume", shellQuote(providerSessionId)] : []),
          ...(model ? ["--model", shellQuote(model)] : []),
          "--workspace", shellQuote(cwd)
        ].join(" ")
      );
    }
    return;
  }

  // Codex session id is the product/thread id.
  const binary = await resolveCodexBinaryForRelay();
  console.log(`[relay] codex binary=${binary} thread=${threadId} cwd=${cwd}`);
  if (process.platform === "win32") {
    // Prefer invoking via `node …/codex.js` when the discovery path is a .cmd shim —
    // some environments break on nested batch files even with `call`.
    const nodeBin = (await findOnWindowsPath("node.exe")) || (await findOnWindowsPath("node"));
    const codexJs = path.join(path.dirname(binary), "node_modules", "@openai", "codex", "bin", "codex.js");
    let commandLine = formatWinCliCommand(binary, ["resume", threadId]);
    try {
      await fs.access(codexJs);
      if (nodeBin) {
        commandLine = formatWinCliCommand(nodeBin, [codexJs, "resume", threadId]);
      }
    } catch {
      // keep call codex.cmd
    }
    await openExternalTerminal(cwd, commandLine);
    return;
  }
  if (process.platform === "darwin") {
    await openExternalTerminal(cwd, `${shellQuote(binary)} resume ${shellQuote(threadId)}`);
    return;
  }
  throw new Error("当前系统暂不支持启动接力终端。");
}

async function publish(event: AgentEvent, persist: boolean, hint?: "approval" | "completed"): Promise<void> {
  agentEventSchema.parse(event);
  if (!socket || socket.readyState !== WebSocket.OPEN || !config.hostId || !syncKey) return;
  config.sequence += 1;
  await saveConfig();
  const envelope = await createEnvelope(config.hostId, config.sequence, syncKey, event, { persist, ...(hint ? { hint } : {}) });
  socket.send(JSON.stringify(envelope));
}

async function addWorkspace(): Promise<PublicState> {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  const selected = result.filePaths[0];
  if (!selected) return publicState;
  const resolved = path.resolve(selected);
  if (!config.workspaces.some((workspace) => path.resolve(workspace.path).toLowerCase() === resolved.toLowerCase())) {
    config.workspaces.push({ id: crypto.randomUUID(), name: path.basename(resolved), path: resolved });
    await saveConfig();
    updateState({ workspaces: config.workspaces });
    // Pre-trust so first remote task in this folder is not blocked by CLI trust prompts.
    await ensureWorkspaceTrustedForAllEngines(resolved);
    await publishHostStatus();
  }
  return publicState;
}

function handleError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  logError("操作失败", error instanceof Error ? error : detail);
  if (quitting || installingUpdate) return;
  const connected = socket?.readyState === WebSocket.OPEN;
  // Never stick on "incompatible" just because a Codex-only op failed while Claude/Grok work.
  // Only use incompatible when no coding engine is ready at all.
  const status = connected
    ? "online"
    : anyCodingEngineReady()
      ? (publicState.status === "connecting" ? "connecting" : "offline")
      : "incompatible";
  updateState({
    status,
    detail: connected ? `代理在线，但有一项操作失败：${detail}` : detail
  });
}

let updateListenersRegistered = false;
/** Path to the zip/installer finished by electron-updater (needed for macOS shell fallback). */
let pendingDownloadedUpdateFile: string | null = null;
/** Native Squirrel.Mac finished staging the update (macOS only). */
let macNativeUpdateReady = false;

/** True when the packaged app is still running from a mounted DMG (read-only, cannot self-update). */
function isRunningFromDmgOrReadOnlyVolume(): boolean {
  if (process.platform !== "darwin") return false;
  const exe = process.execPath || "";
  return exe.startsWith("/Volumes/") || exe.includes("/Volumes/");
}

/** Path to Foo.app for the running packaged binary. */
function getDarwinAppBundlePath(): string {
  // …/Foo.app/Contents/MacOS/<binary> → …/Foo.app
  return path.resolve(process.execPath, "..", "..", "..");
}

/**
 * macOS electron-updater relies on Squirrel.Mac, which often fails for unsigned builds.
 * Spawn a detached installer that replaces the .app after we quit, then relaunches.
 */
function launchMacZipReplaceInstaller(zipPath: string): void {
  const appBundle = getDarwinAppBundlePath();
  const script = `#!/bin/bash
set -euo pipefail
ZIP=${JSON.stringify(zipPath)}
APP_BUNDLE=${JSON.stringify(appBundle)}
LOG="$HOME/Library/Logs/AnytimeVibe-update.log"
exec >>"$LOG" 2>&1
echo "[$(date -Iseconds)] start update zip=$ZIP app=$APP_BUNDLE"

# Wait until this app process tree is gone (up to ~45s).
for i in $(seq 1 90); do
  if ! pgrep -f "$APP_BUNDLE/Contents/MacOS/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
sleep 1

if [ ! -f "$ZIP" ]; then
  echo "zip missing: $ZIP"
  exit 1
fi

TMP=$(mktemp -d /tmp/anytimevibe-update.XXXXXX)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# Unzip (ditto handles zip + resource forks on macOS)
ditto -x -k "$ZIP" "$TMP"
NEW_APP=$(find "$TMP" -name "*.app" -type d -maxdepth 4 | head -n 1 || true)
if [ -z "\${NEW_APP}" ] || [ ! -d "\${NEW_APP}" ]; then
  echo "no .app found inside zip"
  find "$TMP" -maxdepth 3 -print
  exit 1
fi

PARENT=$(dirname "$APP_BUNDLE")
if [ ! -w "$PARENT" ]; then
  echo "parent not writable: $PARENT"
  exit 1
fi

BACKUP="\${APP_BUNDLE}.bak-update"
rm -rf "$BACKUP"
if [ -d "$APP_BUNDLE" ]; then
  mv "$APP_BUNDLE" "$BACKUP"
fi
# ditto preserves attributes better than cp -R
ditto "\${NEW_APP}" "$APP_BUNDLE"
rm -rf "$BACKUP"
xattr -dr com.apple.quarantine "$APP_BUNDLE" 2>/dev/null || true

echo "update applied, launching"
open "$APP_BUNDLE" || open -a "$APP_BUNDLE" || true
echo "[$(date -Iseconds)] done"
`;
  const scriptPath = path.join(os.tmpdir(), `anytimevibe-update-${Date.now()}.sh`);
  writeFileSync(scriptPath, script, { encoding: "utf8", mode: 0o755 });
  const child = spawn("/bin/bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  console.log(`[update] mac zip installer launched: ${scriptPath} → ${appBundle}`);
}

function registerUpdateListeners(): void {
  if (updateListenersRegistered) return;
  updateListenersRegistered = true;
  // Ensure both Windows NSIS and macOS zip feeds auto-download after check.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on("checking-for-update", () => updateState({ update: { status: "checking" } }));
  autoUpdater.on("update-available", (info) => {
    updateState({ update: { status: "available", version: info.version, message: "正在下载更新…" } });
    // Explicit download: on some macOS builds autoDownload alone does not start.
    void autoUpdater.downloadUpdate().catch((error: Error) => {
      if (installingUpdate) return;
      updateState({ update: { status: "error", message: error.message || "下载更新失败" } });
    });
  });
  autoUpdater.on("update-not-available", () => updateState({ update: { status: "idle", message: "当前已是最新版本" } }));
  autoUpdater.on("download-progress", (progress) => updateState({ update: { status: "downloading", progress: Math.round(progress.percent) } }));
  autoUpdater.on("update-downloaded", (info) => {
    const downloadedFile = typeof (info as { downloadedFile?: string }).downloadedFile === "string"
      ? (info as { downloadedFile: string }).downloadedFile
      : null;
    if (downloadedFile) pendingDownloadedUpdateFile = downloadedFile;
    macNativeUpdateReady = false;

    if (process.platform === "darwin" && isRunningFromDmgOrReadOnlyVolume()) {
      updateState({
        update: {
          status: "error",
          version: info.version,
          message: "当前从 DMG 直接运行，无法就地更新。请将「随码」拖入「应用程序」后再检查更新。"
        }
      });
      showWindow();
      return;
    }

    updateState({
      update: {
        status: "ready",
        version: info.version,
        message: process.platform === "darwin"
          ? "更新已下载。点击「重启更新」将替换应用并自动重新打开。"
          : "更新已在后台下载完成"
      }
    });
    showWindow();
  });
  autoUpdater.on("error", (error) => {
    // Do not clear flags mid-install; that re-enables tray-hide and races with quit.
    if (installingUpdate) {
      console.error("update install error:", error);
      return;
    }
    if (quitting) quitting = false;
    updateState({ update: { status: "error", message: error.message } });
  });
  // Required so window close handlers do not cancel quitAndInstall by hide-to-tray.
  // electron-updater emits this event; typings may lag behind runtime.
  (autoUpdater as NodeJS.EventEmitter).on("before-quit-for-update", () => {
    quitting = true;
    installingUpdate = true;
    prepareForUpdateQuit();
  });

  // Track native Squirrel.Mac readiness / errors (electron-updater stages zip then feeds Squirrel).
  if (process.platform === "darwin") {
    try {
      electronNativeUpdater.on("update-downloaded", () => {
        macNativeUpdateReady = true;
        console.log("[update] native Squirrel.Mac update-downloaded");
      });
      electronNativeUpdater.on("error", (error) => {
        console.error("[update] native Squirrel.Mac error:", error);
        // Keep status ready if we already have a zip — shell fallback can still install.
        if (!installingUpdate && publicState.update.status === "ready" && pendingDownloadedUpdateFile) {
          updateState({
            update: {
              ...publicState.update,
              status: "ready",
              message: "系统自动更新组件不可用，将在重启时用安装包替换应用（无需签名）。"
            }
          });
        }
      });
    } catch (error) {
      console.error("[update] failed to bind native autoUpdater", error);
    }
  }
}

/** Tear down sockets/codex/UI before the updater replaces the app bundle. */
function prepareForUpdateQuit(): void {
  quitting = true;
  installingUpdate = true;
  reconnectBlockedReason = "updating";
  connectGeneration += 1;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pairingTimer) {
    clearTimeout(pairingTimer);
    pairingTimer = null;
  }
  for (const timer of activityFlushTimers.values()) clearTimeout(timer);
  activityFlushTimers.clear();
  activityOutputBuffers.clear();
  activityItemsByThread.clear();
  try {
    socket?.removeAllListeners();
    socket?.close();
  } catch {
    // ignore
  }
  socket = null;
  try {
    codex?.stop();
  } catch {
    // ignore
  }
  codex = null;
  try {
    if (tray) {
      tray.destroy();
      tray = null;
    }
  } catch {
    // ignore
  }
  try {
    if (windowRef && !windowRef.isDestroyed()) {
      windowRef.removeAllListeners("close");
      windowRef.destroy();
    }
  } catch {
    // ignore
  }
  windowRef = null;
}

function installDownloadedUpdate(): void {
  if (installingUpdate) return;
  if (publicState.update.status !== "ready") {
    updateState({ update: { status: "error", message: "更新包尚未下载完成，请先等待下载或点击检查更新。" } });
    return;
  }

  if (process.platform === "darwin" && isRunningFromDmgOrReadOnlyVolume()) {
    updateState({
      update: {
        status: "error",
        message: "当前从 DMG 直接运行，无法更新。请先将「随码」拖到「应用程序」文件夹，再打开并检查更新。"
      }
    });
    return;
  }

  // macOS: always arm zip-replace installer first. Squirrel.Mac often no-ops on unsigned apps;
  // the previous app.exit() fallback killed the process before any install could run.
  if (process.platform === "darwin") {
    const zipPath = pendingDownloadedUpdateFile;
    if (!zipPath) {
      updateState({
        update: {
          status: "error",
          message: "未找到已下载的更新包路径，请重新点击「检查更新」后再试。"
        }
      });
      return;
    }
    try {
      launchMacZipReplaceInstaller(zipPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateState({ update: { status: "error", message: `无法启动 macOS 安装脚本：${message}` } });
      return;
    }
    prepareForUpdateQuit();
    setTimeout(() => {
      try {
        // Best-effort native path when the app is signed / Squirrel staged successfully.
        autoUpdater.autoRunAppAfterInstall = true;
        if (macNativeUpdateReady) {
          autoUpdater.quitAndInstall(false, true);
        }
      } catch (error) {
        console.error("[update] mac quitAndInstall error", error);
      }
      // Graceful quit only — never app.exit() on mac; that aborts the detached installer mid-flight.
      setTimeout(() => {
        try { app.quit(); } catch { /* ignore */ }
        setTimeout(() => {
          // Last resort exit after installer has had time to start waiting on pgrep.
          try { app.exit(0); } catch { /* ignore */ }
        }, 4000);
      }, 800);
    }, 200);
    return;
  }

  // Windows NSIS: standard electron-updater path.
  prepareForUpdateQuit();
  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
      setTimeout(() => {
        if (!installingUpdate) return;
        try { app.quit(); } catch { /* ignore */ }
        setTimeout(() => {
          if (installingUpdate) app.exit(0);
        }, 1500);
      }, 2000);
    } catch (error) {
      installingUpdate = false;
      quitting = false;
      const message = error instanceof Error ? error.message : String(error);
      updateState({ update: { status: "error", message: `无法启动安装：${message}` } });
    }
  }, 150);
}

async function checkForAgentUpdate(): Promise<void> {
  if (!app.isPackaged) {
    updateState({ update: { status: "idle", message: "开发模式不检查更新" } });
    return;
  }
  if (!config.relayUrl) return;
  registerUpdateListeners();
  const response = await fetch(`${config.relayUrl}/api/agent/config`);
  if (!response.ok) throw new Error(`无法读取更新配置：HTTP ${response.status}`);
  const remoteConfig = await response.json() as { updateFeedUrl: string | null };
  if (!remoteConfig.updateFeedUrl) {
    updateState({ update: { status: "idle", message: "服务端未配置更新源" } });
    return;
  }
  autoUpdater.setFeedURL({ provider: "generic", url: remoteConfig.updateFeedUrl });
  // Re-assert after setFeedURL — macOS generic provider occasionally resets download flags.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Do not await downloadPromise here — it can hang for minutes and must never block UI/IPC.
  await autoUpdater.checkForUpdates();
}

function registerIpc(): void {
  ipcMain.handle("agent:get-state", () => publicState);
  ipcMain.handle("agent:set-relay-url", async (_event, relayUrl: string) => {
    const normalized = relayUrl.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(normalized)) throw new Error("中继地址必须以 http:// 或 https:// 开头");
    config.relayUrl = normalized;
    await saveConfig();
    const paired = Boolean(config.hostId && config.encryptedAgentToken && config.encryptedSyncKey);
    updateState({ relayUrl: normalized, status: paired ? "offline" : "waiting_pairing", detail: paired ? "中继地址已更新，请重新连接。" : "中继地址已保存，正在等待配对连接。" });
    void checkForAgentUpdate().catch((error) => updateState({ update: { status: "error", message: error.message } }));
    return publicState;
  });
  ipcMain.handle("agent:set-display-name", async (_event, displayName: string) => {
    const normalized = String(displayName ?? "").trim().slice(0, 64);
    if (!normalized) throw new Error("客户端名称不能为空");
    config.displayName = normalized;
    await saveConfig();
    updateState({ displayName: normalized, detail: `客户端名称已更新为“${normalized}”。` });
    // Update DB + other browsers via unencrypted meta (avoids host.status rename loops).
    publishAgentMeta({ name: normalized });
    if (socket?.readyState === WebSocket.OPEN) await publishHostStatus();
    return publicState;
  });
  ipcMain.handle("agent:start-pairing", () => startPairing());
  ipcMain.handle("agent:add-workspace", () => addWorkspace());
  ipcMain.handle("agent:remove-workspace", async (_event, id: string) => {
    config.workspaces = config.workspaces.filter((workspace) => workspace.id !== id);
    await saveConfig();
    updateState({ workspaces: config.workspaces });
    await publishHostStatus();
    return publicState;
  });
  // Do not await connect — hung TCP must never freeze the agent UI/IPC.
  ipcMain.handle("agent:reconnect", async () => {
    logInfo("用户触发重新连接");
    updateState({ status: "connecting", detail: "正在重新连接加密中继…" });
    void connect(true).catch(handleError);
    return publicState;
  });
  ipcMain.handle("agent:get-logs", async () => agentLogs.slice());
  ipcMain.handle("agent:clear-logs", async () => {
    agentLogs.length = 0;
    logInfo("用户清空了内存日志（磁盘 agent.log 仍保留历史）");
    return agentLogs.slice();
  });
  ipcMain.handle("agent:open-log-file", async () => {
    if (!agentLogFilePath) throw new Error("日志文件尚未初始化");
    try {
      await fs.mkdir(path.dirname(agentLogFilePath), { recursive: true });
      await fs.appendFile(agentLogFilePath, "", "utf8");
    } catch {
      // ignore create failures — still try open
    }
    const result = await shell.openPath(agentLogFilePath);
    if (result) {
      // openPath returns empty string on success; non-empty is error message
      await shell.showItemInFolder(agentLogFilePath);
    }
    logInfo("已打开日志文件", agentLogFilePath);
    return { path: agentLogFilePath };
  });
  ipcMain.handle("agent:check-environment", async () => {
    try {
      await applyLoginPathToProcess();
    } catch {
      // ignore
    }
    clearEngineBinaryCache();
    const environment = await detectEnvironment();
    const availableEngines = await detectAvailableEngines({
      codexReady: environment.codexCompatible,
      codexVersion: environment.codexVersion || "unknown"
    });
    const ready = anyCodingEngineReady(environment, availableEngines);
    const paired = Boolean(config.hostId && config.encryptedAgentToken && config.encryptedSyncKey);
    const readyLabels = availableEngines
      .filter((item) => item.ready)
      .map((item) => `${item.engine}${item.version ? ` ${item.version}` : ""}`)
      .join(" · ");
    updateState({
      environment,
      availableEngines,
      codexVersion: environment.codexVersion || publicState.codexVersion,
      status: statusForEngineAvailability({ environment, engines: availableEngines, paired }),
      detail: !ready
        ? "未检测到可用编码引擎。请安装 Codex / Claude Code / Grok Build 任意一种后重试。"
        : `环境检测完成：${readyLabels || "就绪"}${paired ? "。主机引擎能力已同步到网页。" : "。"}${
          !environment.codexCompatible ? "（未安装 Codex 也可连接中继）" : ""
        }`
    });
    // If paired but socket down, try reconnect after engines are known (Claude/Grok-only hosts).
    if (paired && socket?.readyState !== WebSocket.OPEN && ready) {
      void connect(true).catch(handleError);
    }
    // Push engine icons/versions to the web host card when online.
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        await publishHostStatus();
      } catch {
        // ignore publish failures during local recheck
      }
    }
    return publicState;
  });
  ipcMain.handle("agent:install-environment", async (_event, target: "node" | "codex" | "claude" | "grok" | "cursor") => {
    if (target !== "node" && target !== "codex" && target !== "claude" && target !== "grok" && target !== "cursor") {
      throw new Error("未知的安装目标");
    }
    try {
      await installEnvironment(target);
      // Re-detect after install window is launched (user may finish later; still refresh now for partial hits).
      try {
        await applyLoginPathToProcess();
        const environment = await detectEnvironment();
        const availableEngines = await detectAvailableEngines({
          codexReady: environment.codexCompatible,
          codexVersion: environment.codexVersion || "unknown"
        });
        updateState({ environment, availableEngines, codexVersion: environment.codexVersion || publicState.codexVersion });
      } catch {
        // optional
      }
    } catch (error) {
      handleError(error);
      throw error;
    }
    return publicState;
  });
  ipcMain.handle("agent:check-update", async () => { await checkForAgentUpdate(); return publicState; });
  ipcMain.handle("agent:install-update", () => {
    try {
      installDownloadedUpdate();
    } catch (error) {
      installingUpdate = false;
      quitting = false;
      const message = error instanceof Error ? error.message : String(error);
      updateState({ update: { status: "error", message: `安装更新失败：${message}` } });
    }
    return publicState;
  });
  ipcMain.handle("agent:relay-task", async (_event, threadId: string) => {
    try {
      await relayTaskToCli(threadId);
      updateState({ detail: `已打开任务接力终端：${threadId.slice(0, 8)}…` });
    } catch (error) {
      handleError(error);
      throw error;
    }
    // After handoff, re-import CLI sessions a bit later so local work can appear on web sync.
    setTimeout(() => {
      void importLocalCliSessions(taskStore, DEFAULT_SYNC_LIMIT)
        .then(async () => {
          await publishRecentMultiCliSnapshots(DEFAULT_SYNC_LIMIT);
        })
        .catch(() => undefined);
    }, 15_000);
    return publicState;
  });
  ipcMain.handle("agent:refresh-tasks", async () => {
    await refreshLocalTasks();
    // Also push multi-CLI tasks to the web when the agent window refreshes.
    try {
      await publishRecentMultiCliSnapshots(DEFAULT_SYNC_LIMIT);
    } catch {
      // ignore
    }
    return publicState;
  });
  ipcMain.handle("agent:select-activity", async (_event, threadId: string) => {
    const id = String(threadId || "");
    if (!id || !publicState.activities.some((item) => item.threadId === id)) return publicState;
    syncActivitiesState(publicState.activities, id);
    return publicState;
  });
  ipcMain.handle("agent:refresh-engines", async () => {
    await refreshAvailableEngines();
    return publicState;
  });
  ipcMain.handle("agent:window-minimize", () => {
    windowRef?.minimize();
  });
  ipcMain.handle("agent:window-close", () => {
    // Match tray behavior: hide instead of quitting unless already exiting.
    if (quitting || installingUpdate) {
      windowRef?.close();
      return;
    }
    windowRef?.hide();
  });
  ipcMain.handle("agent:open-feedback", async () => {
    await shell.openExternal("https://github.com/demonrain/anytimevibe/issues");
  });
}

// Windows taskbar title/icon rely on AppUserModelID + embedded exe resources.
if (process.platform === "win32") {
  app.setAppUserModelId("com.anytimevibe.agent");
}

app.whenReady().then(async () => {
  await loadConfig();
  await taskStore.load(app.getPath("userData"));
  await loadTurnQueue(app.getPath("userData"));
  await initAgentLogFile(app.getPath("userData"));
  updateState({ cliEngine: taskStore.getDefaultEngine() });
  registerIpc();
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }]));
  } else {
    Menu.setApplicationMenu(null);
  }
  app.setLoginItemSettings({ openAtLogin: true });
  const traySource = loadProductIcon();
  const trayIcon = traySource.resize({ width: 16, height: 16 });
  if (process.platform === "darwin") trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip("随码");
  tray.on("double-click", showWindow);
  tray.on("click", () => {
    if (process.platform === "win32") showWindow();
  });
  createWindow();
  // Defer update check so first paint / IPC is never delayed by network download.
  setTimeout(() => {
    void checkForAgentUpdate().catch((error) => updateState({ update: { status: "error", message: error.message } }));
  }, 1500);
  setInterval(() => void checkForAgentUpdate().catch(() => undefined), 6 * 60 * 60 * 1000).unref();

  const paired = Boolean(config.hostId && config.encryptedAgentToken && config.encryptedSyncKey);
  updateState({
    status: !config.relayUrl
      ? "unconfigured"
      : config.pairing
        ? "pairing"
        : paired
          ? "offline"
          : "waiting_pairing",
    detail: !config.relayUrl
      ? "请先配置中继地址。"
      : config.pairing
        ? "等待 Web 端确认配对。"
        : paired
          ? "正在连接中继…"
          : "等待配对连接。"
  });
  if (config.pairing) schedulePairingPoll();
  // Connect immediately when paired — never wait on Codex/env probes (those can hang PATH shells).
  // Any of Codex / Claude / Grok is enough; missing Codex must not prevent relay.
  if (config.hostId) void connect().catch(handleError);
  // Background env detect (Codex optional; failures must not block relay).
  void (async () => {
    try {
      await applyLoginPathToProcessBounded();
      const environment = await detectEnvironment();
      const availableEngines = await detectAvailableEngines({
        codexReady: environment.codexCompatible,
        codexVersion: environment.codexVersion || "unknown"
      }).catch(() => publicState.availableEngines);
      const ready = anyCodingEngineReady(environment, availableEngines);
      const readyLabels = availableEngines
        .filter((item) => item.ready)
        .map((item) => `${item.engine}${item.version ? ` ${item.version}` : ""}`)
        .join(" · ");
      updateState({
        environment,
        availableEngines,
        codexVersion: environment.codexVersion || codexVersion,
        // Do not overwrite online/connecting with incompatible when engines not yet found on PATH.
        ...(publicState.status === "online" || publicState.status === "connecting"
          ? {}
          : { status: statusForEngineAvailability({ environment, engines: availableEngines }) }),
        detail: publicState.status === "online"
          ? publicState.detail
          : ready
            ? (environment.codexCompatible
              ? `环境已就绪（${readyLabels || "Codex"}），正在连接中继。`
              : `环境已就绪（${readyLabels}），正在连接中继（无需 Codex）。`)
            : "正在连接中继…安装任意编码引擎后即可下发任务。"
      });
      if (environment.codexCompatible) {
        void ensureCodex().then(() => refreshLocalTasks()).catch(() => undefined);
      }
    } catch (error) {
      // Env probe failures must never force offline/incompatible over a live socket.
      logWarn("启动环境检测失败", error instanceof Error ? error.message : String(error));
    }
  })();
});

app.on("window-all-closed", () => undefined);
app.on("before-quit", () => {
  quitting = true;
  if (installingUpdate) {
    // prepareForUpdateQuit already cleaned resources; avoid double-kill races.
    return;
  }
  reconnectTimer && clearTimeout(reconnectTimer);
  pairingTimer && clearTimeout(pairingTimer);
  try {
    socket?.removeAllListeners();
    socket?.close();
  } catch {
    // ignore
  }
  socket = null;
  try {
    codex?.stop();
  } catch {
    // ignore
  }
  codex = null;
});
