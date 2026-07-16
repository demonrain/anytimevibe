import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import {
  agentEventSchema,
  base64ToBytes,
  clientCommandSchema,
  createEnvelope,
  decryptPayload,
  derivePairingKey,
  generatePairingKeyPair,
  importAesKey,
  openEnvelope,
  pairingClaimResponseSchema,
  type AgentEvent,
  type CliEngine,
  type CliEngineInfo,
  type ClientCommand,
  type ContextUsage,
  type EncryptedEnvelope,
  type PairingPublicInfo,
  type PermissionMode,
  type ReasoningEffort,
  type Workspace,
  PRODUCT_VERSION,
  MIN_AGENT_VERSION,
  compareSemver
} from "@anytimevibe/protocol";
import { api, websocketUrl } from "./api";
import { useI18n } from "./i18n/I18nProvider";
import {
  normalizePermissionMode,
  normalizeReplyDetail,
  REPLY_DETAIL_STORAGE_KEY,
  type ReplyDetail
} from "./i18n/locales";
import { getHostKey, removeHostKey, saveHostKey } from "./key-store";

type Health = { ok: boolean; needsSetup: boolean; registrationEnabled: boolean; vapidPublicKey: string | null; clientDownloads: { windows: string | null; mac: string | null } };
type User = { id: string; username: string; isAdmin?: boolean };
type Host = {
  id: string;
  name: string;
  platform: string;
  codexVersion: string;
  lastSeenAt: string | null;
  online: boolean;
};
type Approval = Extract<AgentEvent, { type: "approval.requested" }>;
type Task = {
  threadId: string;
  title: string;
  cwd: string;
  status: string;
  updatedAt: number;
  activeTurnId?: string;
  diff: string;
  messages: Array<{ id: string; role: "user" | "assistant" | "system"; text: string }>;
  approvals: Approval[];
  cliEngine?: CliEngine;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  contextUsage?: ContextUsage;
};

/** Per-engine model presets (value "" = use CLI / host default). */
function modelOptionsForEngine(engine: CliEngine): Array<{ value: string; label: string }> {
  if (engine === "claude") {
    return [
      { value: "", label: "默认模型" },
      { value: "opus", label: "Opus" },
      { value: "sonnet", label: "Sonnet" },
      { value: "haiku", label: "Haiku" },
      { value: "claude-opus-4-8", label: "claude-opus-4-8" },
      { value: "claude-sonnet-4-5", label: "claude-sonnet-4-5" }
    ];
  }
  if (engine === "grok") {
    return [
      { value: "", label: "默认模型" },
      { value: "grok-4.5", label: "Grok 4.5" },
      { value: "grok-4", label: "Grok 4" }
    ];
  }
  return [
    { value: "", label: "默认模型" },
    { value: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    { value: "o3", label: "o3" },
    { value: "o4-mini", label: "o4-mini" },
    { value: "gpt-5", label: "gpt-5" }
  ];
}

/** Effort labels differ by vendor; values are normalized for the protocol. */
function effortOptionsForEngine(engine: CliEngine): Array<{ value: ReasoningEffort | ""; label: string }> {
  if (engine === "claude") {
    return [
      { value: "", label: "默认推理强度" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
      { value: "xhigh", label: "xhigh" },
      { value: "max", label: "max" }
    ];
  }
  if (engine === "grok") {
    return [
      { value: "", label: "默认 reasoning effort" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" }
    ];
  }
  // Codex model_reasoning_effort
  return [
    { value: "", label: "默认 reasoning effort" },
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "xhigh", label: "xhigh" }
  ];
}

function formatContextUsage(usage?: ContextUsage): string | null {
  if (!usage) return null;
  const total = usage.totalTokens ?? ((usage.inputTokens || 0) + (usage.outputTokens || 0));
  const window = usage.contextWindow;
  if (window && (usage.remainingTokens != null || total)) {
    const remaining = usage.remainingTokens ?? Math.max(0, window - total);
    const pct = Math.max(0, Math.min(100, Math.round((remaining / window) * 100)));
    return `上下文剩余 ${remaining.toLocaleString()} / ${window.toLocaleString()}（${pct}%）`;
  }
  if (total) return `已用约 ${total.toLocaleString()} tokens`;
  return null;
}
type HostRuntime = {
  online: boolean | null;
  workspaces: Workspace[];
  tasks: Record<string, Task>;
  availableEngines?: CliEngineInfo[];
  /** Desktop agent version reported by host.status.agentVersion */
  agentVersion?: string;
};

function taskStatusMeta(status: string): { label: string; tone: string } {
  let statusType = status;
  try {
    const parsed = JSON.parse(status) as { type?: unknown };
    if (typeof parsed.type === "string") statusType = parsed.type;
  } catch {
    // Plain string statuses are expected for turn events.
  }
  const normalized = statusType.toLowerCase().replace(/[\s_-]/g, "");
  if (["active", "running", "inprogress", "processing"].includes(normalized)) return { label: "进行中", tone: "active" };
  if (["completed", "complete", "success", "succeeded"].includes(normalized)) return { label: "已完成", tone: "completed" };
  if (["failed", "error"].includes(normalized)) return { label: "失败", tone: "failed" };
  if (["interrupted", "cancelled", "canceled", "stopped"].includes(normalized)) return { label: "已停止", tone: "stopped" };
  if (normalized === "idle") return { label: "空闲", tone: "idle" };
  if (normalized === "notloaded") return { label: "未加载", tone: "not-loaded" };
  if (["pending", "queued", "notstarted"].includes(normalized)) return { label: "待处理", tone: "pending" };
  return { label: statusType || "未知状态", tone: "unknown" };
}

function emptyRuntime(online: boolean | null = null): HostRuntime {
  return { online, workspaces: [], tasks: {}, availableEngines: [] };
}

function normalizeCliEngine(value: string | null | undefined): CliEngine {
  if (value === "claude" || value === "grok" || value === "codex") return value;
  return "codex";
}

function cliEngineLabel(engine: CliEngine): string {
  if (engine === "claude") return "Claude Code";
  if (engine === "grok") return "Grok Build";
  return "Codex";
}

/** Short badge label for assistant bubbles (matches YOU / SYSTEM style). */
function assistantEngineBadge(engine: CliEngine): string {
  if (engine === "claude") return "CLAUDE";
  if (engine === "grok") return "GROK";
  return "CODEX";
}

function EngineLogo({ engine, size = 14, className = "" }: { engine: CliEngine; size?: number; className?: string }) {
  return (
    <img
      className={`engine-logo ${className}`.trim()}
      src={`/vendors/${engine}.png`}
      alt={cliEngineLabel(engine)}
      title={cliEngineLabel(engine)}
      width={size}
      height={size}
      draggable={false}
    />
  );
}

function readyEngines(engines: CliEngineInfo[] | undefined): CliEngineInfo[] {
  return (engines ?? []).filter((item) => item.ready);
}

type PermissionOption = { value: PermissionMode; label: string };

function permissionOptionsForEngine(engine: CliEngine, locale: "zh-CN" | "en"): PermissionOption[] {
  if (engine === "claude") {
    return locale === "en"
      ? [
          { value: "read-only", label: "Read-only tools" },
          { value: "ask-for-approval", label: "Accept edits" },
          { value: "full-access", label: "Bypass permissions" }
        ]
      : [
          { value: "read-only", label: "只读工具" },
          { value: "ask-for-approval", label: "接受文件编辑" },
          { value: "full-access", label: "跳过权限确认" }
        ];
  }
  if (engine === "grok") {
    return locale === "en"
      ? [
          { value: "read-only", label: "Read-only tools" },
          { value: "ask-for-approval", label: "Accept edits" },
          { value: "full-access", label: "Always approve (YOLO)" }
        ]
      : [
          { value: "read-only", label: "只读工具" },
          { value: "ask-for-approval", label: "接受文件编辑" },
          { value: "full-access", label: "全自动批准" }
        ];
  }
  // codex
  return locale === "en"
    ? [
        { value: "read-only", label: "Read Only" },
        { value: "ask-for-approval", label: "Ask for approval" },
        { value: "approve-for-me", label: "Approve for me" },
        { value: "full-access", label: "Full Access" }
      ]
    : [
        { value: "read-only", label: "Read Only" },
        { value: "ask-for-approval", label: "Ask for approval" },
        { value: "approve-for-me", label: "Approve for me" },
        { value: "full-access", label: "Full Access" }
      ];
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "") || /Mac OS/i.test(navigator.userAgent || "");
}

function workspacesCacheKey(hostId: string): string {
  return `workspaces:${hostId}`;
}

function loadCachedWorkspaces(hostId: string): Workspace[] {
  try {
    const raw = localStorage.getItem(workspacesCacheKey(hostId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Workspace => (
      Boolean(item)
      && typeof item === "object"
      && typeof (item as Workspace).id === "string"
      && typeof (item as Workspace).name === "string"
      && typeof (item as Workspace).path === "string"
      && (item as Workspace).path.length > 0
    ));
  } catch {
    return [];
  }
}

function cacheWorkspaces(hostId: string, workspaces: Workspace[]): void {
  try {
    localStorage.setItem(workspacesCacheKey(hostId), JSON.stringify(workspaces));
  } catch {
    // ignore quota / private mode
  }
}

/** Message ids from turn.delta are `assistant:${turnId}:${itemId}`. */
function assistantStreamItemId(messageId: string): string | null {
  if (!messageId.startsWith("assistant:")) return null;
  const rest = messageId.slice("assistant:".length);
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  return rest.slice(sep + 1);
}

/**
 * Verbose process streams — hidden in concise reply mode from the first paint
 * (not only after the final snapshot). Final model text uses itemId "assistant"
 * (Claude/Grok) or a plain Codex item id (not stage:/exec:/cli-log).
 */
function isProcessStreamMessage(message: { id: string; role: string }): boolean {
  if (message.role !== "assistant") return false;
  const itemId = assistantStreamItemId(message.id);
  if (!itemId) return false;
  return itemId === "cli-log"
    || itemId === "thought"
    || itemId.startsWith("thought:")
    || itemId.startsWith("exec:")
    || itemId.startsWith("process:")
    || itemId.startsWith("stage:");
}

/** Strip control characters that can break layout engines while keeping newlines/tabs. */
function sanitizeDisplayText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, "");
}

