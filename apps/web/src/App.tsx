import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  type TouchEvent as ReactTouchEvent
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  type EngineCapability,
  type EngineModelOption,
  type EngineQuota,
  type PairingPublicInfo,
  type PermissionMode,
  type ReasoningEffort,
  type Workspace,
  PRODUCT_VERSION,
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
import { syncPushSubscription } from "./push";

/**
 * Subscription quota query is temporarily disabled:
 * - CLI usage probes (e.g. `claude -p /usage`) can create real remote task records
 * - returned numbers are often session-cost only, not plan remaining
 * Flip to true when a reliable per-engine quota API is ready.
 */
const QUOTA_QUERY_ENABLED = false;

type Health = {
  ok: boolean;
  needsSetup: boolean;
  registrationEnabled: boolean;
  vapidPublicKey: string | null;
  clientDownloads: { windows: string | null; mac: string | null };
  /** Latest published desktop agent version (from GitHub / env); soft update only. */
  latestClientVersion?: string | null;
};
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
type QueuedTurnItem = { commandId: string; prompt: string };

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
  /** Native Claude/Grok session id when known — used to hide import duplicates. */
  providerSessionId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  contextUsage?: ContextUsage;
  /** Follow-up prompts waiting on the agent (not yet started). */
  queuedTurns?: QueuedTurnItem[];
};

function capabilityForEngine(
  capabilities: EngineCapability[] | undefined,
  engine: CliEngine
): EngineCapability | undefined {
  return capabilities?.find((item) => item.engine === engine);
}

/** Prefer host-reported models; always include the task's current model if missing. */
function modelOptionsFromHost(
  capabilities: EngineCapability[] | undefined,
  engine: CliEngine,
  currentModel?: string
): EngineModelOption[] {
  const cap = capabilityForEngine(capabilities, engine);
  const models = [...(cap?.models ?? [])];
  const seen = new Set(models.map((item) => item.id));
  if (currentModel && !seen.has(currentModel)) {
    models.unshift({ id: currentModel, label: currentModel });
  }
  return models;
}

function effortOptionsFromHost(
  capabilities: EngineCapability[] | undefined,
  engine: CliEngine,
  currentEffort?: ReasoningEffort,
  modelId?: string
): ReasoningEffort[] {
  const cap = capabilityForEngine(capabilities, engine);
  const baseId = (modelId || "").split("[")[0]?.trim();
  const modelMeta = baseId
    ? cap?.models.find((item) => item.id === baseId)
    : undefined;
  // Cursor (and engines with per-model catalogs): prefer model-specific efforts.
  if (modelMeta?.reasoningEfforts?.length) {
    const base = [...modelMeta.reasoningEfforts];
    if (currentEffort && !base.includes(currentEffort)) base.unshift(currentEffort);
    return base;
  }
  // Cursor models without effort (Composer / Auto / Grok) → no dropdown.
  if (engine === "cursor") {
    if (currentEffort) return [currentEffort];
    return [];
  }
  const base = cap?.reasoningEfforts?.length
    ? [...cap.reasoningEfforts]
    : engine === "claude"
      ? (["low", "medium", "high", "xhigh", "max"] as ReasoningEffort[])
      : engine === "grok"
        ? (["low", "medium", "high"] as ReasoningEffort[])
        : (["low", "medium", "high", "xhigh"] as ReasoningEffort[]);
  if (currentEffort && !base.includes(currentEffort)) base.unshift(currentEffort);
  return base;
}

function modelOptionMeta(
  capabilities: EngineCapability[] | undefined,
  engine: CliEngine,
  modelId?: string
): EngineModelOption | undefined {
  const baseId = (modelId || "").split("[")[0]?.trim();
  if (!baseId) return undefined;
  return capabilityForEngine(capabilities, engine)?.models.find((item) => item.id === baseId);
}

/** Encode Cursor Fast / strip prior params so agent can compose CLI --model. */
function composeCursorModelId(baseModel: string, fast: boolean | undefined, supportsFast: boolean): string {
  const base = (baseModel || "composer-2.5").split("[")[0]!.trim() || "composer-2.5";
  if (!supportsFast || fast === undefined) return base;
  return `${base}[fast=${fast ? "true" : "false"}]`;
}

function parseFastFromModelId(modelId?: string): boolean | undefined {
  if (!modelId?.includes("[")) return undefined;
  const m = modelId.match(/\[([^\]]+)\]/);
  const body = m?.[1];
  if (!body) return undefined;
  for (const part of body.split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (k === "fast") return v === "true" || v === "1";
  }
  return undefined;
}

function draftStorageKey(threadId: string): string {
  return `task-draft:${threadId}`;
}

function loadTaskDraft(threadId: string): string {
  try {
    return sessionStorage.getItem(draftStorageKey(threadId)) ?? "";
  } catch {
    return "";
  }
}

function saveTaskDraft(threadId: string, text: string): void {
  try {
    if (!text.trim()) sessionStorage.removeItem(draftStorageKey(threadId));
    else sessionStorage.setItem(draftStorageKey(threadId), text);
  } catch {
    // ignore quota / private mode
  }
}

/** Per-task model / reasoning prefs so the UI survives refresh before the next host snapshot. */
function taskPrefsKey(threadId: string): string {
  return `task-prefs:${threadId}`;
}

type TaskUiPrefs = { model?: string; reasoningEffort?: ReasoningEffort; fast?: boolean };