function reduceEvent(runtime: HostRuntime, event: AgentEvent): HostRuntime {
  const next = structuredClone(runtime);
  if (event.type === "host.status") {
    next.online = event.online;
    next.workspaces = event.workspaces;
    if (event.availableEngines) next.availableEngines = event.availableEngines;
    if (event.agentVersion) next.agentVersion = event.agentVersion;
    return next;
  }
  if (event.type === "sync.completed" || event.type === "sync.progress") return next;
  if (event.type === "thread.snapshot") {
    const existing = next.tasks[event.threadId];
    const engine = event.cliEngine ?? existing?.cliEngine;
    const model = event.model ?? existing?.model;
    const reasoningEffort = event.reasoningEffort ?? existing?.reasoningEffort;
    const contextUsage = event.contextUsage ?? existing?.contextUsage;
    next.tasks[event.threadId] = {
      threadId: event.threadId,
      title: event.title || "未命名任务",
      cwd: event.cwd,
      status: event.status,
      updatedAt: event.updatedAt,
      diff: existing?.diff ?? "",
      messages: event.messages,
      approvals: existing?.approvals ?? [],
      ...(engine ? { cliEngine: engine } : {}),
      ...(event.activeTurnId ? { activeTurnId: event.activeTurnId } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(contextUsage ? { contextUsage } : {})
    };
    return next;
  }
  if (event.type === "error") {
    if (event.threadId && next.tasks[event.threadId]) {
      next.tasks[event.threadId]!.status = "failed";
      delete next.tasks[event.threadId]!.activeTurnId;
      if (event.message) {
        next.tasks[event.threadId]!.messages.push({
          id: event.eventId,
          role: "system",
          text: event.message
        });
      }
    }
    return next;
  }
  if (event.type === "request.resolved") {
    if (event.threadId) {
      const task = next.tasks[event.threadId];
      if (task) task.approvals = task.approvals.filter((approval: Approval) => approval.requestId !== event.requestId);
    } else {
      for (const task of Object.values(next.tasks)) {
        task.approvals = task.approvals.filter((approval: Approval) => approval.requestId !== event.requestId);
      }
    }
    return next;
  }
  const task = next.tasks[event.threadId] ?? {
    threadId: event.threadId,
    title: "进行中的任务",
    cwd: "",
    status: "active",
    updatedAt: Date.now() / 1000,
    diff: "",
    messages: [],
    approvals: []
  };
  next.tasks[event.threadId] = task;
  task.updatedAt = Date.now() / 1000;
  if (event.type === "turn.started") {
    task.status = "active";
    task.activeTurnId = event.turnId;
    // Snapshot may already include the user turn (headless path). Avoid duplicate YOU bubbles.
    if (event.prompt) {
      const prompt = event.prompt.trim();
      const already = task.messages.some(
        (item: Task["messages"][number]) => item.role === "user" && item.text.trim() === prompt
      );
      if (!already) {
        task.messages.push({ id: event.eventId, role: "user", text: event.prompt });
      }
    }
  }
  if (event.type === "turn.delta") {
    const id = `assistant:${event.turnId}:${event.itemId}`;
    const message = task.messages.find((item: Task["messages"][number]) => item.id === id);
    if (message) message.text += event.delta;
    else task.messages.push({ id, role: "assistant", text: event.delta });
  }
  if (event.type === "turn.completed") {
    task.status = event.status;
    delete task.activeTurnId;
    if (event.contextUsage) task.contextUsage = event.contextUsage;
  }
  if (event.type === "diff.updated") task.diff = event.diff;
  if (event.type === "approval.requested") task.approvals.push(event);
  return next;
}

function ErrorBanner({ message, clear }: { message: string; clear(): void }) {
  return <button className="error-banner" onClick={clear}>{message}<span>关闭</span></button>;
}

function ClientDownloads({ downloads }: { downloads: Health["clientDownloads"] }) {
  if (!downloads.windows && !downloads.mac) {
    return <div className="client-downloads"><span>桌面客户端</span><button type="button" className="client-download-soon" onClick={() => window.alert("macOS 客户端正在准备中，敬请期待。")}>macOS · 敬请期待</button></div>;
  }
  return <div className="client-downloads">
    <span>桌面客户端</span>
    {downloads.windows && <a href={downloads.windows}>Windows</a>}
    {downloads.mac
      ? <a href={downloads.mac}>macOS</a>
      : <button type="button" className="client-download-soon" title="敬请期待" onClick={() => window.alert("macOS 客户端正在准备中，敬请期待。当前可先使用 Windows 版随码。")}>macOS · 敬请期待</button>}
  </div>;
}

const featuredEngines: Array<{ engine: CliEngine; vendor: string; product: string }> = [
  { engine: "codex", vendor: "OpenAI", product: "Codex" },
  { engine: "claude", vendor: "Anthropic", product: "Claude Code" },
  { engine: "grok", vendor: "xAI", product: "Grok Build" }
];

function FeaturedEngines() {
  return <section className="featured-engines" aria-label="支持的 AI 编程引擎">
    <div className="featured-engines-head">
      <span>三大主流模型厂商</span>
      <strong>三款均已支持 · 一台主机自由选择</strong>
    </div>
    <div className="featured-engine-grid" role="list">
      {featuredEngines.map((item) => <article className={`featured-engine featured-engine-${item.engine}`} role="listitem" key={item.engine}>
        <span className="featured-engine-logo"><EngineLogo engine={item.engine} size={38} /></span>
        <span className="featured-engine-copy">
          <strong>{item.vendor}</strong>
          <small>{item.product}</small>
        </span>
      </article>)}
    </div>
  </section>;
}

function AuthScreen({ health, onAuthenticated }: { health: Health; onAuthenticated(user: User): void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const endpoint = health.needsSetup ? "/api/setup" : registering ? "/api/auth/register" : "/api/auth/login";
      const response = await api<{ user: User }>(endpoint, {
        method: "POST",
        body: JSON.stringify(health.needsSetup ? { username, password, setupToken } : { username, password })
      });
      onAuthenticated(response.user);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return <main className="auth-shell">
    <section className="auth-story">
      <p className="eyebrow">随码 · 随时续码</p>
      <h1><span>离开电脑，</span><span>任务不用停。</span></h1>
      <p>连接自己的 Windows 或 macOS 主机，远程使用 OpenAI Codex、Anthropic Claude Code 与 xAI Grok Build。云端只负责转发密文，源码与密钥留在本机。</p>
      <FeaturedEngines />
      <div className="signal-line"><span />端到端加密 · 本机执行</div>
      <ClientDownloads downloads={health.clientDownloads} />
    </section>
    <form className="auth-card" onSubmit={submit}>
      <div className="mark" aria-hidden="true"><img src="/icon.svg" alt="" /></div>
      <h2>{health.needsSetup ? "初始化服务" : registering ? "创建个人空间" : "进入随码"}</h2>
      <p>{health.needsSetup ? "创建首个管理员账号，开启你的随码服务。" : registering ? "注册后即可配对自己的电脑，数据与其他用户隔离。" : "登录后随时接住本机 AI 编程任务。"}</p>
      {health.needsSetup && <label>设置令牌<input value={setupToken} onChange={(event) => setSetupToken(event.target.value)} required /></label>}
      <label>用户名<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
      <label>密码<input type="password" autoComplete={health.needsSetup || registering ? "new-password" : "current-password"} minLength={health.needsSetup || registering ? 6 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} required placeholder={health.needsSetup || registering ? "至少 6 位" : undefined} /></label>
      {error && <p className="form-error">{error}</p>}
      <button className="primary" disabled={loading}>{loading ? "处理中…" : health.needsSetup ? "创建管理员" : registering ? "注册并登录" : "登录"}</button>
      {!health.needsSetup && health.registrationEnabled && <button type="button" className="auth-switch" onClick={() => { setRegistering((value) => !value); setError(""); }}>{registering ? "已有账号？返回登录" : "没有账号？立即注册"}</button>}
    </form>
  </main>;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [runtime, setRuntime] = useState<Record<string, HostRuntime>>({});
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"hosts" | "tasks" | "conversation">("hosts");
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const hostOfflineTimersRef = useRef(new Map<string, number>());
  const [error, setError] = useState("");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<Record<string, string>>({});
  const { locale, setLocale, t } = useI18n();
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => normalizePermissionMode(localStorage.getItem("permission-mode")));
  const [replyDetail, setReplyDetail] = useState<ReplyDetail>(() => normalizeReplyDetail(localStorage.getItem(REPLY_DETAIL_STORAGE_KEY)));
  const [taskQuery, setTaskQuery] = useState("");
  /** Quick filter task list by coding engine; null = all engines. */
  const [engineFilter, setEngineFilter] = useState<CliEngine | null>(null);
  const taskSearchTimerRef = useRef<number | null>(null);
  const autoSyncedHostsRef = useRef(new Set<string>());
  const [keyAuthorizationStatus, setKeyAuthorizationStatus] = useState<Record<string, "missing" | "authorizing">>({});
  const keyAuthorizationsRef = useRef(new Set<string>());
  function selectTask(threadId: string) {
    setSelectedTaskId(threadId);
    setMobilePane("conversation");
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  useEffect(() => {
    api<Health>("/api/health").then(async (value) => {
      setHealth(value);
      if (!value.needsSetup) {
        const session = await api<{ user: User }>("/api/auth/session").catch(() => null);
        if (session) setUser(session.user);
      }
    }).catch((loadError) => setError(loadError.message));
  }, []);

  const handleEnvelope = useEffectEvent(async (envelope: EncryptedEnvelope) => {
    const key = await getHostKey(envelope.hostId);
    if (!key) return;
    const event = agentEventSchema.parse(await openEnvelope<AgentEvent>(key, envelope));
    if (event.type === "sync.progress") {
      setSyncStatus((current) => ({
        ...current,
        [envelope.hostId]: `${t("syncing")} ${event.current}/${event.total}`
      }));
      return;
    }
    if (event.type === "sync.completed") {
      const label = event.partial
        ? (locale === "en" ? `Synced recent ${event.threadCount}` : `已同步最近 ${event.threadCount} 个`)
        : (locale === "en" ? `Synced ${event.threadCount}` : `已同步 ${event.threadCount} 个任务`);
      setSyncStatus((current) => ({ ...current, [envelope.hostId]: label }));
      window.setTimeout(() => {
        setSyncStatus((current) => {
          const value = current[envelope.hostId];
          if (!value || value.startsWith(t("syncing"))) return current;
          const next = { ...current };
          delete next[envelope.hostId];
          return next;
        });
      }, 3000);
    } else {
      // host.status is encrypted live state — update local UI only.
      // Never PATCH name from here: agent may still hold a stale name and would overwrite web renames.
      if (event.type === "host.status") {
        cacheWorkspaces(envelope.hostId, event.workspaces);
        setHosts((current) => current.map((item) => {
          if (item.id !== envelope.hostId) return item;
          return {
            ...item,
            ...(event.name ? { name: event.name } : {}),
            ...(event.codexVersion ? { codexVersion: event.codexVersion } : {}),
            ...(event.platform ? { platform: event.platform } : {})
          };
        }));
      }
      setRuntime((current) => ({
        ...current,
        [envelope.hostId]: reduceEvent(current[envelope.hostId] ?? emptyRuntime(), event)
      }));
    }
    if (envelope.persist) localStorage.setItem(`sync:${envelope.hostId}`, String(envelope.sequence));
  });

  const updateHostStatus = useEffectEvent((hostId: string, online: boolean) => {
    const pendingTimer = hostOfflineTimersRef.current.get(hostId);
    if (pendingTimer) window.clearTimeout(pendingTimer);
    hostOfflineTimersRef.current.delete(hostId);
    if (online) {
      setRuntime((current) => ({
        ...current,
        [hostId]: { ...(current[hostId] ?? emptyRuntime()), online: true }
      }));
      return;
    }
    const timer = window.setTimeout(() => {
      hostOfflineTimersRef.current.delete(hostId);
      setRuntime((current) => ({
        ...current,
        [hostId]: { ...(current[hostId] ?? emptyRuntime()), online: false }
      }));
    }, 1500);
    hostOfflineTimersRef.current.set(hostId, timer);
  });

  async function authorizeExistingHost(hostId: string): Promise<void> {
    if (keyAuthorizationsRef.current.has(hostId)) return;
    keyAuthorizationsRef.current.add(hostId);
    setKeyAuthorizationStatus((current) => ({ ...current, [hostId]: "authorizing" }));
    try {
      const keyPair = await generatePairingKeyPair();
      const clientPublicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      const authorization = await api<{ pairingId: string; agentPublicKey: JsonWebKey }>(`/api/hosts/${hostId}/key-authorizations`, {
        method: "POST",
        body: JSON.stringify({ clientPublicKey })
      });
      const pairingKey = await derivePairingKey(keyPair.privateKey, authorization.agentPublicKey, authorization.pairingId);
      let wrappedSyncKey: { nonce: string; ciphertext: string } | null = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = await api<{ status: string; wrappedSyncKey?: { nonce: string; ciphertext: string } }>(`/api/pairings/${authorization.pairingId}/status`);
        if (status.status === "authorized" && status.wrappedSyncKey) {
          wrappedSyncKey = status.wrappedSyncKey;
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      if (!wrappedSyncKey) throw new Error("客户端密钥授权超时，请确认电脑端保持在线。");
      const unwrapped = await decryptPayload<{ syncKey: string }>(pairingKey, wrappedSyncKey, authorization.pairingId);
      await saveHostKey(hostId, await importAesKey(base64ToBytes(unwrapped.syncKey)));
      setKeyAuthorizationStatus((current) => {
        const next = { ...current };
        delete next[hostId];
        return next;
      });
      localStorage.removeItem(`sync:${hostId}`);
      await loadHosts();
    } catch (authorizationError) {
      setKeyAuthorizationStatus((current) => ({ ...current, [hostId]: "missing" }));
      throw authorizationError;
    } finally {
      keyAuthorizationsRef.current.delete(hostId);
    }
  }

  const loadHosts = useEffectEvent(async () => {
    const response = await api<{ hosts: Host[] }>("/api/hosts");
    setHosts(response.hosts);
    setRuntime((current) => {
      const next = { ...current };
      for (const host of response.hosts) {
        const existing = next[host.id];
        const cachedWorkspaces = loadCachedWorkspaces(host.id);
        next[host.id] = {
          ...(existing ?? emptyRuntime(host.online ? true : null)),
          online: host.online ? true : existing?.online ?? null,
          // Prefer live state; fall back to last known allowlist so New Task works offline of host.status replay.
          workspaces: existing?.workspaces?.length ? existing.workspaces : cachedWorkspaces
        };
      }
      return next;
    });
    setSelectedHostId((current) => current ?? response.hosts[0]?.id ?? null);
    for (const host of response.hosts) {
      const key = await getHostKey(host.id);
      if (!key) {
        setKeyAuthorizationStatus((current) => ({ ...current, [host.id]: current[host.id] ?? "missing" }));
        if (host.online) void authorizeExistingHost(host.id).catch((authorizationError) => setError(authorizationError.message));
        continue;
      }
      setKeyAuthorizationStatus((current) => {
        if (!current[host.id]) return current;
        const next = { ...current };
        delete next[host.id];
        return next;
      });
      const after = Number(localStorage.getItem(`sync:${host.id}`) ?? 0);
      const sync = await api<{ events: EncryptedEnvelope[]; nextSequence: number }>(`/api/sync/${host.id}?after=${after}`);
      for (const envelope of sync.events) await handleEnvelope(envelope);
    }
  });

  useEffect(() => {
    if (!user) return;
    loadHosts().catch((loadError) => setError(loadError.message));
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      const connection = new WebSocket(websocketUrl("/ws/client"));
      socketRef.current = connection;
      connection.onmessage = (message) => {
        try {
          const parsed = JSON.parse(String(message.data));
          if (parsed.type === "relay.host_status") {
            const hostId = String(parsed.hostId);
            const online = Boolean(parsed.online);
            updateHostStatus(hostId, online);
            if (online) void getHostKey(hostId).then((key) => {
              if (!key) return authorizeExistingHost(hostId);
            }).catch((authorizationError) => setError(authorizationError.message));
            if (online) {
              // Always re-pull allowlisted workspaces when the host comes online.
              void getHostKey(hostId).then((key) => {
                if (!key) return;
                return sendCommand(hostId, { type: "host.refresh", commandId: crypto.randomUUID() });
              }).catch(() => undefined);
            }
            if (online && !autoSyncedHostsRef.current.has(hostId)) {
              autoSyncedHostsRef.current.add(hostId);
              syncHostTasks(hostId).catch((syncError) => {
                autoSyncedHostsRef.current.delete(hostId);
                setError(syncError.message);
              });
            }
            return;
          }
          if (parsed.type === "relay.host_meta") {
            const hostId = String(parsed.hostId);
            setHosts((current) => current.map((host) => host.id !== hostId ? host : {
              ...host,
              ...(typeof parsed.name === "string" && parsed.name.trim() ? { name: parsed.name.trim() } : {}),
              ...(typeof parsed.codexVersion === "string" && parsed.codexVersion.trim() ? { codexVersion: parsed.codexVersion.trim() } : {}),
              ...(typeof parsed.platform === "string" && parsed.platform.trim() ? { platform: parsed.platform.trim() } : {})
            }));
            return;
          }
          if (parsed.type === "relay.error") {
            setError(parsed.error === "host_offline" ? "远程主机当前离线。" : "中继拒绝了这条消息。");
            return;
          }
          handleEnvelope(parsed as EncryptedEnvelope).catch((openError) => setError(`无法解密远程事件：${openError.message}`));
        } catch {
          setError("收到无法识别的中继消息。");
        }
      };
      connection.onclose = () => {
        if (socketRef.current !== connection || stopped) return;
        socketRef.current = null;
        autoSyncedHostsRef.current.clear();
        reconnectTimerRef.current = window.setTimeout(connect, 1800);
      };
      connection.onerror = () => connection.close();
    };
    connect();
    return () => {
      stopped = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      for (const timer of hostOfflineTimersRef.current.values()) window.clearTimeout(timer);
      hostOfflineTimersRef.current.clear();
      const connection = socketRef.current;
      socketRef.current = null;
      connection?.close();
    };
  }, [user]);

  async function sendCommand(hostId: string, command: ClientCommand) {
    const parsed = clientCommandSchema.parse(command);
    const key = await getHostKey(hostId);
    if (!key) throw new Error("此浏览器没有该主机的解密密钥，请重新配对。");
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("实时连接尚未建立，请稍后重试。");
    const sequence = Number(localStorage.getItem(`command:${hostId}`) ?? 0) + 1;
    localStorage.setItem(`command:${hostId}`, String(sequence));
    socket.send(JSON.stringify(await createEnvelope(hostId, sequence, key, parsed)));
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    location.reload();
  }

  async function deleteHost(host: Host) {
    if (!window.confirm(`确定删除设备“${host.name}”吗？该设备的云端加密同步记录也会被删除。`)) return;
    await api(`/api/hosts/${host.id}`, { method: "DELETE" });
    await removeHostKey(host.id);
    setHosts((current) => current.filter((item) => item.id !== host.id));
    setRuntime((current) => {
      const next = { ...current };
      delete next[host.id];
      return next;
    });
    setSelectedHostId((current) => current === host.id ? hosts.find((item) => item.id !== host.id)?.id ?? null : current);
    setSelectedTaskId(null);
    setMobilePane("hosts");
  }

  async function renameHost(host: Host) {
    const nextName = window.prompt("为这台客户端设置一个好记的名称", host.name)?.trim();
    if (!nextName || nextName === host.name) return;
    if (nextName.length > 64) throw new Error("名称最多 64 个字符");
    const response = await api<{ host: { id: string; name: string } }>(`/api/hosts/${host.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: nextName })
    });
    setHosts((current) => current.map((item) => item.id === host.id ? { ...item, name: response.host.name } : item));
  }

  async function syncHostTasks(hostId: string, options: { limit?: number; query?: string } = {}) {
    setSyncStatus((current) => ({ ...current, [hostId]: t("syncing") }));
    const timeout = window.setTimeout(() => {
      setSyncStatus((current) => {
        if (current[hostId] !== t("syncing") && !String(current[hostId] ?? "").startsWith(t("syncing"))) return current;
        const next = { ...current };
        delete next[hostId];
        return next;
      });
    }, 90_000);
    try {
      await sendCommand(hostId, {
        type: "sync.request",
        commandId: crypto.randomUUID(),
        limit: options.limit ?? 20,
        ...(options.query ? { query: options.query } : {})
      });
    } catch (syncError) {
      setSyncStatus((current) => {
        const next = { ...current };
        delete next[hostId];
        return next;
      });
      throw syncError;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  useEffect(() => {
    if (!selectedHostId || !taskQuery.trim()) return;
    if (taskSearchTimerRef.current) window.clearTimeout(taskSearchTimerRef.current);
    taskSearchTimerRef.current = window.setTimeout(() => {
      const hostId = selectedHostId;
      const online = runtime[hostId]?.online;
      if (online !== true) return;
      void syncHostTasks(hostId, { query: taskQuery.trim() }).catch((error) => setError(error.message));
    }, 450);
    return () => {
      if (taskSearchTimerRef.current) window.clearTimeout(taskSearchTimerRef.current);
    };
  }, [taskQuery, selectedHostId]);

  if (!health) return <main className="loading-screen"><div className="pulse" /><p>正在进入随码安全工作区…</p>{error && <ErrorBanner message={error} clear={() => setError("")} />}</main>;
  if (!user) return <AuthScreen health={health} onAuthenticated={setUser} />;

  const activeHost = hosts.find((host) => host.id === selectedHostId) ?? null;
  const activeRuntime = selectedHostId ? runtime[selectedHostId] ?? emptyRuntime() : emptyRuntime();
  const tasks = Object.values(activeRuntime.tasks).sort((left, right) => right.updatedAt - left.updatedAt);
  const normalizedTaskQuery = taskQuery.trim().toLowerCase();
  const filteredTasks = tasks.filter((task) => {
    if (engineFilter) {
      const engine = task.cliEngine ? normalizeCliEngine(task.cliEngine) : "codex";
      if (engine !== engineFilter) return false;
    }
    if (!normalizedTaskQuery) return true;
    const messageText = task.messages.map((message) => message.text).join("\n");
    const haystack = `${task.title}\n${task.cwd}\n${task.status}\n${messageText}`.toLowerCase();
    return haystack.includes(normalizedTaskQuery);
  });
  const activeTask = filteredTasks.find((task) => task.threadId === selectedTaskId)
    ?? tasks.find((task) => task.threadId === selectedTaskId)
    ?? filteredTasks[0]
    ?? null;

  const clientVersion = activeRuntime.agentVersion;
  const clientOutdated = Boolean(
    activeHost
    && activeRuntime.online === true
    && clientVersion
    && compareSemver(clientVersion, MIN_AGENT_VERSION) < 0
  );
  const clientVersionUnknown = Boolean(
    activeHost
    && activeRuntime.online === true
    && !clientVersion
  );

  return <div className="app-shell">
    {error && <ErrorBanner message={error} clear={() => setError("")} />}
    {(clientOutdated || clientVersionUnknown) && (
      <div className="version-banner" role="status">
        <div>
          <strong>{clientOutdated ? "客户端版本过旧" : "客户端未上报版本"}</strong>
          <span>
            {clientOutdated
              ? `当前网页 v${PRODUCT_VERSION} 需要桌面客户端 ≥ v${MIN_AGENT_VERSION}，检测到 v${clientVersion}。请更新客户端以保证多引擎与任务同步正常。`
              : `当前网页 v${PRODUCT_VERSION}。请升级到对应版本的桌面客户端（v${MIN_AGENT_VERSION}）以获得完整能力与版本校验。`}
          </span>
        </div>
        <div className="version-banner-actions">
          {health.clientDownloads.windows && <a href={health.clientDownloads.windows}>Windows</a>}
          {health.clientDownloads.mac && <a href={health.clientDownloads.mac}>macOS</a>}
          {!health.clientDownloads.windows && !health.clientDownloads.mac && (
            <a href="https://github.com/demonrain/anytimevibe/releases" target="_blank" rel="noreferrer">下载更新</a>
          )}
        </div>
      </div>
    )}
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><img src="/icon.svg" alt="" /></span><div><strong>{t("brand")}</strong><small>{t("brandTag")}</small></div></div>
      <div className="top-actions">
        <span className="version-chip" title="网页与客户端应对齐同一产品版本">
          Web v{PRODUCT_VERSION}
          {activeHost
            ? ` · 客户端 ${clientVersion ? `v${clientVersion}` : "未知"}`
            : ` · 客户端 v${MIN_AGENT_VERSION}`}
        </span>
        <ClientDownloads downloads={health.clientDownloads} />
        <div className="lang-switch" role="group" aria-label={t("lang")}>
          <button type="button" className={locale === "zh-CN" ? "active" : ""} onClick={() => setLocale("zh-CN")}>中文</button>
          <button type="button" className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>EN</button>
        </div>
        <button className="quiet" onClick={() => subscribePush(health.vapidPublicKey).catch((pushError) => setError(pushError.message))}>{t("notify")}</button>
        <div className="account-menu">
          <button className="avatar" title={user.username} aria-expanded={accountOpen} onClick={() => setAccountOpen((open) => !open)}>{user.username.slice(0, 1).toUpperCase()}</button>
          {accountOpen && <div className="account-popover">
            <div><strong>{user.username}</strong><small>{user.isAdmin ? t("administrator") : t("personalSpace")}</small></div>
            {user.isAdmin && <a className="account-link" href="/admin">{t("admin")}</a>}
            <button onClick={() => logout().catch((logoutError) => setError(logoutError.message))}>{t("logout")}</button>
          </div>}
        </div>
      </div>
    </header>

    <aside className="rail">
      <div className="rail-heading"><span>{t("remoteHosts")}</span><button onClick={() => setPairingOpen(true)}>＋</button></div>
      <div className="host-list">
        <button className="host-add-mobile" onClick={() => setPairingOpen(true)}>{t("addComputer")}</button>
        {hosts.map((host) => {
          const hostEngines = readyEngines(runtime[host.id]?.availableEngines);
          // Fallback: older agents only report codexVersion
          const engineChips = hostEngines.length
            ? hostEngines
            : (host.codexVersion && host.codexVersion !== "unknown"
              ? [{ engine: "codex" as const, ready: true, version: host.codexVersion }]
              : []);
          return <div key={host.id} className={`host-row ${host.id === selectedHostId ? "active" : ""}`}>
            <button className="host-pill" onClick={() => { setSelectedHostId(host.id); setSelectedTaskId(null); setMobilePane("tasks"); }}>
              <span className={`status-dot ${(runtime[host.id]?.online ?? host.online) ? "online" : ""}`} />
              <span className="host-pill-body">
                <strong className="host-name">{host.name}</strong>
                {engineChips.length > 0 && (
                  <span className="host-engine-rail" aria-label="installed engines">
                    {engineChips.map((item) => (
                      <span
                        key={item.engine}
                        className="host-engine-item"
                        title={`${cliEngineLabel(item.engine)}${item.version ? ` · ${item.version}` : ""}`}
                      >
                        <EngineLogo engine={item.engine} size={16} />
                        <span className="host-engine-ver">{item.version || "—"}</span>
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </button>
            <button className="host-rename" title={`${t("renameHost")} ${host.name}`} aria-label={`${t("renameHost")} ${host.name}`} onClick={() => renameHost(host).catch((renameError) => setError(renameError.message))}>✎</button>
            <button className="host-delete" title={`${t("deleteHost")} ${host.name}`} aria-label={`${t("deleteHost")} ${host.name}`} onClick={() => deleteHost(host).catch((deleteError) => setError(deleteError.message))}>×</button>
          </div>;
        })}
        {!hosts.length && <button className="empty-host" onClick={() => setPairingOpen(true)}>{t("connectFirst")}</button>}
      </div>
    </aside>

    <main className={`workspace mobile-${mobilePane}`}>
      <section className="task-column">
        <button className="mobile-level-back" type="button" onClick={() => setMobilePane("hosts")}>{t("clients")}</button>
        <div className="section-title">
          <div><p className="eyebrow">{t("taskStream")}</p><h1 className="host-title">{activeHost?.name ?? t("noHost")}</h1></div>
          <div className="section-actions">
            <button className="sync-tasks" disabled={!activeHost || activeRuntime.online !== true || String(syncStatus[activeHost.id] ?? "").startsWith(t("syncing"))} onClick={() => activeHost && syncHostTasks(activeHost.id).catch((syncError) => setError(syncError.message))}>{activeHost ? syncStatus[activeHost.id] ?? t("syncTasks") : t("syncTasks")}</button>
            <button className="new-task" disabled={!activeHost || activeRuntime.online !== true} onClick={() => setComposerOpen(true)}>{t("newTask")}</button>
          </div>
        </div>
        <div className="connection-note"><span className={`status-dot ${activeRuntime.online ? "online" : ""}`} />{activeRuntime.online === true ? t("hostOnline") : activeRuntime.online === false ? t("hostOffline") : t("hostChecking")}</div>
        {activeHost && keyAuthorizationStatus[activeHost.id] && <div className="key-authorization-note"><div><strong>{keyAuthorizationStatus[activeHost.id] === "authorizing" ? "正在授权此浏览器" : "此浏览器尚未取得主机密钥"}</strong><span>{activeRuntime.online === true ? "电脑端会自动完成端到端密钥授权。" : "请先让电脑端客户端上线，再重新授权。"}</span></div><button disabled={keyAuthorizationStatus[activeHost.id] === "authorizing" || activeRuntime.online !== true} onClick={() => authorizeExistingHost(activeHost.id).catch((authorizationError) => setError(authorizationError.message))}>{keyAuthorizationStatus[activeHost.id] === "authorizing" ? "授权中…" : "授权此浏览器"}</button></div>}
        <div className="engine-filter" role="toolbar" aria-label="按编码引擎筛选任务">
          {(["codex", "claude", "grok"] as CliEngine[]).map((engine) => {
            const count = tasks.filter((task) => normalizeCliEngine(task.cliEngine) === engine).length;
            const active = engineFilter === engine;
            return (
              <button
                key={engine}
                type="button"
                className={`engine-filter-btn ${active ? "active" : ""}`}
                title={`${cliEngineLabel(engine)} · ${count}`}
                aria-pressed={active}
                onClick={() => setEngineFilter((current) => (current === engine ? null : engine))}
              >
                <EngineLogo engine={engine} size={20} />
                <span className="engine-filter-count">{count}</span>
              </button>
            );
          })}
          {engineFilter && (
            <button type="button" className="engine-filter-clear" onClick={() => setEngineFilter(null)}>全部</button>
          )}
        </div>
        <div className="task-search">
          <input
            value={taskQuery}
            onChange={(event) => setTaskQuery(event.target.value)}
            placeholder={t("searchTasks")}
            aria-label={t("searchTasks")}
          />
          {(normalizedTaskQuery || engineFilter) && <small>{filteredTasks.length}/{tasks.length}</small>}
        </div>
        <div className="task-list">
          {filteredTasks.map((task) => {
            const status = taskStatusMeta(task.status);
            const engine = task.cliEngine ? normalizeCliEngine(task.cliEngine) : undefined;
            return <button key={task.threadId} className={`task-card ${activeTask?.threadId === task.threadId ? "active" : ""}`} onClick={() => selectTask(task.threadId)}>
              <div className="task-meta">
                <span className="task-meta-left">
                  {engine && <EngineLogo engine={engine} size={14} className="task-engine-logo" />}
                  <span className={`task-status ${status.tone}`}>{status.label}</span>
                </span>
                <time>{new Date(task.updatedAt * 1000).toLocaleString()}</time>
              </div>
              <h3>{task.title}</h3>
              <p>{task.messages.at(-1)?.text || task.cwd}</p>
              <div className="task-foot"><code>{shortPath(task.cwd)}</code>{task.approvals.length > 0 && <b>{task.approvals.length}</b>}</div>
            </button>;
          })}
          {!tasks.length && <div className="empty-state"><span>&gt;_</span><h3>{t("noTasks")}</h3><p>{t("noTasksHint")}</p></div>}
          {Boolean(tasks.length && !filteredTasks.length) && <div className="empty-state"><span>?</span><h3>{t("noMatch")}</h3><p>{t("noMatchHint")}</p></div>}
        </div>
      </section>

      <section className="conversation-column">
        {activeTask ? <TaskConversation key={activeTask.threadId} task={activeTask} online={activeRuntime.online} visible={mobilePane === "conversation"} permissionMode={permissionMode} replyDetail={replyDetail} onPermissionModeChange={(mode) => { const next = normalizePermissionMode(mode); setPermissionMode(next); localStorage.setItem("permission-mode", next); }} onReplyDetailChange={(detail) => { const next = normalizeReplyDetail(detail); setReplyDetail(next); localStorage.setItem(REPLY_DETAIL_STORAGE_KEY, next); }} onBack={() => { setMobilePane("tasks"); window.scrollTo({ top: 0, behavior: "instant" }); }} onCommand={(command) => sendCommand(activeHost!.id, command).catch((sendError) => setError(sendError.message))} /> : <div className="conversation-empty"><div className="orbit" /><h2>{t("pickTask")}</h2><p>{t("pickTaskHint")}</p></div>}
      </section>
    </main>

    {pairingOpen && <PairingDialog onClose={() => setPairingOpen(false)} onPaired={async () => { setPairingOpen(false); await loadHosts(); }} />}
    {composerOpen && activeHost && <NewTaskDialog
      host={activeHost}
      workspaces={activeRuntime.workspaces}
      online={activeRuntime.online}
      availableEngines={activeRuntime.availableEngines ?? []}
      onClose={() => setComposerOpen(false)}
      onRefreshWorkspaces={() => sendCommand(activeHost.id, { type: "host.refresh", commandId: crypto.randomUUID() })}
      onCreate={async (cwd, prompt, title, engine, mode, model, reasoningEffort) => {
        setPermissionMode(mode);
        localStorage.setItem("permission-mode", mode);
        await sendCommand(activeHost.id, {
          type: "task.create",
          commandId: crypto.randomUUID(),
          cwd,
          prompt,
          permissionMode: mode,
          cliEngine: engine,
          ...(title ? { title } : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {})
        });
        setComposerOpen(false);
      }}
    />}
  </div>;
}

function TaskConversation({ task, online, visible, permissionMode, replyDetail, onPermissionModeChange, onReplyDetailChange, onBack, onCommand }: { task: Task; online: boolean | null; visible: boolean; permissionMode: PermissionMode; replyDetail: ReplyDetail; onPermissionModeChange(mode: PermissionMode): void; onReplyDetailChange(detail: ReplyDetail): void; onBack(): void; onCommand(command: ClientCommand): void }) {
  const { t, locale } = useI18n();
  const [prompt, setPrompt] = useState("");
  const [pendingPrompt, setPendingPrompt] = useState("");
  const [pendingMessageCount, setPendingMessageCount] = useState(0);
  const [commandQueue, setCommandQueue] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`command-queue:${task.threadId}`) ?? "[]") as string[]; }
    catch { return []; }
  });
  const [tab, setTab] = useState<"chat" | "diff">("chat");
  const taskEngine = normalizeCliEngine(task.cliEngine);
  const [model, setModel] = useState(task.model || "");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(task.reasoningEffort || "");
  const messageStreamRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottomRef = useRef(true);
  const previousThreadRef = useRef(task.threadId);
  const running = Boolean(task.activeTurnId);
  const permissionOptions = permissionOptionsForEngine(taskEngine, locale);
  const modelOptions = modelOptionsForEngine(taskEngine);
  const effortOptions = effortOptionsForEngine(taskEngine);
  const contextLabel = formatContextUsage(task.contextUsage);
  const isMac = isMacPlatform();
  const visibleMessages = replyDetail === "detailed"
    ? task.messages
    : task.messages.filter((message) => !isProcessStreamMessage(message));
  const lastMessageLength = visibleMessages.at(-1)?.text.length ?? 0;

  useEffect(() => {
    if (!permissionOptions.some((item) => item.value === permissionMode)) {
      onPermissionModeChange(permissionOptions[0]?.value ?? "ask-for-approval");
    }
  }, [task.threadId, taskEngine]);

  useEffect(() => {
    setModel(task.model || "");
    setReasoningEffort(task.reasoningEffort || "");
  }, [task.threadId, task.model, task.reasoningEffort]);

  function turnStartCommand(text: string): ClientCommand {
    return {
      type: "turn.start",
      commandId: crypto.randomUUID(),
      threadId: task.threadId,
      prompt: text,
      permissionMode,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    };
  }

  function submitPrompt() {
    if (!prompt.trim() || online !== true) return;
    const submittedPrompt = prompt.trim();
    stickToBottomRef.current = true;
    if (running || pendingPrompt) setCommandQueue((current) => [...current, submittedPrompt]);
    else {
      setPendingPrompt(submittedPrompt);
      setPendingMessageCount(task.messages.length);
      onCommand(turnStartCommand(submittedPrompt));
    }
    setPrompt("");
  }

  useEffect(() => {
    localStorage.setItem(`command-queue:${task.threadId}`, JSON.stringify(commandQueue));
  }, [commandQueue, task.threadId]);

  useEffect(() => {
    if (running || pendingPrompt || online !== true || commandQueue.length === 0) return;
    const nextPrompt = commandQueue[0]!;
    setCommandQueue(commandQueue.slice(1));
    setPendingPrompt(nextPrompt);
    setPendingMessageCount(task.messages.length);
    stickToBottomRef.current = true;
    onCommand(turnStartCommand(nextPrompt));
  }, [commandQueue, online, onCommand, pendingPrompt, permissionMode, running, task.threadId, model, reasoningEffort]);

  useEffect(() => {
    const latestMessage = task.messages.at(-1);
    if (pendingPrompt && task.messages.length > pendingMessageCount && latestMessage?.role === "user" && latestMessage.text === pendingPrompt) setPendingPrompt("");
  }, [pendingMessageCount, pendingPrompt, task.messages]);

  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 220 ? "auto" : "hidden";
  }, [prompt]);

  useLayoutEffect(() => {
    const stream = messageStreamRef.current;
    if (!stream || tab !== "chat") return;
    const changedThread = previousThreadRef.current !== task.threadId;
    previousThreadRef.current = task.threadId;
    if (changedThread || visible || stickToBottomRef.current) {
      const frame = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          stream.scrollTop = stream.scrollHeight;
        });
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [task.threadId, visibleMessages.length, lastMessageLength, task.approvals.length, pendingPrompt, tab, visible, replyDetail]);

  return <>
    <div className="conversation-head">
      <button className="mobile-back" type="button" onClick={onBack} aria-label="返回任务列表">‹</button>
      <div>
        <p className="eyebrow">THREAD</p>
        <h2 title={task.title} className="thread-title-row">
          <EngineLogo engine={taskEngine} size={18} className="thread-engine-logo" />
          <span>{task.title}</span>
        </h2>
        <code title={task.cwd}>{task.cwd}</code>
        {(model || task.model || reasoningEffort || task.reasoningEffort || contextLabel) && (
          <p className="thread-meta-line">
            {[model || task.model, reasoningEffort || task.reasoningEffort, contextLabel].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
      <div className="tabs"><button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>{t("chat")}</button><button className={tab === "diff" ? "active" : ""} onClick={() => setTab("diff")}>{t("diff")}</button></div>
    </div>
    {tab === "chat" ? <div className="message-stream" ref={messageStreamRef} onScroll={(event) => {
      const stream = event.currentTarget;
      stickToBottomRef.current = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 90;
    }}>
      {visibleMessages.map((message) => {
        const process = isProcessStreamMessage(message);
        const label = message.role === "user"
          ? "YOU"
          : message.role === "system"
            ? "SYSTEM"
            : process
              ? t("replyProcess")
              : assistantEngineBadge(taskEngine);
        return <article key={message.id} className={`message ${message.role}${process ? " process" : ""}`}><span>{label}</span><pre>{sanitizeDisplayText(message.text)}</pre></article>;
      })}
      {pendingPrompt && <article className="message user pending"><span>YOU · 发送中</span><pre>{sanitizeDisplayText(pendingPrompt)}</pre></article>}
      {running && <article className="processing-card"><span className="processing-spinner" /><div><strong>{t("processing")}</strong><p>{t("processingHint")}</p></div></article>}
      {commandQueue.length > 0 && <section className="command-queue"><div><strong>{t("queue")}</strong><span>{commandQueue.length}</span></div>{commandQueue.map((queuedPrompt, index) => <article key={`${index}:${queuedPrompt}`}><b>{index + 1}</b><p>{sanitizeDisplayText(queuedPrompt)}</p></article>)}</section>}
      {task.approvals.map((approval) => <article className="approval-card" key={String(approval.requestId)}>
        <div className="approval-label">{t("actionRequired")}</div><h3>{approval.title}</h3><pre>{sanitizeDisplayText(approval.detail)}</pre>
        <div className="approval-actions"><button onClick={() => onCommand({ type: "approval.resolve", commandId: crypto.randomUUID(), requestId: approval.requestId, decision: "decline" })}>{t("decline")}</button><button className="approve" onClick={() => onCommand({ type: "approval.resolve", commandId: crypto.randomUUID(), requestId: approval.requestId, decision: "accept" })}>{t("allowOnce")}</button></div>
      </article>)}
      <div className="message-end" ref={messageEndRef} />
    </div> : <DiffView diff={task.diff} />}
    <form className="composer" onSubmit={(event) => {
      event.preventDefault();
      submitPrompt();
    }}>
      <textarea ref={composerTextareaRef} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
        const sendHotkey = isMac ? event.metaKey : event.ctrlKey;
        if (sendHotkey && event.key === "Enter") {
          event.preventDefault();
          submitPrompt();
        }
      }} placeholder={online === false ? "主机离线，可先编辑，恢复在线后再发送" : running ? "给当前任务追加方向…" : "继续这个任务…"} />
      <div>
        <small>
          <label className="composer-permission">
            模型
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {modelOptions.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="composer-permission">
            推理强度
            <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort | "")}>
              {effortOptions.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="composer-permission">
            {t("currentPermission")}
            <select value={permissionMode} onChange={(event) => onPermissionModeChange(normalizePermissionMode(event.target.value))}>
              {permissionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="composer-reply-detail">
            {t("agentReplyDetail")}
            <select value={replyDetail} onChange={(event) => onReplyDetailChange(normalizeReplyDetail(event.target.value))}>
              <option value="concise">{t("replyConcise")}</option>
              <option value="detailed">{t("replyDetailed")}</option>
            </select>
          </label>
          <span className="send-shortcut">
            {isMac ? <><kbd>⌘</kbd> + <kbd>Enter</kbd></> : <><kbd>Ctrl</kbd> + <kbd>Enter</kbd></>}
            {" "}{t("sendShortcut")}
          </span>
        </small>
        {running && task.activeTurnId && <button type="button" className="stop" onClick={() => onCommand({ type: "turn.interrupt", commandId: crypto.randomUUID(), threadId: task.threadId, turnId: task.activeTurnId! })}>{t("stop")}</button>}
        <button className="send" disabled={online !== true || !prompt.trim()}>{t("send")}</button>
      </div>
    </form>
  </>;
}

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="diff-empty">当前任务还没有产生代码变更。</div>;
  return <div className="diff-view">{sanitizeDisplayText(diff).split("\n").map((line, index) => <div key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "remove" : line.startsWith("@@") ? "hunk" : ""}>{line || " "}</div>)}</div>;
}

function PairingDialog({ onClose, onPaired }: { onClose(): void; onPaired(): void }) {
  const [code, setCode] = useState("");
  const [info, setInfo] = useState<PairingPublicInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function inspect() {
    setLoading(true); setError("");
    try { setInfo(await api<PairingPublicInfo>(`/api/pairings/code/${code}`)); }
    catch (inspectError) { setError(inspectError instanceof Error ? inspectError.message : "配对码无效"); }
    finally { setLoading(false); }
  }

  async function claim() {
    if (!info) return;
    setLoading(true); setError("");
    try {
      const keyPair = await generatePairingKeyPair();
      const clientPublicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      const pairingKey = await derivePairingKey(keyPair.privateKey, info.agentPublicKey, info.pairingId);
      const result = pairingClaimResponseSchema.parse(await api<unknown>(`/api/pairings/${info.pairingId}/claim`, {
        method: "POST",
        body: JSON.stringify({ clientPublicKey })
      }));
      let authorization: { status: string; hostId?: string; wrappedSyncKey?: { nonce: string; ciphertext: string } } | null = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = await api<{ status: string; hostId?: string; wrappedSyncKey?: { nonce: string; ciphertext: string } }>(`/api/pairings/${info.pairingId}/status`);
        authorization = status;
        if (status.status === "authorized") break;
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      if (!authorization?.wrappedSyncKey) throw new Error("等待电脑授权超时，请确认 Agent 保持在线后重试。");
      const unwrapped = await decryptPayload<{ syncKey: string }>(pairingKey, authorization.wrappedSyncKey, info.pairingId);
      const syncBytes = base64ToBytes(unwrapped.syncKey);
      await saveHostKey(result.host.id, await importAesKey(syncBytes));
      onPaired();
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : "配对失败");
    } finally { setLoading(false); }
  }

  return <div className="modal-backdrop"><section className="modal">
    <button className="modal-close" onClick={onClose}>×</button><p className="eyebrow">PAIR A HOST</p><h2>连接电脑代理</h2>
    {!info ? <><p>在电脑端打开随码托盘窗口，点击「生成配对码」。</p><input className="pair-code" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="000000" /><button className="primary" disabled={code.length !== 6 || loading} onClick={inspect}>{loading ? "查询中…" : "检查配对码"}</button></> : <div className="pair-preview"><span className="computer-icon">▣</span><h3>{info.agentName}</h3><p>{info.platform} · {info.codexVersion}</p><button className="primary" disabled={loading} onClick={claim}>{loading ? "正在交换密钥…" : "确认并连接"}</button></div>}
    {error && <p className="form-error">{error}</p>}
  </section></div>;
}

function NewTaskDialog({ host, workspaces, online, availableEngines, onClose, onRefreshWorkspaces, onCreate }: {
  host: Host;
  workspaces: Workspace[];
  online: boolean | null;
  availableEngines: CliEngineInfo[];
  onClose(): void;
  onRefreshWorkspaces(): Promise<void>;
  onCreate(cwd: string, prompt: string, title: string, engine: CliEngine, permissionMode: PermissionMode, model?: string, reasoningEffort?: ReasoningEffort): Promise<void>;
}) {
  const { locale } = useI18n();
  const ready = readyEngines(availableEngines);
  const [cwd, setCwd] = useState(workspaces[0]?.path ?? "");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [engine, setEngine] = useState<CliEngine | "">(ready[0]?.engine ?? "");
  const permissionOptions = permissionOptionsForEngine(engine ? normalizeCliEngine(engine) : "codex", locale);
  const [taskPermission, setTaskPermission] = useState<PermissionMode>(permissionOptions[0]?.value ?? "ask-for-approval");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const modelOptions = modelOptionsForEngine(engine ? normalizeCliEngine(engine) : "codex");
  const effortOptions = effortOptionsForEngine(engine ? normalizeCliEngine(engine) : "codex");

  // When host.status arrives after open, pick the first allowlisted path.
  useEffect(() => {
    if (!workspaces.length) return;
    setCwd((current) => (current && workspaces.some((item) => item.path === current) ? current : workspaces[0]!.path));
  }, [workspaces]);

  useEffect(() => {
    if (!ready.length) {
      setEngine("");
      return;
    }
    setEngine((current) => (current && ready.some((item) => item.engine === current) ? current : ready[0]!.engine));
  }, [availableEngines]);

  useEffect(() => {
    const options = permissionOptionsForEngine(engine ? normalizeCliEngine(engine) : "codex", locale);
    setTaskPermission((current) => (options.some((item) => item.value === current) ? current : options[0]!.value));
    setModel("");
    setReasoningEffort("");
  }, [engine, locale]);

  // Pull latest whitelist from the agent once when the dialog opens (avoid dep on unstable callback identity).
  const refreshRef = useRef(onRefreshWorkspaces);
  refreshRef.current = onRefreshWorkspaces;
  useEffect(() => {
    if (online !== true) return;
    let cancelled = false;
    setRefreshing(true);
    refreshRef.current()
      .catch((refreshError) => {
        if (!cancelled) setError(refreshError instanceof Error ? refreshError.message : "无法刷新工作区列表");
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => { cancelled = true; };
  }, [host.id, online]);

  return <div className="modal-backdrop"><form className="modal wide" onSubmit={async (event) => {
    event.preventDefault();
    if (!engine) {
      setError("请选择编码引擎");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await onCreate(
        cwd,
        prompt,
        title,
        engine,
        taskPermission,
        model || undefined,
        reasoningEffort || undefined
      );
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "任务创建失败");
      setLoading(false);
    }
  }}>
    <button type="button" className="modal-close" onClick={onClose}>×</button>
    <p className="eyebrow">NEW REMOTE TASK</p>
    <h2>向 {host.name} 下发任务</h2>
    <div className="engine-picker">
      <span className="engine-picker-label">编码引擎</span>
      <div className="engine-picker-grid" role="radiogroup" aria-label="编码引擎">
        {(["codex", "claude", "grok"] as CliEngine[]).map((item) => {
          const info = availableEngines.find((entry) => entry.engine === item);
          const isReady = Boolean(info?.ready);
          const selected = engine === item;
          return (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`engine-card ${selected ? "selected" : ""} ${isReady ? "" : "disabled"}`}
              disabled={!isReady}
              onClick={() => setEngine(item)}
              title={isReady ? `${cliEngineLabel(item)}${info?.version ? ` ${info.version}` : ""}` : `${cliEngineLabel(item)} 未安装`}
            >
              <EngineLogo engine={item} size={32} />
              <strong>{cliEngineLabel(item)}</strong>
              <small>{isReady ? (info?.version || "已安装") : "未安装"}</small>
            </button>
          );
        })}
      </div>
    </div>
    <label>模型
      <select value={model} onChange={(event) => setModel(event.target.value)} disabled={!engine}>
        {modelOptions.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    <label>推理强度
      <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort | "")} disabled={!engine}>
        {effortOptions.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    <label>权限模式
      <select value={taskPermission} onChange={(event) => setTaskPermission(normalizePermissionMode(event.target.value))} disabled={!engine}>
        {permissionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    <label>工作区
      <select value={cwd} onChange={(event) => setCwd(event.target.value)} required disabled={!workspaces.length}>
        {!workspaces.length && <option value="" disabled>{refreshing ? "正在从电脑端读取白名单…" : online === true ? "电脑端尚未添加白名单目录" : "主机离线，无法读取白名单"}</option>}
        {workspaces.map((workspace) => <option key={workspace.id} value={workspace.path}>{workspace.name} · {workspace.path}</option>)}
      </select>
    </label>
    {online === true && <p className="admin-hint" style={{ marginTop: -6 }}>{refreshing ? "正在同步工作区…" : workspaces.length ? `已加载 ${workspaces.length} 个白名单目录` : "若刚添加目录，请确认电脑端客户端在线后重试。"}</p>}
    <label>任务标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="可选，默认使用第一条指令" /></label>
    <label>任务指令<textarea className="task-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述目标、约束和验收方式…" required /></label>
    {error && <p className="form-error">{error}</p>}
    <button className="primary" disabled={loading || !cwd || !prompt.trim() || !engine}>{loading ? "正在发送…" : "开始任务"}</button>
  </form></div>;
}

async function subscribePush(vapidPublicKey: string | null): Promise<void> {
  if (!vapidPublicKey) throw new Error("服务端尚未配置 Web Push 密钥。");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("当前浏览器不支持 Web Push。");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知权限未授予。");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: (() => {
      const bytes = base64ToBytes(vapidPublicKey);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    })()
  });
  await api("/api/push/subscriptions", { method: "POST", body: JSON.stringify(subscription.toJSON()) });
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || path;
}