function loadTaskUiPrefs(threadId: string): TaskUiPrefs {
  try {
    const raw = localStorage.getItem(taskPrefsKey(threadId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as TaskUiPrefs;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveTaskUiPrefs(threadId: string, prefs: TaskUiPrefs): void {
  try {
    const current = loadTaskUiPrefs(threadId);
    const next: TaskUiPrefs = { ...current, ...prefs };
    if (!next.model && !next.reasoningEffort && next.fast === undefined) {
      localStorage.removeItem(taskPrefsKey(threadId));
    } else {
      localStorage.setItem(taskPrefsKey(threadId), JSON.stringify(next));
    }
  } catch {
    // ignore quota / private mode
  }
}

function compactTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

type ContextUsageView = {
  usedPercent: number | null;
  remainingTokens: number | null;
  contextWindow: number | null;
  totalTokens: number | null;
  planLabel: string | null;
  planRemaining: number | null;
  planLimit: number | null;
  planUsedPercent: number | null;
};

function parseContextUsageView(usage?: ContextUsage): ContextUsageView | null {
  if (!usage) return null;
  const total = usage.totalTokens
    ?? (((usage.inputTokens || 0) + (usage.outputTokens || 0)) || 0);
  const window = usage.contextWindow ?? null;
  const remaining = usage.remainingTokens
    ?? (window != null ? Math.max(0, window - total) : null);
  const usedPercent = window && window > 0
    ? Math.max(0, Math.min(100, Math.round((total / window) * 100)))
    : null;
  const planRemaining = usage.planRemaining ?? null;
  const planLimit = usage.planLimit ?? null;
  const planUsedPercent = planLimit && planLimit > 0 && planRemaining != null
    ? Math.max(0, Math.min(100, Math.round(((planLimit - planRemaining) / planLimit) * 100)))
    : null;
  const planLabel = usage.planLabel?.trim() || null;
  if (usedPercent == null && remaining == null && !total && !planLabel && planRemaining == null) {
    return null;
  }
  return {
    usedPercent,
    remainingTokens: remaining,
    contextWindow: window,
    totalTokens: total || null,
    planLabel,
    planRemaining,
    planLimit,
    planUsedPercent
  };
}

/** Compact title/tooltip for context chips. */
function contextUsageTitle(view: ContextUsageView): string {
  const parts: string[] = [];
  if (view.usedPercent != null && view.contextWindow != null) {
    parts.push(
      `上下文已用 ${view.usedPercent}%（${compactTokenCount(view.totalTokens || 0)} / ${compactTokenCount(view.contextWindow)}）`
    );
  } else if (view.totalTokens != null) {
    parts.push(`已用约 ${compactTokenCount(view.totalTokens)} tokens`);
  }
  if (view.remainingTokens != null && view.contextWindow != null) {
    parts.push(`上下文剩余 ${compactTokenCount(view.remainingTokens)}`);
  }
  if (view.planLabel || view.planRemaining != null) {
    const plan = view.planLabel || "订阅额度";
    if (view.planRemaining != null && view.planLimit != null) {
      parts.push(`${plan} 剩余 ${compactTokenCount(view.planRemaining)} / ${compactTokenCount(view.planLimit)}`);
    } else if (view.planRemaining != null) {
      parts.push(`${plan} 剩余 ${compactTokenCount(view.planRemaining)}`);
    } else {
      parts.push(plan);
    }
  }
  return parts.join(" · ");
}
type HostRuntime = {
  online: boolean | null;
  workspaces: Workspace[];
  tasks: Record<string, Task>;
  availableEngines?: CliEngineInfo[];
  engineCapabilities?: EngineCapability[];
  /** Desktop agent version reported by host.status.agentVersion / relay.host_meta */
  agentVersion?: string;
  /** Last subscription / plan quota sample from host.quota.refresh */
  engineQuotas?: EngineQuota[];
  quotaDetail?: string;
  quotaLoading?: boolean;
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
  // systemerror / rate_limit_error / failed etc.
  if (normalized.includes("fail") || normalized.includes("error")) return { label: "失败", tone: "failed" };
  if (["interrupted", "cancelled", "canceled", "stopped"].includes(normalized)) return { label: "已停止", tone: "stopped" };
  if (normalized === "idle") return { label: "空闲", tone: "idle" };
  if (normalized === "notloaded") return { label: "未加载", tone: "not-loaded" };
  if (["pending", "queued", "notstarted"].includes(normalized)) return { label: "待处理", tone: "pending" };
  return { label: statusType || "未知状态", tone: "unknown" };
}

function isFailedTaskStatus(status: string | undefined): boolean {
  const normalized = String(status || "").toLowerCase().replace(/[\s_-]/g, "");
  if (!normalized) return false;
  // Successful completions must never match (e.g. avoid false positives).
  if (["completed", "complete", "success", "succeeded", "idle", "active", "running", "processing", "inprogress"].includes(normalized)) {
    return false;
  }
  return (
    normalized.includes("fail")
    || normalized.includes("error")
    || ["interrupted", "cancelled", "canceled", "stopped"].includes(normalized)
  );
}

/** Only treat short, explicit failure notes as error text — not long assistant dumps mis-tagged as system. */
function isErrorSystemMessage(text: string | undefined): boolean {
  const value = String(text || "").trim();
  if (!value) return false;
  // Long narratives are almost never the structured error we emit.
  if (value.length > 800 || value.split(/\n/).length > 12) return false;
  return /^(错误|任务失败|Error|Failed|失败)[:：\s（(]/i.test(value)
    || /任务失败（/.test(value)
    || /退出码|systemerror|未找到.*CLI|无法连接|not logged in|auth/i.test(value);
}

function findLastSystemErrorText(messages: Array<{ role: string; text: string }>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "system" && isErrorSystemMessage(message.text)) {
      return message.text.trim();
    }
  }
  return "";
}

function emptyRuntime(online: boolean | null = null): HostRuntime {
  return { online, workspaces: [], tasks: {}, availableEngines: [] };
}

function normalizeCliEngine(value: string | null | undefined): CliEngine {
  if (value === "claude" || value === "grok" || value === "codex" || value === "cursor") return value;
  return "codex";
}

function cliEngineLabel(engine: CliEngine): string {
  if (engine === "claude") return "Claude Code";
  if (engine === "grok") return "Grok Build";
  if (engine === "cursor") return "Cursor";
  return "Codex";
}

/** Short badge label for assistant bubbles (matches YOU / SYSTEM style). */
function assistantEngineBadge(engine: CliEngine): string {
  if (engine === "claude") return "CLAUDE";
  if (engine === "grok") return "GROK";
  if (engine === "cursor") return "CURSOR";
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
  if (engine === "cursor") {
    return locale === "en"
      ? [
          { value: "read-only", label: "Propose only (no --force)" },
          { value: "ask-for-approval", label: "Apply changes (--force)" },
          { value: "full-access", label: "Full auto (--force)" }
        ]
      : [
          { value: "read-only", label: "仅提议（不写盘）" },
          { value: "ask-for-approval", label: "允许改文件 (--force)" },
          { value: "full-access", label: "全自动写盘 (--force)" }
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

/** Stable markdown config — recreating these every render forces ReactMarkdown to re-walk the tree. */
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-markdown Components typing is overly strict with exactOptionalPropertyTypes
const MARKDOWN_COMPONENTS: any = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
  ),
  pre: ({ children }: { children?: ReactNode }) => <div className="md-pre">{children}</div>,
  code: ({ className, children, ...props }: { className?: string; children?: ReactNode }) => {
    const inline = !className;
    if (inline) return <code className="md-code-inline" {...props}>{children}</code>;
    return <pre className="md-code-block"><code className={className} {...props}>{children}</code></pre>;
  }
};

/** Assistant reply: header (engine label + view toggle) and markdown/source body. */
const AssistantMessageCard = memo(function AssistantMessageCard({ label, text }: { label: string; text: string }) {
  const { locale } = useI18n();
  // Sanitize once per text change; memo keeps markdown parse off the composer keystroke path.
  const clean = useMemo(() => sanitizeDisplayText(text), [text]);
  const [mode, setMode] = useState<"preview" | "source">("preview");
  return (
    <>
      <div className="message-head">
        <span className="message-label">{label}</span>
        <div className="message-view-toggle" role="group" aria-label={locale === "en" ? "View mode" : "显示模式"}>
          <button
            type="button"
            className={mode === "preview" ? "active" : ""}
            onClick={() => setMode("preview")}
          >
            {locale === "en" ? "Preview" : "预览"}
          </button>
          <button
            type="button"
            className={mode === "source" ? "active" : ""}
            onClick={() => setMode("source")}
          >
            {locale === "en" ? "Source" : "源码"}
          </button>
        </div>
      </div>
      {mode === "source" ? (
        <pre className="message-source">{clean}</pre>
      ) : (
        <div className="message-markdown">
          <ReactMarkdown
            remarkPlugins={MARKDOWN_REMARK_PLUGINS}
            components={MARKDOWN_COMPONENTS}
          >
            {clean}
          </ReactMarkdown>
        </div>
      )}
    </>
  );
});

type ChatMessage = { id: string; role: "user" | "assistant" | "system"; text: string };

/** One transcript bubble — memoized so long histories do not re-render on unrelated parent updates. */
const ChatMessageRow = memo(function ChatMessageRow({
  message,
  processLabel,
  assistantLabel
}: {
  message: ChatMessage;
  processLabel: string;
  assistantLabel: string;
}) {
  const process = isProcessStreamMessage(message);
  const label = message.role === "user"
    ? "YOU"
    : message.role === "system"
      ? "SYSTEM"
      : process
        ? processLabel
        : assistantLabel;
  const isAssistantReply = message.role === "assistant" && !process;
  return (
    <article className={`message ${message.role}${process ? " process" : ""}`}>
      {isAssistantReply
        ? <AssistantMessageCard label={label} text={message.text} />
        : <>
            <span>{label}</span>
            <pre>{sanitizeDisplayText(message.text)}</pre>
          </>}
    </article>
  );
});

/**
 * Message list isolated from the composer. Typing must not re-render this tree —
 * with long transcripts ReactMarkdown cost dominates keystroke latency.
 */
const ChatMessageStream = memo(function ChatMessageStream({
  messages,
  replyDetail,
  taskEngine,
  processLabel,
  pendingPrompt,
  showPendingBubble,
  running,
  processingLabel,
  processingHint,
  showFailureBanner,
  failureTitle,
  failureBody,
  canResend,
  resendTitle,
  resendHint,
  resendLabel,
  onResend,
  commandQueue,
  queueLabel,
  cancelQueueLabel,
  cancelQueueAllLabel,
  online,
  onCancelQueuedItem,
  onCancelAllQueued,
  approvals,
  actionRequiredLabel,
  declineLabel,
  allowOnceLabel,
  onCommand,
  stickToBottomRef,
  messageStreamRef,
  messageEndRef
}: {
  messages: ChatMessage[];
  replyDetail: ReplyDetail;
  taskEngine: CliEngine;
  processLabel: string;
  pendingPrompt: string;
  showPendingBubble: boolean;
  running: boolean;
  processingLabel: string;
  processingHint: string;
  showFailureBanner: boolean;
  failureTitle: string;
  failureBody: string;
  canResend: boolean;
  resendTitle: string;
  resendHint: string;
  resendLabel: string;
  onResend(): void;
  commandQueue: QueuedTurnItem[];
  queueLabel: string;
  cancelQueueLabel: string;
  cancelQueueAllLabel: string;
  online: boolean | null;
  onCancelQueuedItem(queueCommandId: string): void;
  onCancelAllQueued(): void;
  approvals: Approval[];
  actionRequiredLabel: string;
  declineLabel: string;
  allowOnceLabel: string;
  onCommand(command: ClientCommand): void;
  stickToBottomRef: MutableRefObject<boolean>;
  messageStreamRef: RefObject<HTMLDivElement | null>;
  messageEndRef: RefObject<HTMLDivElement | null>;
}) {
  const visibleMessages = useMemo(
    () => dedupeAdjacentUserMessages(
      replyDetail === "detailed"
        ? messages
        : messages.filter((message) => !isProcessStreamMessage(message))
    ),
    [messages, replyDetail]
  );
  const assistantLabel = assistantEngineBadge(taskEngine);

  return (
    <div
      className="message-stream"
      ref={messageStreamRef}
      onScroll={(event) => {
        const stream = event.currentTarget;
        stickToBottomRef.current = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 90;
      }}
    >
      {visibleMessages.map((message) => (
        <ChatMessageRow
          key={message.id}
          message={message}
          processLabel={processLabel}
          assistantLabel={assistantLabel}
        />
      ))}
      {showPendingBubble && (
        <article className="message user pending">
          <span>YOU · 发送中</span>
          <pre>{sanitizeDisplayText(pendingPrompt)}</pre>
        </article>
      )}
      {(running || showPendingBubble) && (
        <article className="processing-card">
          <span className="processing-spinner" />
          <div>
            <strong>{processingLabel}</strong>
            <p>{processingHint}</p>
          </div>
        </article>
      )}
      {showFailureBanner && (
        <article className="failure-card" role="alert">
          <div>
            <strong>{failureTitle}</strong>
            <p>{sanitizeDisplayText(failureBody)}</p>
          </div>
        </article>
      )}
      {canResend && (
        <article className="resend-card">
          <div>
            <strong>{resendTitle}</strong>
            <p>{resendHint}</p>
          </div>
          <button type="button" className="resend" onClick={onResend}>{resendLabel}</button>
        </article>
      )}
      {commandQueue.length > 0 && (
        <section className="command-queue">
          <div>
            <strong>{queueLabel}</strong>
            <span>{commandQueue.length}</span>
            {online === true && (
              <button type="button" className="queue-clear" onClick={onCancelAllQueued}>{cancelQueueAllLabel}</button>
            )}
          </div>
          {commandQueue.map((item, index) => (
            <article key={item.commandId}>
              <b>{index + 1}</b>
              <p>{sanitizeDisplayText(item.prompt)}</p>
              {online === true && (
                <button
                  type="button"
                  className="queue-cancel"
                  title={cancelQueueLabel}
                  onClick={() => onCancelQueuedItem(item.commandId)}
                >
                  {cancelQueueLabel}
                </button>
              )}
            </article>
          ))}
        </section>
      )}
      {approvals.map((approval) => (
        <article className="approval-card" key={String(approval.requestId)}>
          <div className="approval-label">{actionRequiredLabel}</div>
          <h3>{approval.title}</h3>
          <pre>{sanitizeDisplayText(approval.detail)}</pre>
          <div className="approval-actions">
            <button onClick={() => onCommand({ type: "approval.resolve", commandId: crypto.randomUUID(), requestId: approval.requestId, decision: "decline" })}>{declineLabel}</button>
            <button className="approve" onClick={() => onCommand({ type: "approval.resolve", commandId: crypto.randomUUID(), requestId: approval.requestId, decision: "accept" })}>{allowOnceLabel}</button>
          </div>
        </article>
      ))}
      <div className="message-end" ref={messageEndRef} />
    </div>
  );
});

/**
 * Composer owns the draft text so keystrokes do not re-render the message stream.
 * draftClearNonce increments when the parent force-clears (stop / successful send path).
 */
const ConversationComposer = memo(function ConversationComposer({
  threadId,
  online,
  running,
  pendingPrompt,
  draftClearNonce,
  model,
  modelOptions,
  modelMeta,
  taskEngine,
  reasoningEffort,
  effortOptions,
  fastMode,
  permissionMode,
  permissionOptions,
  replyDetail,
  canResend,
  isMac,
  sendLabel,
  stopLabel,
  resendLabel,
  currentPermissionLabel,
  agentReplyDetailLabel,
  replyConciseLabel,
  replyDetailedLabel,
  sendShortcutLabel,
  onModelChange,
  onReasoningEffortChange,
  onFastModeChange,
  onPermissionModeChange,
  onReplyDetailChange,
  onSubmitPrompt,
  onStop,
  onResend
}: {
  threadId: string;
  online: boolean | null;
  running: boolean;
  pendingPrompt: string;
  draftClearNonce: number;
  model: string;
  modelOptions: Array<{ id: string; label: string }>;
  modelMeta: ReturnType<typeof modelOptionMeta>;
  taskEngine: CliEngine;
  reasoningEffort: ReasoningEffort | "";
  effortOptions: ReasoningEffort[];
  fastMode: boolean;
  permissionMode: PermissionMode;
  permissionOptions: Array<{ value: PermissionMode; label: string }>;
  replyDetail: ReplyDetail;
  canResend: boolean;
  isMac: boolean;
  sendLabel: string;
  stopLabel: string;
  resendLabel: string;
  currentPermissionLabel: string;
  agentReplyDetailLabel: string;
  replyConciseLabel: string;
  replyDetailedLabel: string;
  sendShortcutLabel: string;
  onModelChange(model: string): void;
  onReasoningEffortChange(effort: ReasoningEffort): void;
  onFastModeChange(fast: boolean): void;
  onPermissionModeChange(mode: PermissionMode): void;
  onReplyDetailChange(detail: ReplyDetail): void;
  onSubmitPrompt(text: string): void;
  onStop(): void;
  onResend(): void;
}) {
  const [prompt, setPrompt] = useState(() => loadTaskDraft(threadId));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const draftTimerRef = useRef<number | null>(null);

  // Parent forces clear after stop / send handled outside (nonce bump).
  useEffect(() => {
    if (draftClearNonce === 0) return;
    setPrompt("");
    saveTaskDraft(threadId, "");
  }, [draftClearNonce, threadId]);

  // Debounced draft persist — avoid sessionStorage writes on every keypress.
  useEffect(() => {
    if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = window.setTimeout(() => {
      saveTaskDraft(threadId, prompt);
      draftTimerRef.current = null;
    }, 300);
    return () => {
      if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current);
    };
  }, [threadId, prompt]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 220 ? "auto" : "hidden";
  }, [prompt]);

  function submit() {
    if (!prompt.trim() || online !== true) return;
    const text = prompt.trim();
    setPrompt("");
    saveTaskDraft(threadId, "");
    onSubmitPrompt(text);
  }

  return (
    <form className="composer" onSubmit={(event) => {
      event.preventDefault();
      submit();
    }}>
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          const sendHotkey = isMac ? event.metaKey : event.ctrlKey;
          if (sendHotkey && event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={online === false ? "主机离线，可先编辑，恢复在线后再发送" : running ? "给当前任务追加方向…" : "继续这个任务…"}
      />
      <div>
        <small>
          <label className="composer-permission">
            模型
            <select
              value={model}
              onChange={(event) => {
                const next = event.target.value.split("[")[0] || event.target.value;
                onModelChange(next);
              }}
              disabled={!modelOptions.length}
            >
              {!modelOptions.length && <option value="">主机未上报模型列表</option>}
              {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          {taskEngine === "cursor" && modelMeta?.supportsFast && (
            <label className="composer-permission composer-fast-toggle">
              Fast
              <input
                type="checkbox"
                checked={fastMode}
                onChange={(event) => onFastModeChange(event.target.checked)}
              />
            </label>
          )}
          <label className="composer-permission">
            {taskEngine === "cursor" ? "Effort" : "推理强度"}
            <select
              value={reasoningEffort}
              onChange={(event) => onReasoningEffortChange(event.target.value as ReasoningEffort)}
              disabled={!effortOptions.length}
              title={taskEngine === "cursor" && !effortOptions.length ? "当前模型不支持 effort" : undefined}
            >
              {!effortOptions.length && <option value="">—</option>}
              {effortOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="composer-permission">
            {currentPermissionLabel}
            <select value={permissionMode} onChange={(event) => onPermissionModeChange(normalizePermissionMode(event.target.value))}>
              {permissionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="composer-reply-detail">
            {agentReplyDetailLabel}
            <select value={replyDetail} onChange={(event) => onReplyDetailChange(normalizeReplyDetail(event.target.value))}>
              <option value="concise">{replyConciseLabel}</option>
              <option value="detailed">{replyDetailedLabel}</option>
            </select>
          </label>
          <span className="send-shortcut">
            {isMac ? <><kbd>⌘</kbd> + <kbd>Enter</kbd></> : <><kbd>Ctrl</kbd> + <kbd>Enter</kbd></>}
            {" "}{sendShortcutLabel}
          </span>
        </small>
        {(running || pendingPrompt) && (
          <button type="button" className="stop" onClick={onStop} disabled={online !== true}>
            {stopLabel}
          </button>
        )}
        {canResend && !running && !pendingPrompt && (
          <button type="button" className="resend" onClick={onResend} disabled={online !== true}>
            {resendLabel}
          </button>
        )}
        <button className="send" disabled={online !== true || !prompt.trim()}>{sendLabel}</button>
      </div>
    </form>
  );
});

/** Drop consecutive identical user bubbles (snapshot + turn.started race / queue drain). */
function dedupeAdjacentUserMessages<T extends { id: string; role: string; text: string }>(messages: T[]): T[] {
  if (messages.length < 2) return messages;
  const out: T[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.text.trim();
      // Skip if the previous message is the same user text, or the last user bubble
      // (process/stage lines may sit between two identical YOU entries after races).
      const prev = out[out.length - 1];
      if (prev?.role === "user" && prev.text.trim() === text) continue;
      // indexOf(object) is reference-based; find last user by scanning instead.
      let lastUserIndex = -1;
      for (let i = out.length - 1; i >= 0; i -= 1) {
        if (out[i]?.role === "user") {
          lastUserIndex = i;
          break;
        }
      }
      if (lastUserIndex >= 0 && out[lastUserIndex]!.text.trim() === text) {
        // Only collapse when nothing but process/system noise sits between the two YOU bubbles.
        const between = out.slice(lastUserIndex + 1);
        const onlyNoise = between.every(
          (item) => item.role === "system" || isProcessStreamMessage(item)
        );
        if (onlyNoise && between.length > 0) continue;
        if (between.length === 0) continue;
      }
    }
    out.push(message);
  }
  return out;
}

/** Remove a waiting-queue item once the agent has actually started that prompt. */
function dropQueuedPrompt(
  queue: QueuedTurnItem[] | undefined,
  prompt: string
): QueuedTurnItem[] {
  if (!queue?.length) return queue ?? [];
  const text = prompt.trim();
  if (!text) return queue;
  const idx = queue.findIndex((item) => item.prompt.trim() === text);
  if (idx < 0) return queue;
  if (idx === 0) return queue.slice(1);
  return [...queue.slice(0, idx), ...queue.slice(idx + 1)];
}

/**
 * When the conversation was unmounted, localStorage / a missed empty queue event can leave
 * ghost waiting items that already appear as YOU bubbles. Drop FIFO heads that match the latest
 * YOU; if idle and every remaining item already appears in the transcript, clear the whole list.
 */
function pruneStaleQueueAgainstMessages(
  queue: QueuedTurnItem[],
  messages: Array<{ role: string; text: string }>,
  options?: { idle?: boolean }
): QueuedTurnItem[] {
  if (!queue.length) return queue;
  const userTexts = messages
    .filter((message) => message.role === "user")
    .map((message) => message.text.trim())
    .filter(Boolean);
  if (!userTexts.length) return queue;
  let next = [...queue];
  // Drop FIFO heads that already landed as the latest YOU (started while we were away).
  const lastUser = userTexts[userTexts.length - 1]!;
  while (next.length && next[0]!.prompt.trim() === lastUser) {
    next = next.slice(1);
  }
  // Idle + every waiting prompt already exists as a YOU bubble ⇒ ghosts from a finished run
  // (missed turn.queue.updated while unmounted). Keep queues that still have brand-new prompts.
  if (options?.idle && next.length && next.every((item) => userTexts.includes(item.prompt.trim()))) {
    return [];
  }
  return next;
}

function reduceEvent(runtime: HostRuntime, event: AgentEvent): HostRuntime {
  const next = structuredClone(runtime);
  if (event.type === "host.status") {
    next.online = event.online;
    next.workspaces = event.workspaces;
    if (event.availableEngines) next.availableEngines = event.availableEngines;
    if (event.engineCapabilities) next.engineCapabilities = event.engineCapabilities;
    if (event.agentVersion) next.agentVersion = event.agentVersion;
    if (event.engineQuotas?.length) {
      next.engineQuotas = event.engineQuotas;
      next.quotaLoading = false;
    }
    return next;
  }
  if (event.type === "host.quota") {
    next.engineQuotas = event.engineQuotas;
    if (event.detail) next.quotaDetail = event.detail;
    else delete next.quotaDetail;
    next.quotaLoading = false;
    return next;
  }
  if (event.type === "thread.deleted") {
    delete next.tasks[event.threadId];
    return next;
  }
  if (event.type === "turn.queue.updated") {
    const task = next.tasks[event.threadId];
    if (task) {
      task.queuedTurns = event.items.map((item) => ({
        commandId: item.commandId,
        prompt: item.prompt
      }));
      task.updatedAt = Date.now() / 1000;
    }
    return next;
  }
  if (event.type === "sync.completed" || event.type === "sync.progress") return next;
  if (event.type === "thread.snapshot") {
    // Never resurrect a task the user already deleted in this session if event races.
    // (Agent also tombstones; this is a local guard.)
    const existing = next.tasks[event.threadId];
    const engine = event.cliEngine ?? existing?.cliEngine;
    const model = event.model ?? existing?.model;
    const reasoningEffort = event.reasoningEffort ?? existing?.reasoningEffort;
    const contextUsage = event.contextUsage ?? existing?.contextUsage;
    const providerSessionId = event.providerSessionId ?? existing?.providerSessionId;
    // Never let a stale snapshot push a recently active task down the list.
    const updatedAt = Math.max(
      Number(event.updatedAt) || 0,
      existing?.updatedAt ?? 0
    );
    // Prefer failed/interrupted over a later import that marked the same session "completed".
    const incomingStatus = String(event.status || "");
    const existingStatus = String(existing?.status || "");
    const preferExistingStatus = existing
      && /failed|error|interrupt|stop|cancel/i.test(existingStatus)
      && /completed|idle|unknown/i.test(incomingStatus);
    const status = preferExistingStatus ? existingStatus : (incomingStatus || existingStatus || "unknown");
    const terminalStatus = isFailedTaskStatus(status)
      || /^(completed|complete|success|succeeded|idle)$/i.test(status);
    // Snapshots from agent often omit activeTurnId; do not clear a live turn mid-run
    // (cleared activeTurnId also breaks queue UI cleanup and looks like a double YOU bubble).
    const activeTurnId = terminalStatus
      ? undefined
      : (event.activeTurnId || existing?.activeTurnId);
    const rawMessages = event.messages?.length ? event.messages : (existing?.messages ?? []);
    // Prefer the more specific absolute cwd (task subdir over bare workspace root when both known).
    const nextCwd = (() => {
      const incoming = String(event.cwd || "").trim();
      const prev = String(existing?.cwd || "").trim();
      if (incoming && prev) {
        const a = incoming.replace(/[\\/]+$/, "").toLowerCase();
        const b = prev.replace(/[\\/]+$/, "").toLowerCase();
        if (a.startsWith(b + "\\") || a.startsWith(b + "/") || b.startsWith(a + "\\") || b.startsWith(a + "/")) {
          return incoming.length >= prev.length ? incoming : prev;
        }
      }
      return incoming || prev || "";
    })();
    next.tasks[event.threadId] = {
      threadId: event.threadId,
      title: event.title || existing?.title || "未命名任务",
      cwd: nextCwd,
      status,
      updatedAt: updatedAt || Date.now() / 1000,
      // Prefer snapshot-persisted diff (survives reconnect); keep existing if absent.
      diff: ("diff" in event && typeof event.diff === "string" && event.diff)
        ? event.diff
        : (existing?.diff ?? ""),
      messages: dedupeAdjacentUserMessages(rawMessages),
      approvals: existing?.approvals ?? [],
      ...(engine ? { cliEngine: engine } : {}),
      ...(activeTurnId ? { activeTurnId } : {}),
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      // Preserve agent queue state — snapshots do not carry it and must not wipe it.
      // Use !== undefined so an empty [] (queue finished) is kept and not treated as "missing".
      ...(existing?.queuedTurns !== undefined ? { queuedTurns: existing.queuedTurns } : {})
    };
    // Collapse Claude/Grok import clones: same engine + native session id → keep one task.
    if (engine && engine !== "codex" && providerSessionId) {
      for (const [id, task] of Object.entries(next.tasks)) {
        if (id === event.threadId) continue;
        if (task.cliEngine !== engine) continue;
        const sameNative = task.providerSessionId === providerSessionId
          || task.threadId === providerSessionId
          || (providerSessionId && event.threadId === task.providerSessionId);
        if (!sameNative) continue;
        // Prefer AnytimeVibe UUID task (threadId !== providerSessionId) over native-keyed import.
        const keepIncoming = event.threadId !== providerSessionId || task.threadId === providerSessionId;
        if (keepIncoming) {
          // Merge useful fields from the clone before drop.
          const kept = next.tasks[event.threadId]!;
          if (/failed|error|interrupt|stop|cancel/i.test(task.status) && /completed|idle|unknown/i.test(kept.status)) {
            kept.status = task.status;
          }
          kept.updatedAt = Math.max(kept.updatedAt, task.updatedAt);
          if (!kept.messages.length && task.messages.length) kept.messages = task.messages;
          delete next.tasks[id];
        } else {
          const kept = task;
          if (/failed|error|interrupt|stop|cancel/i.test(status) && /completed|idle|unknown/i.test(kept.status)) {
            kept.status = status;
          }
          kept.updatedAt = Math.max(kept.updatedAt, updatedAt);
          if (providerSessionId) kept.providerSessionId = providerSessionId;
          delete next.tasks[event.threadId];
        }
      }
    }
    return next;
  }
  if (event.type === "error") {
    if (event.threadId && next.tasks[event.threadId]) {
      const task = next.tasks[event.threadId]!;
      if (!isFailedTaskStatus(task.status)) task.status = "failed";
      delete task.activeTurnId;
      if (event.message) {
        const text = event.message.trim();
        const already = task.messages.some(
          (message) => message.role === "system" && message.text.trim() === text
        );
        if (text && !already) {
          task.messages.push({
            id: event.eventId,
            role: "system",
            text
          });
        }
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
    // Snapshot / prior turn.started may already include the user turn. Avoid duplicate YOU bubbles
    // (especially when a durable-queued follow-up starts right after the previous turn).
    // Headless path often omits prompt when the user message was already snapshotted — still drop
    // the matching waiting-queue item using the last YOU bubble.
    const promptFromEvent = event.prompt?.trim() || "";
    if (promptFromEvent) {
      const already = task.messages.some(
        (item: Task["messages"][number]) => item.role === "user" && item.text.trim() === promptFromEvent
      );
      if (!already) {
        task.messages.push({ id: event.eventId, role: "user", text: promptFromEvent });
      }
    }
    const lastUserText = [...task.messages]
      .reverse()
      .find((item: Task["messages"][number]) => item.role === "user")
      ?.text
      ?.trim() || "";
    const queuePrompt = promptFromEvent || lastUserText;
    if (queuePrompt && task.queuedTurns !== undefined) {
      task.queuedTurns = dropQueuedPrompt(task.queuedTurns, queuePrompt);
    }
    task.messages = dedupeAdjacentUserMessages(task.messages);
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
    // Finished turns should not linger in the waiting list (missed turn.queue.updated / headless
    // turn.started without prompt while the conversation was unmounted).
    const lastUserText = [...task.messages]
      .reverse()
      .find((item: Task["messages"][number]) => item.role === "user")
      ?.text
      ?.trim() || "";
    if (lastUserText && task.queuedTurns?.length) {
      task.queuedTurns = dropQueuedPrompt(task.queuedTurns, lastUserText);
    }
    // Materialize empty queue after completion so remount does not resurrect localStorage ghosts.
    if (!task.queuedTurns?.length) {
      task.queuedTurns = [];
    }
    if (event.contextUsage) task.contextUsage = event.contextUsage;
    const errText = event.errorMessage?.trim();
    if (errText) {
      const already = task.messages.some(
        (message) => message.role === "system" && message.text.includes(errText)
      );
      if (!already) {
        task.messages.push({
          id: event.eventId,
          role: "system",
          text: errText.startsWith("错误") || errText.startsWith("任务失败") ? errText : `错误：${errText}`
        });
      }
    } else if (isFailedTaskStatus(event.status)) {
      const hasSystem = task.messages.some((message) => message.role === "system" && message.text.trim());
      if (!hasSystem) {
        task.messages.push({
          id: event.eventId,
          role: "system",
          text: `任务失败（${event.status}）。请查看下方错误说明，或在电脑端客户端「任务 → 接力」查看 CLI 输出。`
        });
      }
    }
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
  { engine: "grok", vendor: "xAI", product: "Grok Build" },
  { engine: "cursor", vendor: "Cursor", product: "Cursor Agent" }
];

function FeaturedEngines() {
  return <section className="featured-engines" aria-label="支持的 AI 编程引擎">
    <div className="featured-engines-head">
      <span>主流模型厂商</span>
      <strong>四款均已支持 · 一台主机自由选择</strong>
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
      <h1><span>随时随地，</span><span>灵感不断。</span></h1>
      <p>随时从手机发起或继续电脑上的 AI 编程任务。Codex、Claude Code、Grok Build 与 Cursor Agent 在你的 Windows 或 macOS 主机上运行；云端仅转发加密消息，源码、凭据与工作区始终留在本机。</p>
      <FeaturedEngines />
      <div className="signal-line"><span />端到端加密 · 本机执行</div>
      <ClientDownloads downloads={health.clientDownloads} />
    </section>
    <form className="auth-card" onSubmit={submit}>
      <div className="mark" aria-hidden="true"><img src="/icon.svg" alt="" /></div>
      <h2>{health.needsSetup ? "初始化服务" : registering ? "创建个人空间" : "进入随码"}</h2>
      <p>{health.needsSetup ? "创建首个管理员账号，开启你的随码服务。" : registering ? "注册后即可配对自己的电脑，数据与其他用户隔离。" : "登录后随时接住本机 AI 编程任务。"}</p>
      {health.needsSetup && <label>设置令牌<input value={setupToken} onChange={(event) => setSetupToken(event.target.value)} required /></label>}
      <label>
        用户名 / 邮箱
        <input
          autoComplete="username"
          inputMode="email"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
          placeholder={registering || health.needsSetup ? "用户名或邮箱" : undefined}
        />
      </label>
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
  const [pushStatus, setPushStatus] = useState<"idle" | "syncing" | "enabled">("idle");
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
  /** After task.create, auto-select the first new threadId not in this set. */
  const pendingNewTaskRef = useRef<{
    hostId: string;
    knownIds: Set<string>;
    expiresAt: number;
    model?: string;
    reasoningEffort?: ReasoningEffort;
  } | null>(null);
  /** In-page only: refresh shows the tip again if the client is still outdated. */
  const [clientUpdateDismissed, setClientUpdateDismissed] = useState(false);
  useEffect(() => {
    // Drop legacy session dismiss so "稍后" from older builds cannot hide tips forever.
    try { sessionStorage.removeItem("client-update-dismissed"); } catch { /* ignore */ }
  }, []);
  function selectTask(threadId: string) {
    setSelectedTaskId(threadId);
    setMobilePane("conversation");
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function markExpectingNewTask(
    hostId: string,
    knownIds: Iterable<string>,
    prefs?: { model?: string; reasoningEffort?: ReasoningEffort }
  ) {
    pendingNewTaskRef.current = {
      hostId,
      knownIds: new Set(knownIds),
      expiresAt: Date.now() + 90_000,
      ...(prefs?.model ? { model: prefs.model } : {}),
      ...(prefs?.reasoningEffort ? { reasoningEffort: prefs.reasoningEffort } : {})
    };
  }

  function maybeSelectNewTask(hostId: string, threadId: string | undefined) {
    if (!threadId) return;
    const pending = pendingNewTaskRef.current;
    if (!pending || pending.hostId !== hostId) return;
    if (Date.now() > pending.expiresAt) {
      pendingNewTaskRef.current = null;
      return;
    }
    if (pending.knownIds.has(threadId)) return;
    pendingNewTaskRef.current = null;
    // Bind create-dialog model/effort before conversation mounts (snapshot may lag).
    if (pending.model || pending.reasoningEffort) {
      saveTaskUiPrefs(threadId, {
        ...(pending.model ? { model: pending.model } : {}),
        ...(pending.reasoningEffort ? { reasoningEffort: pending.reasoningEffort } : {})
      });
    }
    selectTask(threadId);
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

  useEffect(() => {
    if (!user || !health?.vapidPublicKey) {
      setPushStatus("idle");
      return;
    }
    let active = true;
    syncPushSubscription(health.vapidPublicKey).then((status) => {
      if (active) setPushStatus(status === "enabled" ? "enabled" : "idle");
    }).catch(() => {
      if (active) setPushStatus("idle");
    });
    return () => { active = false; };
  }, [user, health?.vapidPublicKey]);

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
      // Auto-open the task just created via the new-task dialog.
      if ("threadId" in event && typeof event.threadId === "string") {
        maybeSelectNewTask(envelope.hostId, event.threadId);
      }
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
            const agentVersion = typeof parsed.agentVersion === "string" ? parsed.agentVersion.trim().replace(/^v/i, "") : "";
            setHosts((current) => current.map((host) => host.id !== hostId ? host : {
              ...host,
              ...(typeof parsed.name === "string" && parsed.name.trim() ? { name: parsed.name.trim() } : {}),
              ...(typeof parsed.codexVersion === "string" && parsed.codexVersion.trim() ? { codexVersion: parsed.codexVersion.trim() } : {}),
              ...(typeof parsed.platform === "string" && parsed.platform.trim() ? { platform: parsed.platform.trim() } : {})
            }));
            // agent.meta arrives unencrypted and often sooner/more often than host.status —
            // update runtime.agentVersion immediately so update banners clear after client upgrade.
            if (agentVersion) {
              setRuntime((current) => {
                const prev = current[hostId] ?? emptyRuntime(true);
                if (prev.agentVersion === agentVersion) return current;
                return {
                  ...current,
                  [hostId]: { ...prev, agentVersion, online: prev.online ?? true }
                };
              });
            }
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

  async function enablePush(): Promise<void> {
    if (!health?.vapidPublicKey || pushStatus !== "idle") return;
    setPushStatus("syncing");
    try {
      const status = await syncPushSubscription(health.vapidPublicKey, { requestPermission: true });
      if (status !== "enabled") throw new Error("通知订阅未能启用。");
      const delivery = await api<{ delivered: number }>("/api/push/test", { method: "POST" });
      if (delivery.delivered < 1) throw new Error("通知订阅已保存，但测试消息未能发送，请稍后重试。");
      setPushStatus("enabled");
    } catch (pushError) {
      setPushStatus("idle");
      throw pushError;
    }
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
        // Per-engine recent window (Codex / Claude / Grok each); keep low to limit bandwidth.
        limit: options.limit ?? 10,
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
    ?? (selectedTaskId ? null : filteredTasks[0])
    ?? null;

  const clientVersion = activeRuntime.agentVersion;
  const latestClientVersion = health.latestClientVersion?.replace(/^v/i, "") || null;
  // Soft update only: compare connected client to latest published release (not web PRODUCT_VERSION).
  const clientOutdated = Boolean(
    activeHost
    && activeRuntime.online === true
    && clientVersion
    && latestClientVersion
    && compareSemver(clientVersion, latestClientVersion) < 0
  );
  const clientVersionUnknown = Boolean(
    activeHost
    && activeRuntime.online === true
    && !clientVersion
  );
  const versionWarn = clientOutdated || clientVersionUnknown;
  const versionTitle = clientOutdated
    ? (locale === "en"
      ? `Desktop client v${clientVersion} is behind latest v${latestClientVersion}. Update for best compatibility.`
      : `客户端 v${clientVersion} 低于线上最新 v${latestClientVersion}，建议尽快更新以确保功能正常。`)
    : clientVersionUnknown
      ? (locale === "en"
        ? `Client did not report a version. Latest release is v${latestClientVersion ?? "—"}.`
        : `客户端未上报版本。线上最新客户端为 v${latestClientVersion ?? "—"}。`)
      : (locale === "en"
        ? `Web v${PRODUCT_VERSION}${clientVersion ? ` · Client v${clientVersion}` : ""}${latestClientVersion ? ` · Latest client v${latestClientVersion}` : ""}`
        : `网页 v${PRODUCT_VERSION}${clientVersion ? ` · 客户端 v${clientVersion}` : ""}${latestClientVersion ? ` · 最新客户端 v${latestClientVersion}` : ""}`);
  const showClientUpdateBanner = versionWarn && !clientUpdateDismissed;

  return <div className="app-shell">
    {error && <ErrorBanner message={error} clear={() => setError("")} />}
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><img src="/icon.svg" alt="" /></span><div><strong>{t("brand")}</strong><small>{t("brandTag")}</small></div></div>
      <div className="top-actions">
        <span
          className={`version-chip${versionWarn ? " warn" : ""}`}
          title={versionTitle}
        >
          <span className="version-chip-line">Web v{PRODUCT_VERSION}</span>
          <span className="version-chip-line">
            {activeHost
              ? `${locale === "en" ? "Client" : "客户端"} ${clientVersion ? `v${clientVersion}` : (locale === "en" ? "unknown" : "未知")}${clientOutdated ? (locale === "en" ? " · update" : " · 需更新") : clientVersionUnknown ? (locale === "en" ? " · ?" : " · 未知") : ""}`
              : latestClientVersion
                ? `${locale === "en" ? "Client" : "客户端"} ${locale === "en" ? "latest" : "最新"} v${latestClientVersion}`
                : `${locale === "en" ? "Client" : "客户端"} —`}
          </span>
        </span>
        <ClientDownloads downloads={health.clientDownloads} />
        <div className="lang-switch" role="group" aria-label={t("lang")}>
          <button type="button" className={locale === "zh-CN" ? "active" : ""} onClick={() => setLocale("zh-CN")}>中文</button>
          <button type="button" className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>EN</button>
        </div>
        <button
          className={`quiet push-toggle${pushStatus === "enabled" ? " enabled" : ""}`}
          disabled={pushStatus !== "idle"}
          onClick={() => enablePush().catch((pushError) => setError(pushError.message))}
        >{pushStatus === "syncing" ? t("notifyEnabling") : pushStatus === "enabled" ? t("notifyEnabled") : t("notify")}</button>
        <div className="account-menu">
          <button className="avatar" title={user.username} aria-expanded={accountOpen} onClick={() => setAccountOpen((open) => !open)}>{user.username.slice(0, 1).toUpperCase()}</button>
          {accountOpen && <div className="account-popover">
            <div><strong>{user.username}</strong><small>{user.isAdmin ? t("administrator") : t("personalSpace")}</small></div>
            {user.isAdmin && <a className="account-link" href="/admin">{t("admin")}</a>}
            <button
              className={`account-push${pushStatus === "enabled" ? " enabled" : ""}`}
              disabled={pushStatus !== "idle"}
              onClick={() => enablePush().catch((pushError) => setError(pushError.message))}
            >{pushStatus === "syncing" ? t("notifyEnabling") : pushStatus === "enabled" ? t("notifyEnabled") : t("notify")}</button>
            <button onClick={() => logout().catch((logoutError) => setError(logoutError.message))}>{t("logout")}</button>
          </div>}
        </div>
      </div>
    </header>

    {showClientUpdateBanner && (
      <div className="client-update-banner" role="status">
        <div className="client-update-banner-copy">
          <strong>{locale === "en" ? "Client update available" : "客户端有新版本"}</strong>
          <span>
            {clientOutdated
              ? (locale === "en"
                ? `Connected client v${clientVersion} is behind latest v${latestClientVersion}. Please update when convenient.`
                : `当前客户端 v${clientVersion}，线上最新 v${latestClientVersion}，建议及时更新以确保功能正常。`)
              : (locale === "en"
                ? `Latest client is v${latestClientVersion ?? "—"}. This host did not report a version.`
                : `线上最新客户端 v${latestClientVersion ?? "—"}。当前主机未上报版本，请确认客户端已更新。`)}
          </span>
        </div>
        <button
          type="button"
          className="client-update-banner-close"
          aria-label={locale === "en" ? "Dismiss" : "关闭"}
          title={locale === "en" ? "Dismiss" : "关闭"}
          onClick={() => setClientUpdateDismissed(true)}
        >
          ×
        </button>
      </div>
    )}

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
        <div className="task-column-head">
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
            {(["codex", "claude", "grok", "cursor"] as CliEngine[]).map((engine) => {
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
                  <EngineLogo engine={engine} size={18} />
                  <span className="engine-filter-count">{count}</span>
                </button>
              );
            })}
            {engineFilter && (
              <button type="button" className="engine-filter-clear" onClick={() => setEngineFilter(null)}>{t("filterAll")}</button>
            )}
          </div>
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
          {filteredTasks.map((task) => (
            <TaskListRow
              key={task.threadId}
              task={task}
              active={activeTask?.threadId === task.threadId}
              online={activeRuntime.online}
              onSelect={() => selectTask(task.threadId)}
              onDelete={() => {
                if (!activeHost) return;
                const ok = window.confirm(t("deleteTaskConfirm"));
                if (!ok) return;
                // Optimistic local remove
                setRuntime((current) => {
                  const hostId = activeHost.id;
                  const prev = current[hostId] ?? emptyRuntime();
                  const nextTasks = { ...prev.tasks };
                  delete nextTasks[task.threadId];
                  return { ...current, [hostId]: { ...prev, tasks: nextTasks } };
                });
                if (selectedTaskId === task.threadId) {
                  setSelectedTaskId(null);
                  setMobilePane("tasks");
                }
                try { localStorage.removeItem(`command-queue:${task.threadId}`); } catch { /* ignore */ }
                try { localStorage.removeItem(taskPrefsKey(task.threadId)); } catch { /* ignore */ }
                if (activeRuntime.online === true) {
                  void sendCommand(activeHost.id, {
                    type: "thread.delete",
                    commandId: crypto.randomUUID(),
                    threadId: task.threadId
                  }).catch((err) => setError(err.message));
                }
              }}
            />
          ))}
          {!tasks.length && <div className="empty-state"><span>&gt;_</span><h3>{t("noTasks")}</h3><p>{t("noTasksHint")}</p></div>}
          {Boolean(tasks.length && !filteredTasks.length) && <div className="empty-state"><span>?</span><h3>{t("noMatch")}</h3><p>{t("noMatchHint")}</p></div>}
        </div>
      </section>

      <section className="conversation-column">
        {activeTask ? <TaskConversation key={activeTask.threadId} task={activeTask} online={activeRuntime.online} visible={mobilePane === "conversation"} permissionMode={permissionMode} replyDetail={replyDetail} engineCapabilities={activeRuntime.engineCapabilities ?? []} engineQuotas={QUOTA_QUERY_ENABLED ? (activeRuntime.engineQuotas ?? []) : []} {...(QUOTA_QUERY_ENABLED && activeRuntime.quotaDetail ? { quotaDetail: activeRuntime.quotaDetail } : {})} quotaLoading={QUOTA_QUERY_ENABLED && Boolean(activeRuntime.quotaLoading)} onPermissionModeChange={(mode) => { const next = normalizePermissionMode(mode); setPermissionMode(next); localStorage.setItem("permission-mode", next); }} onReplyDetailChange={(detail) => { const next = normalizeReplyDetail(detail); setReplyDetail(next); localStorage.setItem(REPLY_DETAIL_STORAGE_KEY, next); }} onBack={() => { setMobilePane("tasks"); window.scrollTo({ top: 0, behavior: "instant" }); }} onCommand={(command) => sendCommand(activeHost!.id, command).catch((sendError) => setError(sendError.message))} onQuotaRefresh={QUOTA_QUERY_ENABLED ? () => {
          setRuntime((current) => {
            const hostId = activeHost!.id;
            const prev = current[hostId] ?? emptyRuntime(true);
            return { ...current, [hostId]: { ...prev, quotaLoading: true } };
          });
          return sendCommand(activeHost!.id, {
            type: "host.quota.refresh",
            commandId: crypto.randomUUID(),
            cliEngine: normalizeCliEngine(activeTask.cliEngine)
          }).catch((sendError) => {
            setError(sendError.message);
            setRuntime((current) => {
              const hostId = activeHost!.id;
              const prev = current[hostId] ?? emptyRuntime();
              return { ...current, [hostId]: { ...prev, quotaLoading: false } };
            });
          });
        } : () => undefined} /> : <div className="conversation-empty"><div className="orbit" /><h2>{t("pickTask")}</h2><p>{t("pickTaskHint")}</p></div>}
      </section>
    </main>

    {pairingOpen && <PairingDialog onClose={() => setPairingOpen(false)} onPaired={async () => { setPairingOpen(false); await loadHosts(); }} />}
    {composerOpen && activeHost && <NewTaskDialog
      host={activeHost}
      workspaces={activeRuntime.workspaces}
      online={activeRuntime.online}
      availableEngines={activeRuntime.availableEngines ?? []}
      engineCapabilities={activeRuntime.engineCapabilities ?? []}
      onClose={() => setComposerOpen(false)}
      onRefreshWorkspaces={() => sendCommand(activeHost.id, { type: "host.refresh", commandId: crypto.randomUUID() })}
      onCreate={async (cwd, prompt, title, engine, mode, model, reasoningEffort) => {
        setPermissionMode(mode);
        localStorage.setItem("permission-mode", mode);
        // Remember existing threads so the first new threadId from the host is selected.
        markExpectingNewTask(activeHost.id, Object.keys(activeRuntime.tasks), {
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {})
        });
        // Clear engine filter so the new task is visible in the list immediately.
        setEngineFilter(null);
        setMobilePane("conversation");
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

/** Task row with desktop hover-delete + mobile swipe-to-delete. */
function TaskListRow({
  task,
  active,
  onSelect,
  onDelete
}: {
  task: Task;
  active: boolean;
  online: boolean | null;
  onSelect(): void;
  onDelete(): void;
}) {
  const { t } = useI18n();
  const status = taskStatusMeta(task.status);
  const engine = task.cliEngine ? normalizeCliEngine(task.cliEngine) : undefined;
  const updated = new Date(task.updatedAt * 1000);
  const timeLabel = Number.isFinite(updated.getTime())
    ? updated.toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      })
    : "";
  const preview = (task.messages.at(-1)?.text || task.cwd || "").replace(/\s+/g, " ").trim();
  const [swipeX, setSwipeX] = useState(0);
  const startX = useRef<number | null>(null);
  const swiping = useRef(false);
  const DELETE_REVEAL = 72;

  function onTouchStart(event: ReactTouchEvent) {
    startX.current = event.touches[0]?.clientX ?? null;
    swiping.current = false;
  }
  function onTouchMove(event: ReactTouchEvent) {
    if (startX.current == null) return;
    const x = event.touches[0]?.clientX ?? startX.current;
    const delta = x - startX.current;
    if (delta < -8) swiping.current = true;
    // Only left swipe reveals delete
    setSwipeX(Math.max(-DELETE_REVEAL, Math.min(0, delta)));
  }
  function onTouchEnd() {
    startX.current = null;
    setSwipeX((current) => (current < -DELETE_REVEAL / 2 ? -DELETE_REVEAL : 0));
  }

  return (
    <div className={`task-row ${active ? "active" : ""} ${swipeX < 0 ? "swiping" : ""}`}>
      <button
        type="button"
        className="task-row-delete"
        aria-label={t("deleteTask")}
        title={t("deleteTask")}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
          setSwipeX(0);
        }}
      >
        {t("deleteTask")}
      </button>
      <div
        role="button"
        tabIndex={0}
        className={`task-card ${active ? "active" : ""}`}
        style={{ transform: `translateX(${swipeX}px)` }}
        onClick={() => {
          if (swiping.current || swipeX < -8) {
            setSwipeX(0);
            return;
          }
          onSelect();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <div className="task-meta">
          <span className="task-meta-left">
            {engine && <EngineLogo engine={engine} size={14} className="task-engine-logo" />}
            <span className={`task-status ${status.tone}`}>{status.label}</span>
          </span>
          <span className="task-meta-right">
            {timeLabel && <time dateTime={updated.toISOString()}>{timeLabel}</time>}
            <button
              type="button"
              className="task-delete-desktop"
              title={t("deleteTask")}
              aria-label={t("deleteTask")}
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              ×
            </button>
          </span>
        </div>
        <h3 title={task.title}>{task.title}</h3>
        <p title={preview}>{preview}</p>
        <div className="task-foot">
          <code className="task-cwd" title={formatTaskCwd(task.cwd)} dir="ltr">{formatTaskCwd(task.cwd)}</code>
          {task.approvals.length > 0 && <b>{task.approvals.length}</b>}
        </div>
      </div>
    </div>
  );
}

function formatEngineQuotaChip(quota: EngineQuota): string {
  if (quota.amountRemaining != null) {
    const cur = quota.currency || "";
    const amount = Number.isFinite(quota.amountRemaining)
      ? (Math.abs(quota.amountRemaining) >= 100
        ? String(Math.round(quota.amountRemaining))
        : quota.amountRemaining.toFixed(2).replace(/\.?0+$/, ""))
      : "—";
    const limitPart = quota.amountLimit != null
      ? `/${Math.abs(quota.amountLimit) >= 100 ? Math.round(quota.amountLimit) : quota.amountLimit.toFixed(2).replace(/\.?0+$/, "")}`
      : "";
    if (cur === "USD" || cur === "$" || !cur) return `$${amount}${limitPart}`;
    if (cur === "CNY" || cur === "¥") return `¥${amount}${limitPart}`;
    if (cur === "EUR" || cur === "€") return `€${amount}${limitPart}`;
    return `${amount}${limitPart} ${cur}`;
  }
  if (quota.remainingPercent != null) return `余 ${Math.round(quota.remainingPercent)}%`;
  if (quota.usedPercent != null) return `余 ${Math.max(0, 100 - Math.round(quota.usedPercent))}%`;
  if (quota.remaining != null && quota.limit != null) {
    return `${compactTokenCount(quota.remaining)}/${compactTokenCount(quota.limit)}`;
  }
  if (quota.remaining != null) return compactTokenCount(quota.remaining);
  // Fall back to first non-empty detail line so users always see CLI output
  const line = (quota.detail || "").split(/\n/).map((item) => item.trim()).find(Boolean);
  return line ? (line.length > 28 ? `${line.slice(0, 26)}…` : line) : "—";
}

function TaskConversation({
  task,
  online,
  visible,
  permissionMode,
  replyDetail,
  engineCapabilities,
  engineQuotas,
  quotaDetail,
  quotaLoading,
  onPermissionModeChange,
  onReplyDetailChange,
  onBack,
  onCommand,
  onQuotaRefresh
}: {
  task: Task;
  online: boolean | null;
  visible: boolean;
  permissionMode: PermissionMode;
  replyDetail: ReplyDetail;
  engineCapabilities: EngineCapability[];
  engineQuotas: EngineQuota[];
  quotaDetail?: string;
  quotaLoading: boolean;
  onPermissionModeChange(mode: PermissionMode): void;
  onReplyDetailChange(detail: ReplyDetail): void;
  onBack(): void;
  onCommand(command: ClientCommand): void;
  onQuotaRefresh(): void;
}) {
  const { t, locale } = useI18n();
  const [pendingPrompt, setPendingPrompt] = useState("");
  const [draftClearNonce, setDraftClearNonce] = useState(0);
  const submittingRef = useRef(false);
  const [commandQueue, setCommandQueue] = useState<QueuedTurnItem[]>(() => {
    // Agent-reported queue wins (including explicit []). Avoid restoring stale localStorage
    // when the task is idle — the queue often finished while this conversation was unmounted.
    const fromAgent = task.queuedTurns !== undefined
      ? task.queuedTurns
        .map((item) => ({ commandId: item.commandId, prompt: item.prompt }))
        .filter((item) => item.prompt.trim())
      : null;
    let restored: QueuedTurnItem[] = fromAgent ?? [];
    if (fromAgent === null) {
      if (!task.activeTurnId) {
        restored = [];
      } else {
        try {
          const raw = JSON.parse(localStorage.getItem(`command-queue:${task.threadId}`) ?? "[]") as unknown;
          if (Array.isArray(raw)) {
            restored = raw.map((item) => {
              if (typeof item === "string") {
                return { commandId: crypto.randomUUID(), prompt: item };
              }
              const row = item as Partial<QueuedTurnItem>;
              return {
                commandId: String(row.commandId || crypto.randomUUID()),
                prompt: String(row.prompt || "")
              };
            }).filter((item) => item.prompt.trim());
          }
        } catch {
          restored = [];
        }
      }
    }
    return pruneStaleQueueAgainstMessages(restored, task.messages, {
      idle: !task.activeTurnId
    });
  });
  const [tab, setTab] = useState<"chat" | "diff">("chat");
  const taskEngine = normalizeCliEngine(task.cliEngine);
  const cap = capabilityForEngine(engineCapabilities, taskEngine);
  // Avoid localStorage prefs reads on every parent re-render (streaming deltas).
  const uiPrefs = useMemo(() => loadTaskUiPrefs(task.threadId), [task.threadId]);
  const modelOptions = useMemo(
    () => modelOptionsFromHost(
      engineCapabilities,
      taskEngine,
      task.model || uiPrefs.model || cap?.currentModel
    ),
    [engineCapabilities, taskEngine, task.model, uiPrefs.model, cap?.currentModel]
  );
  const [model, setModel] = useState(
    () => {
      const raw = task.model || uiPrefs.model || cap?.currentModel || modelOptions[0]?.id || "";
      return raw.split("[")[0] || raw;
    }
  );
  const modelMeta = useMemo(
    () => modelOptionMeta(engineCapabilities, taskEngine, model),
    [engineCapabilities, taskEngine, model]
  );
  const effortOptions = useMemo(
    () => effortOptionsFromHost(
      engineCapabilities,
      taskEngine,
      task.reasoningEffort || uiPrefs.reasoningEffort || cap?.currentReasoningEffort,
      model
    ),
    [engineCapabilities, taskEngine, task.reasoningEffort, uiPrefs.reasoningEffort, cap?.currentReasoningEffort, model]
  );
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(
    () => task.reasoningEffort || uiPrefs.reasoningEffort || cap?.currentReasoningEffort || effortOptions[0] || ""
  );
  const [fastMode, setFastMode] = useState<boolean>(() => {
    const fromModel = parseFastFromModelId(task.model || uiPrefs.model);
    if (fromModel !== undefined) return fromModel;
    if (uiPrefs.fast !== undefined) return uiPrefs.fast;
    // Composer defaults to Fast on Cursor CLI; other models default off.
    const base = (task.model || uiPrefs.model || cap?.currentModel || "").split("[")[0] || "";
    return /composer/i.test(base);
  });
  const messageStreamRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const previousThreadRef = useRef(task.threadId);
  const running = Boolean(task.activeTurnId);
  const permissionOptions = useMemo(
    () => permissionOptionsForEngine(taskEngine, locale),
    [taskEngine, locale]
  );
  const contextView = useMemo(
    () => parseContextUsageView(task.contextUsage),
    [task.contextUsage]
  );
  const taskQuota = useMemo(
    () => engineQuotas.find((item) => item.engine === taskEngine),
    [engineQuotas, taskEngine]
  );
  const isMac = isMacPlatform();
  // Cheap scroll metrics without re-filtering the full transcript on every parent render path.
  const lastMessageLength = task.messages.at(-1)?.text.length ?? 0;
  const messageCount = task.messages.length;
  // Hide optimistic send bubble once the same text is already in the transcript (avoids double YOU).
  const pendingAlreadyCommitted = Boolean(
    pendingPrompt
    && task.messages.some(
      (message) => message.role === "user" && message.text.trim() === pendingPrompt.trim()
    )
  );
  const showPendingBubble = Boolean(pendingPrompt && !pendingAlreadyCommitted);

  useEffect(() => {
    if (!permissionOptions.some((item) => item.value === permissionMode)) {
      onPermissionModeChange(permissionOptions[0]?.value ?? "ask-for-approval");
    }
  }, [task.threadId, taskEngine]);

  // Prefer task snapshot, then local prefs. Do not clobber user/task high effort with host default low.
  useEffect(() => {
    const prefs = loadTaskUiPrefs(task.threadId);
    if (task.model) {
      const base = task.model.split("[")[0] || task.model;
      setModel(base);
      saveTaskUiPrefs(task.threadId, { model: base });
      const parsedFast = parseFastFromModelId(task.model);
      if (parsedFast !== undefined) setFastMode(parsedFast);
    } else if (prefs.model) {
      setModel(prefs.model.split("[")[0] || prefs.model);
      if (prefs.fast !== undefined) setFastMode(prefs.fast);
    } else {
      setModel((current) => current || cap?.currentModel || modelOptions[0]?.id || "");
    }

    if (task.reasoningEffort) {
      setReasoningEffort(task.reasoningEffort);
      saveTaskUiPrefs(task.threadId, { reasoningEffort: task.reasoningEffort });
    } else if (prefs.reasoningEffort) {
      setReasoningEffort(prefs.reasoningEffort);
    } else {
      setReasoningEffort((current) =>
        current || cap?.currentReasoningEffort || effortOptions[0] || ""
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.threadId, task.model, task.reasoningEffort]);

  // When model changes on Cursor, reset effort to first option for that model (or clear).
  useEffect(() => {
    if (taskEngine !== "cursor") return;
    const nextEfforts = effortOptionsFromHost(engineCapabilities, taskEngine, undefined, model);
    setReasoningEffort((current) => {
      if (current && nextEfforts.includes(current as ReasoningEffort)) return current;
      return nextEfforts[0] || "";
    });
    const meta = modelOptionMeta(engineCapabilities, taskEngine, model);
    if (meta?.supportsFast && /composer/i.test(model) && uiPrefs.fast === undefined) {
      setFastMode(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, taskEngine]);

  function resolveOutboundModel(): string | undefined {
    if (!model) return undefined;
    if (taskEngine === "cursor") {
      return composeCursorModelId(model, modelMeta?.supportsFast ? fastMode : undefined, Boolean(modelMeta?.supportsFast));
    }
    return model;
  }

  function turnStartCommand(text: string, commandId = crypto.randomUUID()): ClientCommand {
    const outboundModel = resolveOutboundModel();
    const effort = effortOptions.length ? reasoningEffort : "";
    return {
      type: "turn.start",
      commandId,
      threadId: task.threadId,
      prompt: text,
      permissionMode,
      ...(outboundModel ? { model: outboundModel } : {}),
      ...(effort ? { reasoningEffort: effort as ReasoningEffort } : {})
    };
  }

  /** Composer owns the draft text; parent only receives the submitted string. */
  const submitPromptText = useCallback((submittedPrompt: string) => {
    if (!submittedPrompt.trim() || online !== true) return;
    // Guard against double Enter / rapid re-clicks before React re-renders pending state.
    if (!running && !pendingPrompt && submittingRef.current) return;
    const text = submittedPrompt.trim();
    const commandId = crypto.randomUUID();
    stickToBottomRef.current = true;
    // Always deliver to the agent. When a turn is already running the agent durable-queues
    // the follow-up so closing the browser no longer drops queued prompts.
    if (running || pendingPrompt) {
      setCommandQueue((current) => [...current, { commandId, prompt: text }]);
    } else {
      submittingRef.current = true;
      setPendingPrompt(text);
    }
    onCommand(turnStartCommand(text, commandId));
  }, [
    online,
    running,
    pendingPrompt,
    model,
    modelMeta,
    fastMode,
    taskEngine,
    effortOptions.length,
    reasoningEffort,
    permissionMode,
    task.threadId,
    onCommand
  ]);

  const cancelQueuedItem = useCallback((queueCommandId: string) => {
    setCommandQueue((current) => current.filter((item) => item.commandId !== queueCommandId));
    if (online === true) {
      onCommand({
        type: "turn.queue.cancel",
        commandId: crypto.randomUUID(),
        threadId: task.threadId,
        queueCommandId
      });
    }
  }, [online, onCommand, task.threadId]);

  const cancelAllQueued = useCallback(() => {
    setCommandQueue([]);
    if (online === true) {
      onCommand({
        type: "turn.queue.cancel",
        commandId: crypto.randomUUID(),
        threadId: task.threadId
      });
    }
  }, [online, onCommand, task.threadId]);

  /** Stop the active turn for real (agent kills CLI process tree). */
  const stopTurn = useCallback(() => {
    submittingRef.current = false;
    setPendingPrompt("");
    setCommandQueue([]);
    try { localStorage.removeItem(`command-queue:${task.threadId}`); } catch { /* ignore */ }
    setDraftClearNonce((value) => value + 1);
    // Always send interrupt: headless kill is keyed by threadId; turnId is for event correlation.
    // Agent also clears its durable queue for this thread.
    onCommand({
      type: "turn.interrupt",
      commandId: crypto.randomUUID(),
      threadId: task.threadId,
      turnId: task.activeTurnId || crypto.randomUUID()
    });
  }, [onCommand, task.threadId, task.activeTurnId]);

  /** Last user message eligible for resend after failure / stop. */
  const lastUserPrompt = useMemo(
    () => [...task.messages].reverse().find((message) => message.role === "user")?.text?.trim() || "",
    [task.messages]
  );
  const lastSystemError = useMemo(() => findLastSystemErrorText(task.messages), [task.messages]);
  const statusFailed = isFailedTaskStatus(task.status);
  const statusCompleted = /^(completed|complete|success|succeeded)$/i.test(String(task.status || "").trim());
  const canResend = Boolean(
    lastUserPrompt
    && online === true
    && !running
    && !pendingPrompt
    && statusFailed
  );
  // Only when status is actually failed/stopped — never because a system/plan message exists.
  // Also hide for legacy bad data: status=failed but the only system blob is a long non-error transcript.
  const hasLongNonErrorSystem = useMemo(
    () => task.messages.some(
      (message) => message.role === "system" && message.text.trim().length > 400 && !isErrorSystemMessage(message.text)
    ),
    [task.messages]
  );
  const showFailureBanner = !running
    && !pendingPrompt
    && statusFailed
    && !statusCompleted
    && (Boolean(lastSystemError) || !hasLongNonErrorSystem);

  const resendLastPrompt = useCallback(() => {
    if (!canResend || !lastUserPrompt) return;
    stickToBottomRef.current = true;
    submittingRef.current = true;
    setPendingPrompt(lastUserPrompt);
    onCommand(turnStartCommand(lastUserPrompt));
  }, [canResend, lastUserPrompt, onCommand, model, modelMeta, fastMode, taskEngine, effortOptions.length, reasoningEffort, permissionMode, task.threadId]);

  const handleModelChange = useCallback((next: string) => {
    setModel(next);
    if (next) saveTaskUiPrefs(task.threadId, { model: next });
  }, [task.threadId]);

  const handleReasoningEffortChange = useCallback((next: ReasoningEffort) => {
    setReasoningEffort(next);
    if (next) saveTaskUiPrefs(task.threadId, { reasoningEffort: next });
  }, [task.threadId]);

  const handleFastModeChange = useCallback((next: boolean) => {
    setFastMode(next);
    saveTaskUiPrefs(task.threadId, { fast: next });
  }, [task.threadId]);

  useEffect(() => {
    if (commandQueue.length === 0) {
      try { localStorage.removeItem(`command-queue:${task.threadId}`); } catch { /* ignore */ }
    } else {
      localStorage.setItem(`command-queue:${task.threadId}`, JSON.stringify(commandQueue));
    }
  }, [commandQueue, task.threadId]);

  // Agent durable queue is source of truth when it reports updates (including empty []).
  // Do NOT re-run on every message delta — that would wipe an optimistic local enqueue
  // before the matching turn.queue.updated arrives.
  useEffect(() => {
    if (task.queuedTurns !== undefined) {
      const next = pruneStaleQueueAgainstMessages(
        task.queuedTurns
          .map((item) => ({ commandId: item.commandId, prompt: item.prompt }))
          .filter((item) => item.prompt.trim()),
        task.messages,
        { idle: !task.activeTurnId }
      );
      setCommandQueue(next);
      return;
    }
    // No agent queue payload yet: if the turn is idle, drop stale local cache from a previous visit.
    if (!task.activeTurnId) {
      setCommandQueue([]);
      try { localStorage.removeItem(`command-queue:${task.threadId}`); } catch { /* ignore */ }
    }
  }, [task.threadId, task.queuedTurns, task.activeTurnId]);

  // When a queued prompt lands as a YOU bubble (or a new turn starts for it), drop it from the
  // local waiting list so it is not shown both in the stream and under「等待队列」.
  // Also clears ghosts after switching back to a conversation whose queue finished unmounted.
  const previousActiveTurnRef = useRef(task.activeTurnId);
  const previousUserCountRef = useRef(task.messages.filter((message) => message.role === "user").length);
  const queueThreadRef = useRef(task.threadId);
  useEffect(() => {
    if (queueThreadRef.current !== task.threadId) {
      queueThreadRef.current = task.threadId;
      previousActiveTurnRef.current = task.activeTurnId;
      previousUserCountRef.current = task.messages.filter((message) => message.role === "user").length;
      setCommandQueue((current) =>
        pruneStaleQueueAgainstMessages(current, task.messages, { idle: !task.activeTurnId })
      );
      return;
    }
    const previousTurn = previousActiveTurnRef.current;
    previousActiveTurnRef.current = task.activeTurnId;
    const userMessages = task.messages.filter((message) => message.role === "user");
    const userCount = userMessages.length;
    const previousUserCount = previousUserCountRef.current;
    previousUserCountRef.current = userCount;
    const turnChanged = Boolean(task.activeTurnId && task.activeTurnId !== previousTurn);
    const userGrew = userCount > previousUserCount;
    const becameIdle = Boolean(previousTurn && !task.activeTurnId);
    if (!turnChanged && !userGrew && !becameIdle) return;
    setCommandQueue((current) => {
      if (current.length === 0) return current;
      const pruned = pruneStaleQueueAgainstMessages(current, task.messages, {
        idle: !task.activeTurnId
      });
      if (
        pruned.length === current.length
        && pruned.every((item, index) => item.commandId === current[index]?.commandId)
      ) {
        return current;
      }
      return pruned;
    });
  }, [task.threadId, task.activeTurnId, task.messages]);

  // Clear optimistic "sending" bubble once the real YOU message is in the transcript
  // (last message may already be a stage/assistant delta — do not require it to be user).
  useEffect(() => {
    if (!pendingPrompt) return;
    const pending = pendingPrompt.trim();
    const matched = task.messages.some(
      (message) => message.role === "user" && message.text.trim() === pending
    );
    if (matched) {
      submittingRef.current = false;
      setPendingPrompt("");
    }
  }, [pendingPrompt, task.messages]);

  // Clear optimistic "sending" when the turn ends in failure before a user bubble lands.
  useEffect(() => {
    if (!pendingPrompt) return;
    if (isFailedTaskStatus(task.status) && !task.activeTurnId) {
      submittingRef.current = false;
      setPendingPrompt("");
    }
  }, [pendingPrompt, task.status, task.activeTurnId]);

  // Release submit lock when a live turn is observed (or pending cleared elsewhere).
  useEffect(() => {
    if (task.activeTurnId || !pendingPrompt) {
      submittingRef.current = false;
    }
  }, [task.activeTurnId, pendingPrompt]);

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
  }, [task.threadId, messageCount, lastMessageLength, task.approvals.length, pendingPrompt, tab, visible, replyDetail]);

  return <>
    <div className="conversation-head">
      <button className="mobile-back" type="button" onClick={onBack} aria-label="返回任务列表">‹</button>
      <div>
        <p className="eyebrow">{t("sessionRecord")}</p>
        <h2 title={task.title} className="thread-title-row">
          <EngineLogo engine={taskEngine} size={18} className="thread-engine-logo" />
          <span>{task.title}</span>
        </h2>
        <code title={task.cwd}>{task.cwd}</code>
        <div
          className="thread-meta-chips"
          title={contextView ? contextUsageTitle(contextView) : "上下文用量"}
        >
          {contextView?.totalTokens != null ? (
            <span className="meta-chip meta-chip-context" title={contextUsageTitle(contextView)}>
              <em>Token</em>
              <strong>
                {compactTokenCount(contextView.totalTokens)}
                {contextView.contextWindow != null ? ` / ${compactTokenCount(contextView.contextWindow)}` : ""}
              </strong>
            </span>
          ) : (
            <span className="meta-chip meta-chip-context muted" title="本轮尚未上报 token 用量">
              <em>Token</em>
              <strong>—</strong>
            </span>
          )}
          {contextView?.usedPercent != null ? (
            <span
              className={`meta-chip meta-chip-context${contextView.usedPercent >= 85 ? " hot" : contextView.usedPercent >= 60 ? " warm" : ""}`}
              title={contextUsageTitle(contextView)}
            >
              <em>上下文</em>
              <span className="ctx-bar" aria-hidden="true">
                <span style={{ width: `${contextView.usedPercent}%` }} />
              </span>
              <strong>{contextView.usedPercent}%</strong>
            </span>
          ) : contextView?.remainingTokens != null && contextView.contextWindow != null ? (
            <span className="meta-chip meta-chip-context" title={contextUsageTitle(contextView)}>
              <em>余窗</em>
              <strong>
                {Math.max(0, Math.min(100, Math.round((contextView.remainingTokens / contextView.contextWindow) * 100)))}%
              </strong>
            </span>
          ) : (
            <span className="meta-chip meta-chip-context muted" title="上下文窗口占比未知">
              <em>上下文</em>
              <strong>—</strong>
            </span>
          )}
          {QUOTA_QUERY_ENABLED && taskQuota ? (
            <span
              className="meta-chip meta-chip-quota"
              title={taskQuota.detail || taskQuota.label || "订阅额度"}
            >
              <em>{taskQuota.label || "额度"}</em>
              <strong>{formatEngineQuotaChip(taskQuota)}</strong>
            </span>
          ) : null}
          {QUOTA_QUERY_ENABLED && (
            <button
              type="button"
              className="meta-chip meta-chip-action"
              disabled={online !== true || quotaLoading}
              onClick={onQuotaRefresh}
              title={quotaDetail || (locale === "en" ? "Query subscription remaining for this engine" : "查询当前引擎订阅剩余用量")}
            >
              {quotaLoading
                ? (locale === "en" ? "Checking…" : "查询中…")
                : (locale === "en" ? "Quota" : "查额度")}
            </button>
          )}
        </div>
        {QUOTA_QUERY_ENABLED && (taskQuota?.detail || quotaDetail) && (
          <details className="quota-detail-panel" open={Boolean(taskQuota || quotaDetail)}>
            <summary>
              {locale === "en" ? "Quota details" : "额度详情"}
              {taskQuota?.checkedAt ? ` · ${new Date(taskQuota.checkedAt).toLocaleString()}` : ""}
            </summary>
            <pre>{sanitizeDisplayText(taskQuota?.detail || quotaDetail || "")}</pre>
          </details>
        )}
      </div>
      <div className="tabs"><button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>{t("chat")}</button><button className={tab === "diff" ? "active" : ""} onClick={() => setTab("diff")}>{t("diff")}</button></div>
    </div>
    {tab === "chat" ? (
      <ChatMessageStream
        messages={task.messages}
        replyDetail={replyDetail}
        taskEngine={taskEngine}
        processLabel={t("replyProcess")}
        pendingPrompt={pendingPrompt}
        showPendingBubble={showPendingBubble}
        running={running}
        processingLabel={t("processing")}
        processingHint={t("processingHint")}
        showFailureBanner={showFailureBanner}
        failureTitle={locale === "en" ? "Task failed" : "任务执行失败"}
        failureBody={lastSystemError || (locale === "en"
          ? `Status: ${task.status}. Open desktop handoff for CLI details if this is empty.`
          : `状态：${task.status}。若此处无详情，请在电脑端客户端「任务 → 接力」查看 CLI 输出。`)}
        canResend={canResend}
        resendTitle={locale === "en" ? "Last turn failed or stopped" : "上次发送失败或已停止"}
        resendHint={locale === "en" ? "Resend the last user message to the host." : "可将上一条用户消息重新下发到主机。"}
        resendLabel={t("resend")}
        onResend={resendLastPrompt}
        commandQueue={commandQueue}
        queueLabel={t("queue")}
        cancelQueueLabel={t("cancelQueue")}
        cancelQueueAllLabel={t("cancelQueueAll")}
        online={online}
        onCancelQueuedItem={cancelQueuedItem}
        onCancelAllQueued={cancelAllQueued}
        approvals={task.approvals}
        actionRequiredLabel={t("actionRequired")}
        declineLabel={t("decline")}
        allowOnceLabel={t("allowOnce")}
        onCommand={onCommand}
        stickToBottomRef={stickToBottomRef}
        messageStreamRef={messageStreamRef}
        messageEndRef={messageEndRef}
      />
    ) : (
      <DiffView diff={task.diff} />
    )}
    <ConversationComposer
      threadId={task.threadId}
      online={online}
      running={running}
      pendingPrompt={pendingPrompt}
      draftClearNonce={draftClearNonce}
      model={model}
      modelOptions={modelOptions}
      modelMeta={modelMeta}
      taskEngine={taskEngine}
      reasoningEffort={reasoningEffort}
      effortOptions={effortOptions}
      fastMode={fastMode}
      permissionMode={permissionMode}
      permissionOptions={permissionOptions}
      replyDetail={replyDetail}
      canResend={canResend}
      isMac={isMac}
      sendLabel={t("send")}
      stopLabel={t("stop")}
      resendLabel={t("resend")}
      currentPermissionLabel={t("currentPermission")}
      agentReplyDetailLabel={t("agentReplyDetail")}
      replyConciseLabel={t("replyConcise")}
      replyDetailedLabel={t("replyDetailed")}
      sendShortcutLabel={t("sendShortcut")}
      onModelChange={handleModelChange}
      onReasoningEffortChange={handleReasoningEffortChange}
      onFastModeChange={handleFastModeChange}
      onPermissionModeChange={onPermissionModeChange}
      onReplyDetailChange={onReplyDetailChange}
      onSubmitPrompt={submitPromptText}
      onStop={stopTurn}
      onResend={resendLastPrompt}
    />
  </>;
}

function listDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  let inStatus = false;
  for (const raw of diff.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "# git status") {
      inStatus = true;
      continue;
    }
    if (inStatus) {
      if (line.startsWith("# ") || line.startsWith("diff ")) {
        inStatus = false;
      } else {
        const status = line.match(/^[ MADRCU?]{1,2}\s+(.+)$/);
        if (status?.[1]) {
          paths.add(status[1].replace(/^.* -> /, "").trim());
          continue;
        }
        if (!line.trim()) {
          inStatus = false;
          continue;
        }
      }
    }
    const git = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (git?.[2]) {
      paths.add(git[2]);
      continue;
    }
    const plus = line.match(/^\+\+\+ b\/(.+)$/);
    if (plus?.[1] && plus[1] !== "/dev/null") paths.add(plus[1]);
  }
  return [...paths].filter(Boolean);
}

function DiffView({ diff }: { diff: string }) {
  if (!diff?.trim()) {
    return (
      <div className="diff-empty">
        <strong>还没有可展示的代码变更</strong>
        <p>任务回合结束后，客户端会汇总工作区的 git 变更（以及引擎上报的文件补丁）。</p>
        <ul>
          <li>工作目录需要是 git 仓库（或其子目录）</li>
          <li>若引擎只改了未跟踪的新文件，会列出路径</li>
          <li>完成一轮有文件写入的对话后，再打开本页查看</li>
        </ul>
      </div>
    );
  }
  const files = listDiffPaths(diff);
  return (
    <div className="diff-panel">
      {files.length > 0 && (
        <div className="diff-file-list">
          <strong>变更文件（{files.length}）</strong>
          <ul>
            {files.map((file) => (
              <li key={file} title={file}><code>{file}</code></li>
            ))}
          </ul>
        </div>
      )}
      <div className="diff-view">
        {sanitizeDisplayText(diff).split("\n").map((line, index) => {
          let className = "";
          if (line.startsWith("+") && !line.startsWith("+++")) className = "add";
          else if (line.startsWith("-") && !line.startsWith("---")) className = "remove";
          else if (line.startsWith("@@")) className = "hunk";
          else if (line.startsWith("diff ") || line.startsWith("# ")) className = "meta";
          return <div key={index} className={className}>{line || " "}</div>;
        })}
      </div>
    </div>
  );
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

function NewTaskDialog({ host, workspaces, online, availableEngines, engineCapabilities, onClose, onRefreshWorkspaces, onCreate }: {
  host: Host;
  workspaces: Workspace[];
  online: boolean | null;
  availableEngines: CliEngineInfo[];
  engineCapabilities: EngineCapability[];
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
  const engineId = engine ? normalizeCliEngine(engine) : "codex";
  const permissionOptions = permissionOptionsForEngine(engineId, locale);
  const [taskPermission, setTaskPermission] = useState<PermissionMode>(permissionOptions[0]?.value ?? "ask-for-approval");
  const cap = capabilityForEngine(engineCapabilities, engineId);
  const modelOptions = modelOptionsFromHost(engineCapabilities, engineId, cap?.currentModel);
  const [model, setModel] = useState(() => {
    const raw = cap?.currentModel || modelOptions[0]?.id || "";
    return raw.split("[")[0] || raw;
  });
  const modelMeta = modelOptionMeta(engineCapabilities, engineId, model);
  const effortOptions = effortOptionsFromHost(
    engineCapabilities,
    engineId,
    cap?.currentReasoningEffort,
    model
  );
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(
    cap?.currentReasoningEffort || effortOptions[0] || ""
  );
  const [fastMode, setFastMode] = useState(() => /composer/i.test(cap?.currentModel || modelOptions[0]?.id || ""));
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

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
    const options = permissionOptionsForEngine(engineId, locale);
    setTaskPermission((current) => (options.some((item) => item.value === current) ? current : options[0]!.value));
  }, [engine, locale]);

  // Only fill defaults when empty/invalid — never wipe a user-selected high effort when host.status refreshes.
  useEffect(() => {
    const nextCap = capabilityForEngine(engineCapabilities, engineId);
    const nextModels = modelOptionsFromHost(engineCapabilities, engineId, nextCap?.currentModel);
    setModel((current) => {
      const base = (current || "").split("[")[0] || current;
      if (base && nextModels.some((item) => item.id === base)) return base;
      const fallback = nextCap?.currentModel || nextModels[0]?.id || "";
      return fallback.split("[")[0] || fallback;
    });
  }, [engine, engineCapabilities]);

  useEffect(() => {
    const nextEfforts = effortOptionsFromHost(engineCapabilities, engineId, undefined, model);
    setReasoningEffort((current) => {
      if (current && nextEfforts.includes(current as ReasoningEffort)) return current;
      return nextEfforts[0] || "";
    });
    if (engineId === "cursor") {
      setFastMode(/composer/i.test(model));
    }
  }, [model, engineId, engineCapabilities]);

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
      const outboundModel = engineId === "cursor" && model
        ? composeCursorModelId(model, modelMeta?.supportsFast ? fastMode : undefined, Boolean(modelMeta?.supportsFast))
        : (model || undefined);
      const effort = effortOptions.length ? (reasoningEffort || undefined) : undefined;
      await onCreate(
        cwd,
        prompt,
        title,
        engine,
        taskPermission,
        outboundModel,
        effort
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
        {(["codex", "claude", "grok", "cursor"] as CliEngine[]).map((item) => {
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
      <select value={model} onChange={(event) => setModel(event.target.value.split("[")[0] || event.target.value)} disabled={!engine || !modelOptions.length}>
        {!modelOptions.length && <option value="">主机未上报模型列表</option>}
        {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
    {engineId === "cursor" && modelMeta?.supportsFast && (
      <label className="composer-fast-toggle" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>Fast 模式</span>
        <input type="checkbox" checked={fastMode} onChange={(event) => setFastMode(event.target.checked)} />
        <small style={{ color: "#6f756e" }}>部分模型（如 Composer / GPT）支持更快但更浅的推理</small>
      </label>
    )}
    <label>{engineId === "cursor" ? "Effort（按模型）" : "推理强度"}
      <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)} disabled={!engine || !effortOptions.length}>
        {!effortOptions.length && <option value="">{engineId === "cursor" ? "当前模型无 effort" : "—"}</option>}
        {effortOptions.map((option) => <option key={option} value={option}>{option}</option>)}
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

/**
 * Task list / foot: always show the task working directory as an absolute path.
 * (Previously only the last two segments were shown, which hid parent folders and
 * made workspace-root vs subdir tasks look the same.)
 */
function formatTaskCwd(raw: string | undefined | null): string {
  const value = String(raw ?? "").trim();
  if (!value) return "—";
  // Keep platform separators; strip redundant trailing separators (except drive root).
  const normalized = value.replace(/[\\/]+$/, (match, offset) => {
    // Keep "C:\" / "/" roots
    if (/^[A-Za-z]:\\?$/.test(value.slice(0, offset + 1)) || value === "/") return match.charAt(0) || "";
    return "";
  });
  return normalized || value;
}
