import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, existsSync as fsExistsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { URL } from "node:url";
import type { CliEngine, ContextUsage, PermissionMode, RunInfo } from "@anytimevibe/protocol";
import { mergeContextUsage, normalizeContextUsage } from "@anytimevibe/protocol";
import { cloudProxyChildEnv, collectLocalProxyEnv, ensureCursorHttp1ForProxy } from "../local-proxy";
import { windowsCmdArguments, windowsNeedsCmdShim } from "../windows-command";
import { resolveCursorSpawnTarget, resolveEngineBinary } from "./detect";
import { formatAgySpawnArgs, formatCursorModelArg, parseCursorModelRef, resolveModelContextWindow } from "./model-catalog";
import { explainGrokSerializationError, prepareGrokResponsesCompat } from "./grok-responses-compat";
import { isCodexModelsManagerNoise, stripAnsi } from "./log-noise";
import { headlessPermissionArgs } from "./permission-args";
import { appendEngineDiffChunk, extractFileChangeDiff } from "./task-diff";
import type { ApprovalPlan, ApprovalQuestion, BackendStreamEvent, HeadlessRunOptions, HeadlessRunResult, StreamDeltaKind } from "./types";
import { ensureWorkspaceTrusted } from "./workspace-trust";

type ActiveRun = {
  child: ChildProcess;
  turnId: string;
  /** Set by interruptHeadlessThread; exit handler must treat as interrupted not failed. */
  interrupted: boolean;
};

const activeByThread = new Map<string, ActiveRun>();

/** Default headless idle timeout — only kill when the CLI stops emitting progress. */
const HEADLESS_IDLE_TIMEOUT_MS = Number(
  process.env.ANYTIMEVIBE_HEADLESS_IDLE_TIMEOUT_MS || 15 * 60_000
);
/**
 * Absolute ceiling for a single headless turn (runaway protection).
 * Override with ANYTIMEVIBE_HEADLESS_TIMEOUT_MS. Previously defaulted to 8 minutes and
 * killed long but healthy Cursor/Claude runs that were still streaming.
 */
const HEADLESS_MAX_TIMEOUT_MS = Number(
  process.env.ANYTIMEVIBE_HEADLESS_TIMEOUT_MS || 2 * 60 * 60_000
);
/** If Cursor emits stream-json `result` but the process never exits (MCP child hang), force-finish. */
const CURSOR_RESULT_EXIT_GRACE_MS = Number(process.env.ANYTIMEVIBE_CURSOR_RESULT_GRACE_MS || 1_500);
/** No stdout at all for this long → treat as stalled (common with bad --resume / reconnect loops). */
const CURSOR_STALL_MS = Number(process.env.ANYTIMEVIBE_CURSOR_STALL_MS || 120_000);

/**
 * Apply on-disk credentials for headless engines so CCSwitch/Cockpit account switches
 * take effect on the next turn without restarting AnytimeVibe.
 */
async function applyHeadlessDiskCredentials(
  engine: CliEngine,
  env: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const next = { ...env };
  if (engine === "claude") {
    try {
      const settingsRaw = await fs.readFile(path.join(os.homedir(), ".claude", "settings.json"), "utf8");
      const settings = JSON.parse(settingsRaw) as { env?: Record<string, string> };
      // A switcher may remove the previous key before writing the new settings.
      // Clear values supplied by the long-lived Agent process before applying the
      // latest on-disk env block, otherwise a stale API key can win the next turn.
      if (settings.env && typeof settings.env === "object") {
        for (const key of [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_API_URL",
          "CLAUDE_BASE_URL",
          "CLAUDE_API_URL",
          "CLAUDE_MODEL",
          "ANTHROPIC_MODEL"
        ]) delete next[key];
        for (const [key, value] of Object.entries(settings.env)) {
          if (typeof value === "string" && value.trim()) next[key] = value;
        }
      }
    } catch {
      // optional
    }
    return next;
  }
  if (engine === "grok") {
    // Prefer ~/.grok/config.toml api_key (copied into temp GROK_HOME by compat layer).
    // Stale Agent process.env keys from a previous account would otherwise win.
    for (const key of ["XAI_API_KEY", "GROK_API_KEY", "OPENAI_API_KEY"]) {
      delete next[key];
    }
    // Let the current config.toml select the model when it exists. Explicit task
    // options still win in buildArgs; this only removes stale process-level hints.
    try {
      await fs.access(path.join(next.GROK_HOME?.trim() || path.join(os.homedir(), ".grok"), "config.toml"));
      delete next.GROK_MODEL;
      delete next.XAI_MODEL;
    } catch {
      // Keep env-only Grok setups working when no config file exists.
    }
    return next;
  }
  // Cursor / Antigravity: each spawn reads ~/.cursor or ~/.gemini/antigravity-cli from disk.
  return next;
}

/**
 * Kill the CLI process tree. On Windows headless spawns go through cmd.exe — bare
 * child.kill() only ends the shell and leaves claude/grok/cursor/agy running.
 */
function killChildTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try { child.kill(); } catch { /* ignore */ }
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", () => {
        try { child.kill(); } catch { /* ignore */ }
      });
      return;
    } catch {
      // fall through
    }
  } else {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    setTimeout(() => {
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 1_500);
    return;
  }
  try { child.kill(); } catch { /* ignore */ }
}

/**
 * Parse optional fast / base from web model field:
 *   legacy: composer-2.5[fast=true,effort=high]
 *   slug:   gpt-5.6-sol-medium-fast
 *   bare:   gpt-5.6-sol  (+ separate reasoningEffort)
 */
function parseCursorModelHints(model: string | undefined): {
  model: string;
  fast?: boolean;
  reasoningEffort?: import("@anytimevibe/protocol").ReasoningEffort;
  thinking?: boolean;
} {
  const parsed = parseCursorModelRef(model);
  return {
    model: parsed.base,
    ...(parsed.fast !== undefined ? { fast: parsed.fast } : {}),
    ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
    ...(parsed.thinking !== undefined ? { thinking: parsed.thinking } : {})
  };
}

function buildArgs(
  engine: CliEngine,
  options: HeadlessRunOptions,
  childEnv: NodeJS.ProcessEnv = process.env
): string[] {
  const args: string[] = [];
  if (engine === "claude") {
    // Prefer per-task model; fall back to env; never force offline "sonnet" aliases.
    const model = (
      options.model
      || childEnv.CLAUDE_MODEL
      || childEnv.ANTHROPIC_MODEL
      || ""
    ).trim();
    args.push(
      "-p", options.prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages"
    );
    if (model) args.push("--model", model);
    if (options.reasoningEffort) args.push("--effort", options.reasoningEffort);
    // Only use --bare when API key is present (bare skips keychain/OAuth).
    // Prefer per-turn settings.json env (CCSwitch / Cockpit) over stale process.env.
    if (childEnv.ANTHROPIC_API_KEY) args.push("--bare");
    if (options.providerSessionId) args.push("--resume", options.providerSessionId);
    args.push(...headlessPermissionArgs(engine, options.permissionMode));
    return args;
  }
  if (engine === "cursor") {
    // Cursor: `-p/--print` is a boolean flag; prompt is a positional arg (not `-p <prompt>` like Claude).
    // Docs: agent -p --force --output-format stream-json --stream-partial-output --workspace …
    // https://cursor.com/docs/cli/headless
    // Always rewrite to suffix slugs (gpt-5.6-sol-medium-fast). Never pass legacy [fast=…] brackets.
    const hints = parseCursorModelHints(options.model);
    const wantThinking = options.thinking ?? hints.thinking;
    const modelArg = formatCursorModelArg(hints.model, {
      ...(options.reasoningEffort || hints.reasoningEffort
        ? { reasoningEffort: options.reasoningEffort || hints.reasoningEffort }
        : {}),
      ...(hints.fast !== undefined ? { fast: hints.fast } : {}),
      ...(wantThinking !== undefined ? { thinking: wantThinking } : {})
    });
    args.push(
      "--print",
      "--output-format", "stream-json",
      "--stream-partial-output",
      "--workspace", options.cwd
    );
    if (modelArg) args.push("--model", modelArg);
    if (options.providerSessionId) args.push("--resume", options.providerSessionId);
    args.push(...headlessPermissionArgs(engine, options.permissionMode));
    // Positional prompt last so option parsers never swallow it.
    args.push(options.prompt);
    return args;
  }
  if (engine === "antigravity") {
    const printTimeout = formatAgyPrintTimeout(HEADLESS_MAX_TIMEOUT_MS);
    const spawn = formatAgySpawnArgs(
      options.model || childEnv.AGY_MODEL || childEnv.ANTIGRAVITY_MODEL,
      options.reasoningEffort
    );
    args.push(
      "-p", options.prompt,
      "--output-format", "stream-json",
      "--print-timeout", printTimeout
    );
    if (spawn.model) args.push("--model", spawn.model);
    if (spawn.effort) args.push("--effort", spawn.effort);
    // Only resume real agy brain conversations — never the AnytimeVibe web thread UUID.
    const conversationId = resolveAgyConversationResumeId(options.providerSessionId, options.threadId);
    if (conversationId) args.push("--conversation", conversationId);
    args.push(...headlessPermissionArgs(engine, options.permissionMode));
    return args;
  }
  // Grok Build CLI (distinct binary: grok, not agent)
  const model = (options.model || childEnv.GROK_MODEL || childEnv.XAI_MODEL || "").trim();
  args.push(
    "-p", options.prompt,
    "--output-format", "streaming-json",
    "--cwd", options.cwd
  );
  if (model) args.push("--model", model);
  if (options.reasoningEffort) {
    // Grok Build accepts low|medium|high|xhigh. Map legacy "max" → xhigh.
    const effort = options.reasoningEffort === "max" ? "xhigh" : options.reasoningEffort;
    args.push("--reasoning-effort", effort);
  }
  if (options.providerSessionId) args.push("--resume", options.providerSessionId);
  args.push(...headlessPermissionArgs(engine, options.permissionMode));
  return args;
}

/** Remove credentials and query secrets before an endpoint is sent to the Web UI. */
function sanitizeRunEndpoint(raw: string | undefined | null): string | undefined {
  const value = String(raw || "").trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const safePath = url.pathname.replace(
      /(sk-[a-z0-9_-]{8,}|(?:api[_-]?key|token|secret)[=/][^/]+)/gi,
      "<redacted>"
    );
    return `${url.origin}${safePath}`.replace(/\/+$/, "") || url.origin;
  } catch {
    return value.replace(/[?#].*$/, "").replace(/\/+$/, "") || undefined;
  }
}

/**
 * Resolve the API root used by a headless engine. Environment overrides win;
 * the provider roots cover the normal signed-in CLI path when no override is
 * exposed by the CLI itself.
 */
function headlessEndpoint(
  engine: Exclude<CliEngine, "codex">,
  childEnv: NodeJS.ProcessEnv,
  override?: string
): string | undefined {
  const configured = engine === "claude"
    ? [childEnv.ANTHROPIC_BASE_URL, childEnv.ANTHROPIC_API_URL, childEnv.CLAUDE_BASE_URL, childEnv.CLAUDE_API_URL]
    : engine === "grok"
      ? [childEnv.GROK_BASE_URL, childEnv.XAI_BASE_URL, childEnv.XAI_API_BASE_URL]
      : engine === "cursor"
        ? [childEnv.CURSOR_BASE_URL, childEnv.CURSOR_API_URL, childEnv.CURSOR_AGENT_BASE_URL]
        : [childEnv.AGY_BASE_URL, childEnv.ANTIGRAVITY_BASE_URL, childEnv.GEMINI_BASE_URL, childEnv.GOOGLE_GENAI_BASE_URL];
  const fallback = engine === "claude"
    ? "https://api.anthropic.com"
    : engine === "grok"
      ? "https://api.x.ai/v1"
      : engine === "cursor"
        ? "https://api2.cursor.sh"
        : "https://cloudcode-pa.googleapis.com";
  return sanitizeRunEndpoint(override || configured.find((item) => item?.trim()) || fallback);
}

function initialHeadlessRunInfo(
  engine: Exclude<CliEngine, "codex">,
  options: HeadlessRunOptions,
  childEnv: NodeJS.ProcessEnv,
  endpointOverride?: string
): RunInfo {
  let model = options.model;
  if (!model && engine === "claude") model = childEnv.CLAUDE_MODEL || childEnv.ANTHROPIC_MODEL;
  if (!model && engine === "grok") model = childEnv.GROK_MODEL || childEnv.XAI_MODEL;
  if (!model && engine === "antigravity") model = childEnv.AGY_MODEL || childEnv.ANTIGRAVITY_MODEL;
  if (engine === "cursor" && model) model = parseCursorModelHints(model).model;
  const endpoint = headlessEndpoint(engine, childEnv, endpointOverride);
  return {
    engine,
    ...(model?.trim() ? { model: model.trim() } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
    ...(endpoint ? { endpoint } : {})
  };
}

function formatAgyPrintTimeout(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function captureReportedDiff(threadId: string, value: unknown, depth = 0): void {
  if (!value || depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value) captureReportedDiff(threadId, item, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, any>;
  const marker = String(record.type ?? record.name ?? record.tool ?? record.kind ?? record.action ?? "").toLowerCase();
  const hasPatch = ["diff", "patch", "unifiedDiff", "unified_diff", "old_string", "oldString", "new_string", "newString", "content"].some((key) => {
    const candidate = record[key];
    return typeof candidate === "string" && candidate.trim().length > 0;
  });
  const fileLike = marker.includes("file") || marker.includes("write") || marker.includes("edit") || marker.includes("patch") || marker.includes("apply") || hasPatch;
  if (fileLike) {
    const patch = extractFileChangeDiff(record);
    if (patch) appendEngineDiffChunk(threadId, patch);
  }
  for (const key of ["item", "message", "content", "result", "step_update", "tool_call", "toolCall", "tool_info", "toolInfo"]) {
    if (record[key] && record[key] !== value) captureReportedDiff(threadId, record[key], depth + 1);
  }
}

function emitDelta(
  onEvent: (event: BackendStreamEvent) => void,
  options: HeadlessRunOptions,
  itemId: string,
  kind: StreamDeltaKind,
  delta: string
): void {
  if (!delta) return;
  onEvent({
    type: "delta",
    threadId: options.threadId,
    turnId: options.turnId,
    itemId,
    kind,
    delta
  });
}

type ParseState = {
  sessionId: string;
  text: string;
  failed: boolean;
  errorMessage: string;
  /** Normalized error texts already published as type:error (suppress retries / result duplicates). */
  emittedErrors: Set<string>;
  sawAssistant: boolean;
  sawThoughtStage: boolean;
  lastProgressAt: number;
  /** Cursor emitted a terminal `result` event — process may still hang on MCP teardown. */
  gotResult: boolean;
  lineCount: number;
  contextUsage?: ContextUsage;
  model?: string;
  /** Cursor interactive tool call ids already surfaced as approval.requested. */
  emittedApprovalIds?: Set<string>;
  /** Pause/kill headless Cursor so Web can answer createPlan / askQuestion. */
  pauseForApproval?: boolean;
  /** Last assistant snapshot from Antigravity (for cumulative text_delta / result.response). */
  agyJsonBuf?: string;
  /** Antigravity tool step keys already announced. */
  agySeenTools?: Set<string>;
  /**
   * Last actionable cause scraped from Antigravity stderr.
   * Print mode often collapses real failures (401 / location) into
   * "Agent execution terminated due to error."
   */
  agyLastCause?: string;
  /** Claude --resume pointed at a missing/stale/sidechain session id. */
  claudeResumeInvalid?: boolean;
};

/** Strip UI prefixes so "错误：API Error" and "API Error" dedupe as one. */
export function normalizeSystemErrorText(text: string): string {
  return text
    .trim()
    .replace(/^(错误|任务失败|Error|Failed)[:：\s]*/i, "")
    .trim();
}

function emitHeadlessErrorOnce(
  state: ParseState,
  onEvent: (event: BackendStreamEvent) => void,
  options: HeadlessRunOptions,
  message: string,
  stageId = "stage:error"
): void {
  const trimmed = message.trim();
  if (!trimmed) return;
  state.failed = true;
  state.errorMessage = trimmed;
  const key = normalizeSystemErrorText(trimmed).toLowerCase();
  if (key && state.emittedErrors.has(key)) return;
  if (key) state.emittedErrors.add(key);
  onEvent({ type: "error", threadId: options.threadId, message: trimmed });
  emitDelta(onEvent, options, stageId, "stage", `\n✗ ${trimmed}\n`);
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function normalizeApprovalQuestions(raw: unknown): ApprovalQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ApprovalQuestion[] = [];
  for (const [index, item] of raw.entries()) {
    const row = asRecord(item);
    if (!row) continue;
    const id = String(row.id || row.questionId || row.question_id || `q${index + 1}`).trim();
    const prompt = String(
      row.prompt || row.question || row.text || row.title || row.header || ""
    ).trim();
    const optionsRaw = Array.isArray(row.options)
      ? row.options
      : (Array.isArray(row.choices) ? row.choices : []);
    const options: Array<{ id: string; label: string }> = [];
    for (const [optIndex, opt] of optionsRaw.entries()) {
      if (typeof opt === "string" && opt.trim()) {
        const label = opt.trim();
        options.push({ id: label, label });
        continue;
      }
      const o = asRecord(opt);
      if (!o) continue;
      const label = String(o.label || o.text || o.title || o.name || o.value || "").trim();
      const oid = String(o.id || o.value || o.name || label || `opt${optIndex + 1}`).trim();
      if (!oid || !label) continue;
      options.push({ id: oid, label });
    }
    if (!id || !prompt || !options.length) continue;
    out.push({
      id,
      prompt,
      options,
      ...(row.allowMultiple === true || row.allow_multiple === true ? { allowMultiple: true } : {})
    });
  }
  return out;
}

function normalizeApprovalPlan(raw: unknown): ApprovalPlan | null {
  const row = asRecord(raw);
  if (!row) return null;
  const planText = String(row.plan || row.content || row.markdown || "").trim();
  if (!planText) return null;
  const todos = Array.isArray(row.todos)
    ? row.todos
      .map((todo) => {
        const t = asRecord(todo);
        if (!t) return null;
        const id = String(t.id || "").trim();
        const content = String(t.content || t.text || "").trim();
        if (!id || !content) return null;
        return {
          id,
          content,
          ...(t.status != null ? { status: String(t.status) } : {})
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : undefined;
  return {
    plan: planText,
    ...(row.name != null && String(row.name).trim() ? { name: String(row.name).trim() } : {}),
    ...(row.overview != null && String(row.overview).trim() ? { overview: String(row.overview).trim() } : {}),
    ...(todos?.length ? { todos } : {})
  };
}

/**
 * Every container a Cursor tool-call may hide its payload in.
 *
 * Cursor moves the interesting fields between `args` and `result` (each of which
 * may wrap the real body in a `success` envelope) across `started` / `completed`
 * and across CLI versions. The previous code picked ONE container with
 * `asRecord(node.args) || asRecord(node.result) || node`, which short-circuits on
 * an EMPTY `args: {}` — an empty object is truthy — and so never looked at
 * `result`. A question whose options lived in `result` therefore parsed as zero
 * questions and rendered as an approval card with nothing to click.
 *
 * Searching every candidate instead of guessing one is what makes this robust to
 * the next shuffle of the payload shape.
 */
function approvalPayloadCandidates(node: Record<string, any>): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const push = (value: unknown): void => {
    const record = asRecord(value);
    if (record && !out.includes(record)) out.push(record);
  };
  push(node);
  push(node.success);
  for (const key of ["args", "result", "input", "arguments", "params"]) {
    const nested = asRecord(node[key]);
    if (!nested) continue;
    push(nested);
    push(nested.success);
    push(nested.value);
    push(nested.data);
  }
  return out;
}

/**
 * Pull the question list out of a Cursor askQuestion tool call.
 *
 * Array shapes are tried across every container first because they are the
 * unambiguous form; only then do we treat a container as a single inline
 * question (`{ question, options }` with no wrapper array), which is the shape
 * that yields a false positive most easily.
 */
export function findApprovalQuestions(node: Record<string, any>): ApprovalQuestion[] {
  const containers = approvalPayloadCandidates(node);
  for (const container of containers) {
    const fromArray = normalizeApprovalQuestions(
      container.questions ?? container.question_list ?? container.questionList
    );
    if (fromArray.length) return fromArray;
  }
  for (const container of containers) {
    const single = normalizeApprovalQuestions([container])[0];
    if (single) return [single];
  }
  return [];
}

/** Pull the plan out of a Cursor createPlan tool call, checking every container. */
export function findApprovalPlan(node: Record<string, any>): ApprovalPlan | null {
  for (const container of approvalPayloadCandidates(node)) {
    const plan = normalizeApprovalPlan(container);
    if (plan) return plan;
  }
  return null;
}

/**
 * Compact JSON of an unparseable payload, so a card that has no options still
 * shows the user what was asked instead of only "could not parse".
 */
function approvalRawSummary(node: Record<string, any>): string {
  try {
    const text = JSON.stringify(node, null, 2);
    if (!text || text === "{}") return "";
    return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…（已截断）` : text;
  } catch {
    return "";
  }
}

function emitCursorInteractiveApproval(
  options: HeadlessRunOptions,
  state: ParseState,
  onEvent: (event: BackendStreamEvent) => void,
  callId: string,
  kind: "plan" | "question",
  payload: { plan?: ApprovalPlan; questions?: ApprovalQuestion[]; title: string; detail: string }
): void {
  if (!state.emittedApprovalIds) state.emittedApprovalIds = new Set();
  const already = state.emittedApprovalIds.has(callId);
  // Allow a richer completed payload to replace a sparse started emission.
  if (already) {
    const richerQuestion = kind === "question" && (payload.questions?.length || 0) > 0;
    const richerPlan = kind === "plan" && Boolean(payload.plan?.plan);
    if (!richerQuestion && !richerPlan) return;
  }
  state.emittedApprovalIds.add(callId);
  state.pauseForApproval = true;
  onEvent({
    type: "approval.requested",
    threadId: options.threadId,
    turnId: options.turnId,
    requestId: `cursor:${options.threadId}:${callId}`,
    itemId: callId,
    approvalType: kind,
    title: payload.title,
    detail: payload.detail,
    availableDecisions: ["accept", "decline", "cancel"],
    permissionMode: options.permissionMode,
    ...(payload.plan ? { plan: payload.plan } : {}),
    ...(payload.questions?.length ? { questions: payload.questions } : {})
  });
}

/** Claude CLI when --resume points at a deleted, cleaned, or non-parent session. */
export function isClaudeSessionNotFound(text: string | undefined | null): boolean {
  return /No conversation found with session ID/i.test(String(text || ""));
}

/**
 * Only accept parent-conversation session ids.
 * Nested Agent/Task channels share stream-json output and may carry sidechain markers;
 * blindly overwriting providerSessionId with those breaks the next --resume.
 */
export function shouldAcceptClaudeSessionId(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  if (!parsed.session_id) return false;
  if (parsed.isSidechain === true || parsed.is_sidechain === true) return false;
  const parentTool = parsed.parent_tool_use_id;
  if (parentTool != null && String(parentTool).trim() !== "") return false;
  const type = String(parsed.type || "");
  if (type === "system" && String(parsed.subtype || "") === "init") return true;
  if (type === "result") return !parsed.is_error;
  // Parent-channel traffic may repeat the same id; safe to refresh.
  return type === "assistant" || type === "user" || type === "stream_event" || type === "content_block_delta";
}

function noteClaudeSessionId(state: ParseState, parsed: Record<string, unknown>): void {
  if (!shouldAcceptClaudeSessionId(parsed)) return;
  const next = String(parsed.session_id || "").trim();
  if (next) state.sessionId = next;
}

function handleClaudeLine(
  line: string,
  options: HeadlessRunOptions,
  state: ParseState,
  onEvent: (event: BackendStreamEvent) => void
): void {
  state.lastProgressAt = Date.now();
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    emitDelta(onEvent, options, "cli-log", "cli-log", `${line}\n`);
    return;
  }
  captureReportedDiff(options.threadId, parsed);
  const type = String(parsed.type || "");
  noteClaudeSessionId(state, parsed);
  const liveUsage = normalizeContextUsage(parsed.usage ?? parsed.message?.usage ?? parsed.usage_metadata, Number(parsed.context_window ?? parsed.contextWindow) || resolveModelContextWindow("claude", options.model));
  if (liveUsage) {
    state.contextUsage = mergeContextUsage(state.contextUsage, liveUsage);
    onEvent({ type: "usage", threadId: options.threadId, contextUsage: state.contextUsage });
  }

  if (type === "system") {
    const subtype = String(parsed.subtype || "");
    if (subtype === "init") {
      if (parsed.model) state.model = String(parsed.model);
      const model = state.model ? `（模型 ${state.model}）` : "";
      emitDelta(onEvent, options, "stage:init", "stage", `\n▶ Claude 会话初始化${model}\n`);
    } else if (subtype === "api_retry") {
      const attempt = parsed.attempt ?? "?";
      const max = parsed.max_retries ?? "?";
      const err = parsed.error || parsed.error_status || "retry";
      emitDelta(
        onEvent,
        options,
        "stage:retry",
        "stage",
        `\n⏳ Claude API 重试 ${attempt}/${max}（${err}）…\n`
      );
    } else if (subtype === "status" && parsed.status) {
      emitDelta(onEvent, options, "stage:status", "stage", `\n… ${parsed.status}\n`);
    }
    return;
  }

  if (type === "stream_event") {
    const event = parsed.event || {};
    const eventType = String(event.type || "");
    // Tool / thinking progress → process stream (not YOU).
    if (eventType === "content_block_start") {
      const block = event.content_block || {};
      if (block.type === "tool_use" && block.name) {
        const name = String(block.name);
        emitDelta(onEvent, options, `stage:tool:${name}`, "stage", `\n▶ 调用工具 ${name}\n`);
      } else if (block.type === "thinking") {
        if (!state.sawThoughtStage) {
          state.sawThoughtStage = true;
          emitDelta(onEvent, options, "stage:thinking", "stage", "\n… Claude 思考中\n");
        }
      }
      return;
    }
    const delta = event.delta;
    if (delta?.type === "text_delta" && delta.text) {
      state.text += String(delta.text);
      state.sawAssistant = true;
      emitDelta(onEvent, options, "assistant", "assistant", String(delta.text));
    }
    return;
  }
  if (type === "content_block_delta" && parsed.delta?.text) {
    state.text += String(parsed.delta.text);
    state.sawAssistant = true;
    emitDelta(onEvent, options, "assistant", "assistant", String(parsed.delta.text));
    return;
  }

  // Claude marks tool outputs as type=user + tool_result. Never treat as human YOU bubbles.
  if (type === "user") {
    const content = parsed.message?.content;
    if (Array.isArray(content) && content.some((block: any) => block?.type === "tool_result")) {
      const preview = content
        .filter((block: any) => block?.type === "tool_result")
        .map((block: any) => {
          const raw = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("")
              : "";
          return String(raw || "").trim().slice(0, 240);
        })
        .filter(Boolean)
        .join("\n");
      if (preview) {
        emitDelta(
          onEvent,
          options,
          "cli-log",
          "cli-log",
          `\n${preview}${preview.length >= 240 ? "…" : ""}\n`
        );
      } else {
        emitDelta(onEvent, options, "stage:tool-result", "stage", "\n✓ 工具已返回\n");
      }
    }
    return;
  }

  if (type === "assistant" && parsed.message?.content) {
    for (const block of parsed.message.content) {
      if (block?.type === "tool_use" && block.name) {
        emitDelta(
          onEvent,
          options,
          `stage:tool:${String(block.name)}`,
          "stage",
          `\n▶ 调用工具 ${String(block.name)}\n`
        );
        continue;
      }
      if (block?.type === "thinking" && !state.sawThoughtStage) {
        state.sawThoughtStage = true;
        emitDelta(onEvent, options, "stage:thinking", "stage", "\n… Claude 思考中\n");
        continue;
      }
      if (block?.type === "text" && block.text) {
        const text = String(block.text);
        // Synthetic assistant error payloads (auth / model offline)
        if (parsed.message?.model === "<synthetic>" || /API Error:|not logged in|已下线/i.test(text)) {
          // Claude may emit the same synthetic error on each api_retry — publish once.
          emitHeadlessErrorOnce(state, onEvent, options, text);
          continue;
        }
        // Skip exact duplicates already streamed via text_delta; keep later tool-turn replies.
        if (state.sawAssistant && (state.text === text || state.text.endsWith(text))) continue;
        state.text += (state.sawAssistant && state.text && !state.text.endsWith("\n") ? "\n" : "") + text;
        state.sawAssistant = true;
        emitDelta(onEvent, options, "assistant", "assistant", text);
      }
    }
    return;
  }
  if (type === "result") {
    noteClaudeSessionId(state, parsed);
    const usage = normalizeContextUsage(
      parsed.usage ?? parsed.result?.usage ?? parsed.message?.usage ?? parsed,
      Number(parsed.context_window ?? parsed.contextWindow) || resolveModelContextWindow("claude", options.model)
    );
    if (usage) {
      state.contextUsage = mergeContextUsage(state.contextUsage, usage);
      // Publish the accumulated snapshot rather than this single sample: a sparse
      // sample would leave older web clients (which replace instead of merging)
      // without the window size, blanking the context gauge until the next sync.
      onEvent({ type: "usage", threadId: options.threadId, contextUsage: state.contextUsage });
    }
    if (typeof parsed.result === "string" && parsed.result) {
      if (parsed.is_error) {
        let message = parsed.result;
        if (isClaudeSessionNotFound(message)) {
          state.claudeResumeInvalid = true;
          // Do not keep seeding the missing id for the next turn.
          state.sessionId = "";
          // "No conversation found" in a result event is a sub-agent sidechain error:
          // Claude continues on the main channel. Suppress the hard failure; show a warning.
          const warnKey = "claude-session-not-found";
          if (!state.emittedErrors.has(warnKey)) {
            state.emittedErrors.add(warnKey);
            emitDelta(onEvent, options, "stage:resume-warn", "stage", `\n… Claude 已重置会话（${message}），继续执行\n`);
          }
          return;
        }
        // Common after interactive trust decline
        if (/trust|workspace|not.*allowed|permission/i.test(parsed.result)) {
          message = `${parsed.result}\n（若曾在接力终端拒绝信任目录，请在本机重新接力并选择信任，或删除该目录后重建任务）`;
        }
        emitHeadlessErrorOnce(state, onEvent, options, message);
      } else if (!state.sawAssistant) {
        state.text = parsed.result;
        state.sawAssistant = true;
        emitDelta(onEvent, options, "assistant", "assistant", parsed.result);
      }
    } else if (parsed.is_error) {
      emitHeadlessErrorOnce(state, onEvent, options, "Claude 运行失败");
    }
  }
}

/**
 * Cursor Agent CLI stream-json events (print mode).
 * See https://cursor.com/docs/cli/reference/output-format
 */
function handleCursorLine(
  line: string,
  options: HeadlessRunOptions,
  state: ParseState,
  onEvent: (event: BackendStreamEvent) => void
): void {
  state.lineCount += 1;
  state.lastProgressAt = Date.now();
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    emitDelta(onEvent, options, "cli-log", "cli-log", `${line}\n`);
    return;
  }
  captureReportedDiff(options.threadId, parsed);
  const type = String(parsed.type || "");
  if (parsed.session_id) state.sessionId = String(parsed.session_id);
  const liveUsage = normalizeContextUsage(parsed.usage ?? parsed.metrics, Number(parsed.context_window ?? parsed.contextWindow) || resolveModelContextWindow("cursor", options.model));
  if (liveUsage) {
    state.contextUsage = mergeContextUsage(state.contextUsage, liveUsage);
    onEvent({ type: "usage", threadId: options.threadId, contextUsage: state.contextUsage });
  }

  if (type === "system") {
    const subtype = String(parsed.subtype || "");
    if (subtype === "init") {
      if (parsed.model) state.model = String(parsed.model);
      const model = state.model ? `（模型 ${state.model}）` : "";
      emitDelta(onEvent, options, "stage:init", "stage", `\n▶ Cursor 会话初始化${model}\n`);
    }
    return;
  }

  if (type === "thinking") {
    if (!state.sawThoughtStage) {
      state.sawThoughtStage = true;
      emitDelta(onEvent, options, "stage:thinking", "stage", "\n… Cursor 思考中\n");
    } else if (String(parsed.subtype || "") === "completed") {
      emitDelta(onEvent, options, "stage:thinking", "stage", "\n✓ 思考完成\n");
    }
    return;
  }

  if (type === "user") {
    return;
  }

  if (type === "agent_transcripts" || type === "transcript" || type === "subagent" || type === "background_agent_transcript") {
    return;
  }

  if (type === "assistant") {
    // Skip subagent / background-agent transcript messages — they are internal
    // Cursor sub-task communications, not the user-facing assistant reply.
    const isSubagent = Boolean(
      parsed.subagent_id
      || parsed.agent_type === "background"
      || parsed.is_subagent
      || parsed.message?.agent_id
      || parsed.message?.subagent_id
    );
    const content = parsed.message?.content;
    const text = Array.isArray(content)
      ? content.map((block: any) => (block?.type === "text" ? String(block.text || "") : "")).join("")
      : "";
    if (!text) return;
    if (/<agent_transcripts>|Agent transcripts\s*\(\s*past chats\s*\)\s*live in/i.test(text)) {
      return;
    }
    if (isSubagent) {
      emitDelta(onEvent, options, "stage:subagent", "stage", `\n… [子任务进度] ${text.slice(0, 160)}\n`);
      return;
    }
    // Cursor stream-json + --stream-partial-output (docs):
    // - timestamp_ms present, model_call_id absent → streaming delta (use)
    // - both present → pre-tool buffered flush (skip)
    // - both absent → final flush at end of turn (skip if already streamed)
    // Without partial mode, complete messages have neither field — accept each segment.
    const hasTs = Object.prototype.hasOwnProperty.call(parsed, "timestamp_ms");
    const hasMc = Object.prototype.hasOwnProperty.call(parsed, "model_call_id");
    if (hasTs && hasMc) return;
    if (!hasTs && !hasMc && state.sawAssistant && state.text.includes(text)) return;
    state.text += text;
    state.sawAssistant = true;
    emitDelta(onEvent, options, "assistant", "assistant", text);
    return;
  }

  if (type === "tool_call") {
    const subtype = String(parsed.subtype || "");
    const call = parsed.tool_call || {};
    const callId = String(parsed.call_id || "").trim() || crypto.randomUUID();

    const planNode = asRecord(call.createPlanToolCall) || asRecord(call.create_plan);
    const askNode = asRecord(call.askQuestionToolCall) || asRecord(call.ask_question);
    if (planNode) {
      const plan = findApprovalPlan(planNode);
      if (plan && (subtype === "started" || subtype === "completed")) {
        const title = plan.name
          ? `批准 Cursor 计划：${plan.name}`
          : "批准 Cursor 执行计划？";
        const detailParts = [
          plan.overview || "",
          plan.plan,
          ...(plan.todos || []).map((todo) => `- [${todo.status || "pending"}] ${todo.content}`)
        ].filter(Boolean);
        emitCursorInteractiveApproval(options, state, onEvent, callId, "plan", {
          plan,
          title,
          detail: detailParts.join("\n\n").slice(0, 12_000)
        });
        emitDelta(
          onEvent,
          options,
          `stage:tool:${callId}`,
          "stage",
          subtype === "started" ? `\n▶ 生成计划（等待 Web 确认）\n` : `\n✓ 计划已就绪（等待 Web 确认）\n`
        );
        return;
      }
    }
    if (askNode) {
      const questions = findApprovalQuestions(askNode);
      // Title may sit in any container, same as the questions themselves.
      const titleFrom = approvalPayloadCandidates(askNode)
        .map((container) => String(container.title || "").trim())
        .find(Boolean);
      const title = titleFrom || "Cursor 需要你选择选项";
      // Emit on started only when the options are already complete — a sparse
      // started followed by an immediate kill used to leave the Web card with a
      // title and no options.
      if (questions.length > 0 && (subtype === "completed" || subtype === "started")) {
        const detail = questions
          .map((q) => `${q.prompt}\n${q.options.map((o) => `  - ${o.label}`).join("\n")}`)
          .join("\n\n")
          .slice(0, 12_000);
        emitCursorInteractiveApproval(options, state, onEvent, callId, "question", {
          questions,
          title,
          detail
        });
        emitDelta(
          onEvent,
          options,
          `stage:tool:${callId}`,
          "stage",
          subtype === "started" ? `\n▶ 提问选项（等待 Web 选择）\n` : `\n✓ 选项已就绪（等待 Web 选择）\n`
        );
        return;
      }
      if (subtype === "started") {
        emitDelta(
          onEvent,
          options,
          `stage:tool:${callId}`,
          "stage",
          `\n▶ 提问选项（等待完整选项…）\n`
        );
        return;
      }
      // Completed but no options parsed. Still surface a card so the turn is not
      // silently stuck, and include the raw payload — without it the user saw a
      // box with nothing in it and no way to tell what was being asked.
      if (subtype === "completed") {
        const message = approvalPayloadCandidates(askNode)
          .map((container) => String(container.prompt || container.question || container.message || "").trim())
          .find(Boolean);
        const raw = approvalRawSummary(askNode);
        const detail = [
          message || "未能解析选项列表。可直接拒绝后在终端确认，或让 Cursor 换一种提问方式重试。",
          ...(raw ? [`原始载荷：\n${raw}`] : [])
        ].join("\n\n").slice(0, 12_000);
        emitCursorInteractiveApproval(options, state, onEvent, callId, "question", {
          title,
          detail
        });
        emitDelta(
          onEvent,
          options,
          `stage:tool:${callId}`,
          "stage",
          `\n⚠ 提问选项未完整解析（等待 Web 确认）\n`
        );
        return;
      }
    }

    let label = "工具调用";
    if (call.writeToolCall?.args?.path) {
      label = subtype === "started"
        ? `写入 ${call.writeToolCall.args.path}`
        : `已写入 ${call.writeToolCall.args.path}`;
    } else if (call.readToolCall?.args?.path) {
      label = subtype === "started"
        ? `读取 ${call.readToolCall.args.path}`
        : `已读取 ${call.readToolCall.args.path}`;
    } else if (call.function?.name) {
      label = `调用 ${call.function.name}`;
    } else {
      // MCP / generic tool shapes
      const mcpName = call.mcpToolCall?.args?.name
        || call.mcp?.name
        || Object.keys(call).find((key) => key.endsWith("ToolCall"));
      if (mcpName) label = `调用 ${mcpName}`;
    }
    emitDelta(
      onEvent,
      options,
      `stage:tool:${parsed.call_id || label}`,
      "stage",
      subtype === "started" ? `\n▶ ${label}\n` : `\n✓ ${label}\n`
    );
    return;
  }

  if (type === "result") {
    state.gotResult = true;
    if (parsed.session_id) state.sessionId = String(parsed.session_id);
    if (parsed.is_error) {
      emitHeadlessErrorOnce(state, onEvent, options, String(parsed.result || parsed.error || "Cursor 运行失败"));
      return;
    }
    if (typeof parsed.result === "string" && parsed.result && !state.sawAssistant) {
      state.text = parsed.result;
      state.sawAssistant = true;
      emitDelta(onEvent, options, "assistant", "assistant", parsed.result);
    }
    const duration = Number(parsed.duration_ms || 0);
    const usage = normalizeContextUsage(
      parsed.usage ?? parsed.result?.usage ?? parsed.metrics ?? parsed,
      Number(parsed.context_window ?? parsed.contextWindow) || resolveModelContextWindow("cursor", options.model)
    );
    if (usage) {
      state.contextUsage = mergeContextUsage(state.contextUsage, usage);
      // Publish the accumulated snapshot rather than this single sample: a sparse
      // sample would leave older web clients (which replace instead of merging)
      // without the window size, blanking the context gauge until the next sync.
      onEvent({ type: "usage", threadId: options.threadId, contextUsage: state.contextUsage });
    }
    emitDelta(
      onEvent,
      options,
      "stage:result",
      "stage",
      duration > 0 ? `\n✓ Cursor 完成（${Math.round(duration / 1000)}s）\n` : "\n✓ Cursor 完成\n"
    );
  }
}

function handleGrokLine(
  line: string,
  options: HeadlessRunOptions,
  state: ParseState,
  onEvent: (event: BackendStreamEvent) => void
): void {
  state.lastProgressAt = Date.now();
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    emitDelta(onEvent, options, "cli-log", "cli-log", `${line}\n`);
    return;
  }
  captureReportedDiff(options.threadId, parsed);
  const type = String(parsed.type || "");
  const liveUsage = normalizeContextUsage(parsed.usage ?? parsed.response?.usage ?? parsed.result?.usage, Number(parsed.context_window ?? parsed.contextWindow) || resolveModelContextWindow("grok", options.model));
  if (liveUsage) {
    state.contextUsage = mergeContextUsage(state.contextUsage, liveUsage);
    onEvent({ type: "usage", threadId: options.threadId, contextUsage: state.contextUsage });
  }
  if (type === "text" && parsed.data != null) {
    state.text += String(parsed.data);
    state.sawAssistant = true;
    emitDelta(onEvent, options, "assistant", "assistant", String(parsed.data));
    return;
  }
  if (type === "thought" && parsed.data != null) {
    // Concise web mode hides thought tokens; emit a single visible stage so UI is not blank.
    if (!state.sawThoughtStage) {
      state.sawThoughtStage = true;
      emitDelta(onEvent, options, "stage:thinking", "stage", "\n… Grok 思考中\n");
    } else {
      const now = Date.now();
      // Heartbeat every ~8s so long thinking still looks alive.
      if (now - state.lastProgressAt > 8_000) {
        state.lastProgressAt = now;
        emitDelta(onEvent, options, "stage:thinking", "stage", "…");
      }
    }
    return;
  }
  if (type === "tool_call" || type === "tool" || type === "function_call") {
    const name = parsed.name || parsed.tool || parsed.function?.name || "tool";
    emitDelta(onEvent, options, `stage:tool:${name}`, "stage", `\n▶ 调用 ${name}\n`);
    return;
  }
  if (type === "end") {
    if (parsed.sessionId) state.sessionId = String(parsed.sessionId);
    const usage = normalizeContextUsage(
      parsed.usage ?? parsed.response?.usage ?? parsed.result?.usage ?? parsed.metrics ?? parsed,
      Number(parsed.context_window ?? parsed.contextWindow) || resolveModelContextWindow("grok", options.model)
    );
    if (usage) {
      state.contextUsage = mergeContextUsage(state.contextUsage, usage);
      // Publish the accumulated snapshot rather than this single sample: a sparse
      // sample would leave older web clients (which replace instead of merging)
      // without the window size, blanking the context gauge until the next sync.
      onEvent({ type: "usage", threadId: options.threadId, contextUsage: state.contextUsage });
    }
    if (!state.sawAssistant && typeof parsed.text === "string" && parsed.text) {
      state.text = parsed.text;
      state.sawAssistant = true;
      emitDelta(onEvent, options, "assistant", "assistant", parsed.text);
    }
    return;
  }
  if (type === "error") {
    emitHeadlessErrorOnce(
      state,
      onEvent,
      options,
      explainGrokSerializationError(String(parsed.message || "Grok 运行失败"))
    );
    return;
  }
  if (parsed.sessionId && !state.sessionId) state.sessionId = String(parsed.sessionId);
  if (typeof parsed.text === "string" && parsed.text && !state.sawAssistant) {
    state.text = parsed.text;
    state.sawAssistant = true;
    emitDelta(onEvent, options, "assistant", "assistant", parsed.text);
  }
}

function agyStepText(step: Record<string, unknown>): string {
  for (const key of ["text_delta", "text", "content", "response"]) {
    const value = step[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function isAgyNoiseLog(line: string): boolean {
  const value = stripAnsi(line);
  if (isCodexModelsManagerNoise(value)) return true;
  // agy glog spam — info/warn prefixed as "ERROR: logging before google.Init"
  // Keep real agent executor failures (handled separately via noteAgyStderrCause).
  if (/^ERROR:\s*logging before google\.Init:/i.test(value.trim())) {
    if (/agent executor error|error in generator|error encountered while processing planner|UNAUTHENTICATED|FAILED_PRECONDITION|User location is not supported|RESOURCE_EXHAUSTED|Individual quota|authentication required|not logged into Antigravity/i.test(value)) {
      return false;
    }
    return true;
  }
  return false;
}

/** True when Antigravity's grep_search cannot find the Unix `grep` binary (common on Windows). */
function isAgyMissingGrepError(line: string): boolean {
  const value = stripAnsi(line);
  return /CORTEX_STEP_TYPE_GREP_SEARCH|grep_search/i.test(value)
    && /exec:\s*"grep"|grep["']?:\s*executable file not found|not found in %PATH%/i.test(value);
}

function isAgyTrajectoryNotFound(text: string | undefined | null): boolean {
  const value = String(text || "");
  return /trajectory not found|conversation .+ not found|conversation_id.+not found/i.test(value);
}

function isAgyAuthError(text: string | undefined | null): boolean {
  const value = stripAnsi(String(text || ""));
  return /UNAUTHENTICATED|invalid authentication credentials|authentication (required|failed|timed out)|not logged in|not logged into Antigravity|please run \/login|please visit the url to log in|oauth 2 access token/i.test(value);
}

function isAgyLocationError(text: string | undefined | null): boolean {
  const value = stripAnsi(String(text || ""));
  return /user location is not supported|FAILED_PRECONDITION.*location|location is not supported for the API/i.test(value);
}

function isAgyQuotaError(text: string | undefined | null): boolean {
  const value = String(text || "");
  return /individual quota reached|quota reached|resource_exhausted|upgrade your subscription to increase your limits/i.test(value);
}

function isAgyGenericTerminated(text: string | undefined | null): boolean {
  const value = String(text || "");
  return /agent execution terminated due to error/i.test(value);
}

/** Pull the actionable Google/agy error out of a stderr/glog line. */
function extractAgyStderrCause(line: string): string | undefined {
  const value = stripAnsi(line);
  if (!value.trim()) return undefined;
  if (isAgyAuthError(value)) {
    return "Antigravity 登录凭证失效（UNAUTHENTICATED 401）。请在本机终端运行一次交互式 agy 重新登录后再试。";
  }
  if (isAgyLocationError(value)) {
    return "Antigravity API 拒绝当前出口地区（User location is not supported）。请切换代理到受支持地区后重试。";
  }
  if (isAgyQuotaError(value)) {
    const m = value.match(/Individual quota reached[^.]*\.?/i);
    return m?.[0] || "Antigravity 配额不足";
  }
  const executor = value.match(/agent executor error:\s*(.+)$/i)
    || value.match(/error in generator:\s*(.+)$/i)
    || value.match(/error encountered while processing planner output:\s*(.+)$/i);
  if (executor?.[1]) {
    const detail = executor[1].replace(/\s+/g, " ").trim();
    if (detail && !isAgyGenericTerminated(detail)) return detail.slice(0, 500);
  }
  return undefined;
}

function noteAgyStderrCause(state: ParseState, line: string): void {
  const cause = extractAgyStderrCause(line);
  if (cause) state.agyLastCause = cause;
}

function explainAgyFailure(
  errorText: string,
  state: ParseState,
  resultConversationId?: string,
  providerSessionId?: string
): string {
  const combined = [errorText, state.agyLastCause].filter(Boolean).join("\n");
  if (isAgyTrajectoryNotFound(combined)) {
    return `Antigravity 会话不存在（${resultConversationId || providerSessionId || "unknown"}）。将尝试新开会话。`;
  }
  if (isAgyLocationError(combined) || isAgyLocationError(state.agyLastCause)) {
    return state.agyLastCause
      || "Antigravity API 拒绝当前出口地区（User location is not supported）。请切换代理到受支持地区后重试。";
  }
  if (isAgyAuthError(combined) || isAgyAuthError(state.agyLastCause)) {
    return state.agyLastCause
      || "Antigravity 未登录或登录已过期。请在本机终端运行一次交互式 agy 完成登录后再试。";
  }
  if (isAgyQuotaError(combined)) {
    return `Antigravity 配额不足：${errorText || state.agyLastCause || ""}`.trim();
  }
  if (isAgyGenericTerminated(errorText) && state.agyLastCause) {
    return state.agyLastCause;
  }
  if (isAgyGenericTerminated(errorText)) {
    return "Antigravity 执行中断（未返回具体原因）。常见原因：登录失效、出口地区不受支持、或配额耗尽。请查看本机 ~/.gemini/antigravity-cli/log 最新日志，或重新登录后再试。";
  }
  return errorText || state.agyLastCause || "Antigravity 运行失败";
}

/**
 * Antigravity (and some other CLIs) shell out to Unix tools like `grep`.
 * On Windows, prepend Git for Windows' usr\bin when present so grep_search works.
 */
function withWindowsUnixToolPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return env;
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "usr", "bin")
  ];
  const extras = candidates.filter((dir) => {
    try {
      return fsExistsSync(path.join(dir, "grep.exe"));
    } catch {
      return false;
    }
  });
  if (!extras.length) return env;
  const sep = ";";
  const current = env.PATH || env.Path || process.env.PATH || "";
  const parts = current.split(sep).filter(Boolean);
  const merged = [...extras.filter((dir) => !parts.some((p) => p.toLowerCase() === dir.toLowerCase())), ...parts];
  return { ...env, PATH: merged.join(sep), Path: merged.join(sep) };
}

/** True when agy has a local brain/<id> directory for this conversation. */
export function agyConversationExists(conversationId: string | undefined | null): boolean {
  const id = String(conversationId || "").trim();
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return false;
  }
  try {
    return fsExistsSync(path.join(os.homedir(), ".gemini", "antigravity-cli", "brain", id));
  } catch {
    return false;
  }
}

/**
 * Resume id for `--conversation`. Never pass the AnytimeVibe web thread UUID —
 * that produces `trajectory not found` / spurious login prompts in headless print mode.
 */
export function resolveAgyConversationResumeId(
  providerSessionId: string | undefined | null,
  threadId?: string | undefined | null
): string | undefined {
  const id = String(providerSessionId || "").trim();
  if (!id) return undefined;
  const webId = String(threadId || "").trim();
  if (webId && id === webId && !agyConversationExists(id)) return undefined;
  if (!agyConversationExists(id)) return undefined;
  return id;
}

/** Stream incremental tokens; if agy later sends a fuller snapshot, only emit the missing suffix. */
function emitAgyAssistantText(
  state: ParseState,
  options: HeadlessRunOptions,
  onEvent: (event: BackendStreamEvent) => void,
  incoming: string
): void {
  if (!incoming) return;
  if (incoming === state.text) return;
  // Strip trailing replacement characters from accumulated text — they indicate
  // a multi-byte UTF-8 sequence was split across chunks and will be completed
  // by the next chunk.
  const cleanPrevious = state.text.replace(/\uFFFD+$/g, "");
  // Strip leading replacement characters from incoming — leftover partial bytes
  // from the previous chunk's incomplete multi-byte sequence.
  const cleanIncoming = incoming.replace(/^\uFFFD+/, "");
  if (cleanPrevious && cleanIncoming.startsWith(cleanPrevious)) {
    const extra = cleanIncoming.slice(cleanPrevious.length);
    state.text = cleanIncoming;
    state.sawAssistant = true;
    if (extra) emitDelta(onEvent, options, "assistant", "assistant", extra);
    return;
  }
  if (cleanPrevious && cleanPrevious.startsWith(cleanIncoming)) return;
  state.text = cleanIncoming || incoming;
  state.sawAssistant = true;
  const delta = cleanIncoming || incoming;
  if (delta) emitDelta(onEvent, options, "assistant", "assistant", delta);
}

function handleAntigravityLine(
  line: string,
  options: HeadlessRunOptions,
  state: ParseState,
  onEvent: (event: BackendStreamEvent) => void
): void {
  state.lastProgressAt = Date.now();
  const combined = `${state.agyJsonBuf || ""}${line}`.trim();
  let parsed: any;
  try {
    parsed = JSON.parse(combined);
    state.agyJsonBuf = "";
  } catch {
    if (combined.startsWith("{") && combined.length < 2_000_000) {
      state.agyJsonBuf = combined;
      return;
    }
    state.agyJsonBuf = "";
    if (isAgyNoiseLog(line)) return;
    emitDelta(onEvent, options, "cli-log", "cli-log", `${line}\n`);
    return;
  }
  captureReportedDiff(options.threadId, parsed);

  const eventName = String(parsed.event || "");
  // stream-json puts conversation_id on the top-level envelope for init/result.
  const topConversationId = String(parsed.conversation_id || "").trim();
  if (topConversationId) state.sessionId = topConversationId;

  if (eventName === "init") {
    const init = parsed.init && typeof parsed.init === "object" ? parsed.init : parsed;
    const conversationId = topConversationId || String(init.conversation_id || "").trim();
    if (conversationId) state.sessionId = conversationId;
    if (typeof init.model === "string" && init.model.trim()) state.model = init.model.trim();
    return;
  }

  if (eventName === "step_update") {
    const step = parsed.step_update && typeof parsed.step_update === "object" ? parsed.step_update : parsed;
    const conversationId = String(step.conversation_id || parsed.conversation_id || "").trim();
    if (conversationId) state.sessionId = conversationId;
    const stepType = String(step.step_type || "").toLowerCase();
    const usage = normalizeContextUsage(step.usage, resolveModelContextWindow("antigravity", options.model));
    if (usage) {
      state.contextUsage = mergeContextUsage(state.contextUsage, usage);
      // Publish the accumulated snapshot rather than this single sample: a sparse
      // sample would leave older web clients (which replace instead of merging)
      // without the window size, blanking the context gauge until the next sync.
      onEvent({ type: "usage", threadId: options.threadId, contextUsage: state.contextUsage });
    }
    if (stepType === "user_input" || stepType === "checkpoint") return;
    if (stepType === "tool") {
      const name = String(step.tool_name || step.tool_info?.name || "tool");
      const stepIndex = String(step.step_index ?? name);
      const toolKey = `${stepIndex}:${name}`;
      if (!state.agySeenTools) state.agySeenTools = new Set();
      if (state.agySeenTools.has(toolKey)) return;
      state.agySeenTools.add(toolKey);
      emitDelta(onEvent, options, `stage:tool:${name}`, "stage", `\n▶ 调用 ${name}\n`);
      return;
    }
    const incoming = agyStepText(step);
    if (incoming) emitAgyAssistantText(state, options, onEvent, incoming);
    return;
  }

  const result = eventName === "result"
    ? (parsed.result && typeof parsed.result === "object" ? parsed.result : parsed)
    : (parsed.status && (parsed.conversation_id || parsed.error) ? parsed : null);
  if (result) {
    state.gotResult = true;
    const resultConversationId = String(result.conversation_id || topConversationId || "").trim();
    const status = String(result.status || "").toUpperCase();
    const errorText = String(result.error || result.response || "").trim();
    if (status === "ERROR" || status === "INVALID") {
      // Do not persist a bogus resume id echoed back on trajectory-not-found errors.
      if (isAgyTrajectoryNotFound(errorText)) {
        if (options.providerSessionId && resultConversationId === options.providerSessionId) {
          state.sessionId = "";
        }
      } else if (resultConversationId && agyConversationExists(resultConversationId)) {
        state.sessionId = resultConversationId;
      }
      // Quota / auth / location errors after a full streamed reply: keep the answer, warn instead of wiping success.
      if (
        (isAgyQuotaError(errorText) || isAgyAuthError(errorText) || isAgyLocationError(errorText)
          || isAgyGenericTerminated(errorText) || isAgyAuthError(state.agyLastCause) || isAgyLocationError(state.agyLastCause))
        && state.sawAssistant
        && state.text.trim()
      ) {
        const warn = explainAgyFailure(errorText, state, resultConversationId, options.providerSessionId);
        emitDelta(onEvent, options, "stage:agy-soft-fail", "stage", `\n⚠ ${warn}\n`);
        const finalText = typeof result.response === "string" ? result.response : "";
        if (finalText && finalText !== errorText && !isAgyGenericTerminated(finalText)) {
          emitAgyAssistantText(state, options, onEvent, finalText);
        }
        return;
      }
      const message = explainAgyFailure(errorText, state, resultConversationId, options.providerSessionId);
      emitHeadlessErrorOnce(state, onEvent, options, message);
      return;
    }
    if (resultConversationId) state.sessionId = resultConversationId;
    const usage = normalizeContextUsage(result.usage, resolveModelContextWindow("antigravity", options.model));
    if (usage) {
      state.contextUsage = mergeContextUsage(state.contextUsage, usage);
      // Publish the accumulated snapshot rather than this single sample: a sparse
      // sample would leave older web clients (which replace instead of merging)
      // without the window size, blanking the context gauge until the next sync.
      onEvent({ type: "usage", threadId: options.threadId, contextUsage: state.contextUsage });
    }
    const finalText = typeof result.response === "string" ? result.response : agyStepText(result);
    if (finalText) emitAgyAssistantText(state, options, onEvent, finalText);
  }
}

export async function runHeadlessTurn(
  engine: Exclude<CliEngine, "codex">,
  options: HeadlessRunOptions,
  onEvent: (event: BackendStreamEvent) => void | Promise<void>
): Promise<HeadlessRunResult> {
  const existing = activeByThread.get(options.threadId);
  if (existing) {
    existing.interrupted = true;
    killChildTree(existing.child);
    activeByThread.delete(options.threadId);
  }

  // Serialize event delivery so publish sequence numbers stay ordered.
  let eventChain: Promise<void> = Promise.resolve();
  const safeOnEvent = (event: BackendStreamEvent) => {
    eventChain = eventChain.then(async () => {
      await onEvent(event);
    }).catch((error) => {
      console.error("headless event handler failed", error);
    });
  };

  let command = await resolveEngineBinary(engine);
  let cursorPrefixArgs: string[] = [];
  let cursorBinaryLabel = "";
  if (engine === "cursor") {
    const target = await resolveCursorSpawnTarget();
    if (target) {
      command = target.command;
      cursorPrefixArgs = target.prefixArgs;
      cursorBinaryLabel = cursorPrefixArgs.length
        ? `${target.command} + ${path.basename(cursorPrefixArgs[0] || "")}`
        : target.command;
    } else if (command) {
      cursorBinaryLabel = command;
    }
    // Final guard: never spawn Grok's identically named agent.exe as Cursor.
    if (command && /[/\\]\.grok[/\\]/i.test(command.replace(/\\/g, "/"))) {
      const message = `已拒绝使用 Grok 的 agent 二进制作为 Cursor（${command}）。请安装 Cursor Agent CLI（cursor-agent）或设置 CURSOR_COMMAND。`;
      safeOnEvent({ type: "error", threadId: options.threadId, message });
      safeOnEvent({ type: "turn.started", threadId: options.threadId, turnId: options.turnId, prompt: options.prompt });
      safeOnEvent({ type: "turn.completed", threadId: options.threadId, turnId: options.turnId, status: "failed" });
      await eventChain;
      return { providerSessionId: options.providerSessionId || options.threadId, status: "failed", text: message };
    }
  }
  if (!command) {
    const message = engine === "claude"
      ? "未找到 Claude Code CLI，请安装并确保 claude 在 PATH 中"
      : engine === "cursor"
        ? "未找到 Cursor Agent CLI（agent / cursor-agent）。请执行官方安装脚本并登录：irm https://cursor.com/install?win32=true | iex"
        : engine === "antigravity"
          ? "未找到 Antigravity CLI（agy）。请安装：irm https://antigravity.google/cli/install.ps1 | iex"
          : "未找到 Grok Build CLI，请安装并确保 grok 在 PATH 中";
    safeOnEvent({ type: "error", threadId: options.threadId, message });
    safeOnEvent({ type: "turn.started", threadId: options.threadId, turnId: options.turnId, prompt: options.prompt });
    safeOnEvent({ type: "turn.completed", threadId: options.threadId, turnId: options.turnId, status: "failed" });
    await eventChain;
    return { providerSessionId: options.providerSessionId || options.threadId, status: "failed", text: message };
  }

  // Avoid interactive trust prompt fallout (Claude folder trust; Codex dir trust for handoff parity).
  try {
    await ensureWorkspaceTrusted(engine, options.cwd);
  } catch {
    // ignore
  }

  const proxy = await collectLocalProxyEnv();
  if (engine === "cursor") {
    try {
      const enabledHttp1 = await ensureCursorHttp1ForProxy(proxy);
      if (enabledHttp1) {
        console.log("[headless] enabled Cursor network.useHttp1ForAgent for local proxy (GPT/stream)");
      }
    } catch (error) {
      console.warn("[headless] ensureCursorHttp1ForProxy failed:", error);
    }
  }
  // All headless cloud CLIs must egress via the system/Clash proxy:
  // - Cursor/Claude/Grok: egress IP gates Cursor's model catalog (China → kimi/glm).
  // - Antigravity (agy): OAuth token refresh + API talk to accounts.google.com /
  //   oauth2.googleapis.com, which are unreachable without the proxy in CN networks.
  //   Stripping the proxy made agy print "Authentication required" and fail headless
  //   turns with "authentication failed or timed out" (while handoff terminals — which
  //   inherit the system proxy — logged in fine). The AnytimeVibe local LLM gateway is
  //   wired through Codex's config.toml base_url, NOT HTTP_PROXY, so passing the system
  //   proxy here never routes agy at our loopback gateway.
  let env = await cloudProxyChildEnv({
    CI: process.env.CI || "1",
    TERM: process.env.TERM || "dumb",
    NO_COLOR: process.env.NO_COLOR || "1"
  });
  // Windows GUI PATH often omits Git usr\bin — Antigravity grep_search then hangs/fails on `grep`.
  if (engine === "antigravity") {
    env = withWindowsUnixToolPath(env);
  }

  // Per-turn disk credentials (CCSwitch / Cockpit 切号无需重启 AnytimeVibe):
  // - Claude: merge ~/.claude/settings.json env (ANTHROPIC_* / base_url)
  // - Grok: prefer config.toml api_key — strip stale process.env API keys that would override
  // - Cursor / Antigravity: fresh spawn reads ~/.cursor / ~/.gemini/antigravity-cli themselves
  env = await applyHeadlessDiskCredentials(engine, env);

  // Third-party Responses gateways often omit fields Grok CLI requires.
  let grokCompat: Awaited<ReturnType<typeof prepareGrokResponsesCompat>> = null;
  if (engine === "grok") {
    try {
      grokCompat = await prepareGrokResponsesCompat(env);
      if (grokCompat) {
        env = { ...env, ...grokCompat.env };
        emitDelta(
          safeOnEvent,
          options,
          "stage:grok-compat",
          "stage",
          "\n… 已启用 Grok Responses 兼容代理（补齐 created_at 等字段）\n"
        );
      }
    } catch (error) {
      console.warn("[headless] prepareGrokResponsesCompat failed:", error);
    }
  }

  const args = [...cursorPrefixArgs, ...buildArgs(engine, options, env)];
  // On Windows, npm global CLIs are often `claude.cmd` / extensionless shims.
  // CreateProcess cannot spawn those directly → ENOENT; always go through cmd.exe.
  // Cursor prefers node.exe+index.js (prefixArgs set) so the shim is usually skipped.
  const useCmdShim = cursorPrefixArgs.length === 0 && windowsNeedsCmdShim(command);
  const executable = useCmdShim ? (process.env.ComSpec ?? "cmd.exe") : command;
  const finalArgs = useCmdShim ? windowsCmdArguments(command, args) : args;

  const initialRunInfo = initialHeadlessRunInfo(engine, options, env, grokCompat?.endpoint);
  let reportedModel = initialRunInfo.model;

  if (!options.cursorResumeRetried && !options.agyConversationRetried) {
    safeOnEvent({ type: "turn.started", threadId: options.threadId, turnId: options.turnId, prompt: options.prompt });
  }
  safeOnEvent({ type: "turn.info", threadId: options.threadId, turnId: options.turnId, runInfo: initialRunInfo });
  const engineLabel = engine === "claude"
    ? "Claude Code"
    : engine === "cursor"
      ? "Cursor Agent"
      : engine === "antigravity"
        ? "Antigravity"
        : "Grok Build";
  emitDelta(
    safeOnEvent,
    options,
    `stage:${engine}`,
    "stage",
    `\n▶ 使用 ${engineLabel} 执行\n`
  );
  if (Object.keys(proxy).length) {
    const proxyNote = engine === "cursor"
      ? "\n… 已注入本机代理环境（NODE_USE_ENV_PROXY + HTTP/1.1 fallback）\n"
      : engine === "antigravity"
        ? "\n… 已注入本机代理环境（用于连接 Google 登录/接口）\n"
        : "\n… 已注入本机代理环境\n";
    emitDelta(safeOnEvent, options, "stage:proxy", "stage", proxyNote);
  }
  console.log(`[headless] spawn ${executable} ${finalArgs.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);

  // Use pipe+end for stdin (not "ignore") — some CLIs hang when stdin is a null device.
  const child = spawn(executable, finalArgs, {
    cwd: options.cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: useCmdShim,
    stdio: ["pipe", "pipe", "pipe"]
  });
  try {
    child.stdin?.end();
  } catch {
    // ignore
  }
  const runMeta: ActiveRun = { child, turnId: options.turnId, interrupted: false };
  activeByThread.set(options.threadId, runMeta);

  const state: ParseState = {
    // Do not seed Antigravity with an unverified resume id — ERROR echoes it back.
    sessionId: engine === "antigravity"
      ? (resolveAgyConversationResumeId(options.providerSessionId, options.threadId) || "")
      : (options.providerSessionId || ""),
    text: "",
    failed: false,
    errorMessage: "",
    emittedErrors: new Set(),
    sawAssistant: false,
    sawThoughtStage: false,
    lastProgressAt: Date.now(),
    gotResult: false,
    lineCount: 0
  };

  let result: HeadlessRunResult;
  try {
  result = await new Promise<HeadlessRunResult>((resolve) => {
    let settled = false;
    let resultGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const finish = (status: HeadlessRunResult["status"]) => {
      if (settled) return;
      settled = true;
      if (timeoutWatch) clearInterval(timeoutWatch);
      if (heartbeat) clearInterval(heartbeat);
      if (stallWatch) clearInterval(stallWatch);
      if (resultGraceTimer) clearTimeout(resultGraceTimer);
      activeByThread.delete(options.threadId);
      void grokCompat?.cleanup().catch(() => undefined);
      const captured = String(state.sessionId || "").trim();
      let providerSessionId = "";
      let clearProviderSession = false;
      if (engine === "antigravity") {
        const isWebUuid = Boolean(captured && captured === options.threadId);
        if (isWebUuid || isAgyTrajectoryNotFound(state.errorMessage || state.text)) {
          clearProviderSession = Boolean(options.providerSessionId);
          providerSessionId = "";
        } else if (captured && (agyConversationExists(captured) || status === "completed")) {
          // Trust agy-reported ids on success even if brain/ mkdir races slightly.
          providerSessionId = captured;
        } else {
          providerSessionId = resolveAgyConversationResumeId(options.providerSessionId, options.threadId) || "";
          if (!providerSessionId && options.providerSessionId) clearProviderSession = true;
        }
      } else if (engine === "cursor") {
        // Never persist the AnytimeVibe web thread UUID as a Cursor --resume id.
        const raw = captured || options.providerSessionId || "";
        providerSessionId = raw && raw !== options.threadId ? raw : (captured || "");
        if (options.providerSessionId && !providerSessionId) clearProviderSession = true;
      } else if (engine === "claude") {
        const notFound = state.claudeResumeInvalid
          || isClaudeSessionNotFound(state.errorMessage || state.text);
        if (notFound) {
          clearProviderSession = Boolean(options.providerSessionId);
          providerSessionId = "";
        } else {
          // Never persist the AnytimeVibe web thread UUID as a Claude --resume id.
          const raw = captured || options.providerSessionId || "";
          providerSessionId = raw && raw !== options.threadId ? raw : "";
          if (options.providerSessionId && !providerSessionId) clearProviderSession = true;
        }
      } else {
        providerSessionId = captured || options.providerSessionId || options.threadId;
      }
      resolve({
        providerSessionId,
        status,
        text: state.text || state.errorMessage,
        ...(clearProviderSession ? { clearProviderSession: true } : {}),
        ...(state.contextUsage ? { contextUsage: state.contextUsage } : {}),
        ...(state.model || options.model ? { model: state.model || options.model } : {})
      });
    };

    // Idle-based kill: long healthy runs OK while the CLI keeps streaming progress.
    // Absolute ceiling only as runaway protection (default 2h).
    const timeoutWatch = setInterval(() => {
      if (settled) return;
      if (state.gotResult) return; // Cursor result path owns teardown
      const idleMs = Date.now() - state.lastProgressAt;
      const elapsedMs = Date.now() - startedAt;
      if (idleMs >= HEADLESS_IDLE_TIMEOUT_MS) {
        const idleHint = engine === "antigravity"
          ? "（常见原因：grep_search 在 Windows 找不到 grep、run_command 子进程卡住、或模型长时间无 stream-json 输出）"
          : "";
        emitHeadlessErrorOnce(
          state,
          safeOnEvent,
          options,
          `${engineLabel} 超过 ${Math.round(HEADLESS_IDLE_TIMEOUT_MS / 1000)}s 无进度输出，已终止${idleHint}`,
          "stage:timeout"
        );
        killChildTree(child);
        finish("failed");
        return;
      }
      if (elapsedMs >= HEADLESS_MAX_TIMEOUT_MS) {
        emitHeadlessErrorOnce(
          state,
          safeOnEvent,
          options,
          `${engineLabel} 执行超过上限（${Math.round(HEADLESS_MAX_TIMEOUT_MS / 1000)}s），已终止`,
          "stage:timeout"
        );
        killChildTree(child);
        finish("failed");
      }
    }, 5_000);
    timeoutWatch.unref?.();

    // Periodic "still working" only when we have been idle (no stream progress).
    const heartbeat = setInterval(() => {
      if (settled) return;
      if (Date.now() - state.lastProgressAt < 18_000) return;
      emitDelta(
        safeOnEvent,
        options,
        "stage:heartbeat",
        "stage",
        `\n… ${engineLabel} 仍在执行…\n`
      );
    }, 20_000);

    // Cursor: known hang after `result` when MCP stdio children never close — force-finish.
    // Also detect zero-output stalls (bad --resume / reconnect loops).
    const stallWatch = engine === "cursor"
      ? setInterval(() => {
          if (settled) return;
          const idleMs = Date.now() - state.lastProgressAt;
          if (state.gotResult) return;
          if (state.lineCount === 0 && idleMs >= CURSOR_STALL_MS) {
            emitHeadlessErrorOnce(
              state,
              safeOnEvent,
              options,
              options.providerSessionId
                ? `Cursor 超过 ${Math.round(CURSOR_STALL_MS / 1000)}s 无输出（可能是损坏的 --resume 会话）。将尝试不带 resume 重跑。`
                : `Cursor 超过 ${Math.round(CURSOR_STALL_MS / 1000)}s 无输出，已终止。请检查登录（agent login）或网络。`,
              "stage:stall"
            );
            killChildTree(child);
            finish("failed");
          }
        }, 5_000)
      : null;

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
        if (engine === "claude") handleClaudeLine(line, options, state, safeOnEvent);
        else if (engine === "cursor") handleCursorLine(line, options, state, safeOnEvent);
        else if (engine === "antigravity") handleAntigravityLine(line, options, state, safeOnEvent);
        else handleGrokLine(line, options, state, safeOnEvent);
        if (state.model && state.model !== reportedModel) {
          reportedModel = state.model;
          safeOnEvent({
            type: "turn.info",
            threadId: options.threadId,
            turnId: options.turnId,
            runInfo: { ...initialRunInfo, model: state.model }
          });
        }
        if (
          state.sessionId
          && state.sessionId !== options.providerSessionId
          && state.sessionId !== options.threadId
        ) {
          safeOnEvent({ type: "session", threadId: options.threadId, providerSessionId: state.sessionId });
        }
        // Interactive plan/question: stop headless process so Web can choose, then --resume follow-up.
        if (engine === "cursor" && state.pauseForApproval && !settled && !runMeta.interrupted) {
          runMeta.interrupted = true;
          emitDelta(
            safeOnEvent,
            options,
            "stage:approval-wait",
            "stage",
            "\n… 等待网页确认计划/选项后继续\n"
          );
          killChildTree(child);
          finish("interrupted");
          return;
        }
        // After Cursor `result`, do not wait for process exit (MCP teardown hang).
        if (engine === "cursor" && state.gotResult && !resultGraceTimer && !settled) {
          resultGraceTimer = setTimeout(() => {
            if (settled) return;
            emitDelta(
              safeOnEvent,
              options,
              "stage:force-exit",
              "stage",
              "\n… Cursor 已返回结果，正在结束进程（避免 MCP 残留挂起）\n"
            );
            killChildTree(child);
            finish(state.failed ? "failed" : "completed");
          }, CURSOR_RESULT_EXIT_GRACE_MS);
        }
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
        state.lastProgressAt = Date.now();
        if (!line.trim()) return;
        if (engine === "antigravity") {
          noteAgyStderrCause(state, line);
          if (isAgyNoiseLog(line)) return;
          if (isAgyMissingGrepError(line)) {
            const warnKey = "agy-missing-grep";
            if (!state.emittedErrors.has(warnKey)) {
              state.emittedErrors.add(warnKey);
              emitDelta(
                safeOnEvent,
                options,
                "stage:agy-grep",
                "stage",
                "\n⚠ Antigravity 的 grep_search 需要本机 grep（Windows 请安装 Git for Windows，或把 Git\\usr\\bin 加入 PATH）。工具失败后可能长时间无 stream 进度…\n"
              );
            }
            return;
          }
          // Surface only actionable stderr causes; bury glog chatter.
          const cause = extractAgyStderrCause(line);
          if (cause) {
            emitDelta(safeOnEvent, options, "cli-log", "cli-log", `\n… ${cause}\n`);
          }
          return;
        }
        if (isCodexModelsManagerNoise(line)) return;
        if (engine === "claude" && isClaudeSessionNotFound(line)) {
          state.claudeResumeInvalid = true;
          state.sessionId = "";
          // Claude self-recovers after "No conversation found" (sidechain/sub-agent cleanup).
          // Do NOT mark the turn as failed here — the main process keeps running and the
          // task will complete normally. Show a soft stage note only.
          const warnKey = `claude-session-not-found`;
          if (!state.emittedErrors.has(warnKey)) {
            state.emittedErrors.add(warnKey);
            emitDelta(safeOnEvent, options, "stage:resume-warn", "stage", `\n… Claude 已重置会话（${line.trim()}），继续执行\n`);
          }
          return;
        }
        emitDelta(safeOnEvent, options, "cli-log", "cli-log", `${line}\n`);
      });
    }
    child.on("error", (error) => {
      if (runMeta.interrupted) {
        finish("interrupted");
        return;
      }
      emitHeadlessErrorOnce(state, safeOnEvent, options, error.message);
      finish("failed");
    });
    child.on("exit", (code, signal) => {
      // Windows taskkill often reports null signal + non-zero code — honor interrupt flag.
      if (runMeta.interrupted || signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGKILL") {
        // If we already got a Cursor result and force-killed, treat as completed.
        if (engine === "cursor" && state.gotResult && !state.failed && !state.pauseForApproval) {
          finish("completed");
          return;
        }
        if (state.pauseForApproval) {
          emitDelta(safeOnEvent, options, "stage:approval-wait", "stage", "\n… 已暂停，等待网页确认\n");
        } else {
          emitDelta(safeOnEvent, options, "stage:interrupt", "stage", "\n■ 已停止远程任务\n");
        }
        finish("interrupted");
        return;
      }
      // Explicit parse/runtime failure always wins.
      if (state.failed) {
        if (!state.errorMessage) {
          emitHeadlessErrorOnce(state, safeOnEvent, options, `${engineLabel} 运行失败`);
        }
        finish("failed");
        return;
      }
      // Cursor already finalized via result event.
      if (engine === "cursor" && state.gotResult) {
        finish("completed");
        return;
      }
      // Some CLIs (notably Grok) exit non-zero even after a full successful reply.
      // If we already streamed assistant text, treat as completed rather than poisoning the web UI.
      if (code !== 0 && code !== null) {
        if (state.sawAssistant && state.text.trim()) {
          emitDelta(
            safeOnEvent,
            options,
            "stage:exit",
            "stage",
            `\n… ${engineLabel} 退出码 ${code}（已收到完整回复，仍标记为成功）\n`
          );
          finish("completed");
          return;
        }
        if (!state.errorMessage) {
          emitHeadlessErrorOnce(
            state,
            safeOnEvent,
            options,
            engine === "claude"
              ? `Claude 退出码 ${code ?? "unknown"}（模型不可用时请设置 CLAUDE_MODEL，或在 Claude CLI 中切换模型；未登录请执行 claude auth login）`
              : engine === "cursor"
                ? `Cursor 退出码 ${code ?? "unknown"}（请确认已登录：agent login 或设置 CURSOR_API_KEY${cursorBinaryLabel ? `；实际二进制：${cursorBinaryLabel}` : ""}）`
                : engine === "antigravity"
                  ? `Antigravity 退出码 ${code ?? "unknown"}（若提示 trajectory/conversation not found，请清空错误会话后重试；未登录请在本机终端运行交互式 agy）`
                  : `Grok 退出码 ${code ?? "unknown"}`
          );
        }
        finish("failed");
        return;
      }
      finish("completed");
    });
  });

  // Cursor: one automatic retry without --resume when the first attempt stalled with no output.
  if (
    engine === "cursor"
    && result.status === "failed"
    && options.providerSessionId
    && !options.cursorResumeRetried
    && /不带 resume|损坏的 --resume|无输出/i.test(result.text || "")
  ) {
    emitDelta(
      safeOnEvent,
      options,
      "stage:retry",
      "stage",
      "\n… 正在不带 --resume 重试 Cursor 任务\n"
    );
    const { providerSessionId: _ignored, ...rest } = options;
    const retry = await runHeadlessTurn(engine, { ...rest, cursorResumeRetried: true }, onEvent);
    await eventChain;
    return retry;
  }

  // Antigravity: bogus --conversation (web thread UUID / deleted brain) → retry as a new session.
  if (
    engine === "antigravity"
    && result.status === "failed"
    && options.providerSessionId
    && !options.agyConversationRetried
    && isAgyTrajectoryNotFound(result.text)
  ) {
    emitDelta(
      safeOnEvent,
      options,
      "stage:retry",
      "stage",
      "\n… 会话 ID 无效，正在不带 --conversation 重试 Antigravity 任务\n"
    );
    const { providerSessionId: _ignored, ...rest } = options;
    const retry = await runHeadlessTurn(engine, { ...rest, agyConversationRetried: true }, onEvent);
    await eventChain;
    return retry;
  }

  // Claude: stale / cleaned / non-parent session id → retry without --resume.
  if (
    engine === "claude"
    && result.status === "failed"
    && options.providerSessionId
    && !options.claudeResumeRetried
    && (result.clearProviderSession || isClaudeSessionNotFound(result.text))
  ) {
    emitDelta(
      safeOnEvent,
      options,
      "stage:retry",
      "stage",
      "\n… Claude 会话 ID 无效或不存在，正在不带 --resume 重试\n"
    );
    const { providerSessionId: _ignored, ...rest } = options;
    const retry = await runHeadlessTurn(engine, { ...rest, claudeResumeRetried: true }, onEvent);
    await eventChain;
    return retry;
  }

  safeOnEvent({
    type: "turn.completed",
    threadId: options.threadId,
    turnId: options.turnId,
    status: result.status,
    ...(result.contextUsage ? { contextUsage: result.contextUsage } : {})
  });
  await eventChain;
  return result;
  } finally {
    void grokCompat?.cleanup().catch(() => undefined);
  }
}

export function interruptHeadlessThread(threadId: string): boolean {
  const active = activeByThread.get(threadId);
  if (!active) return false;
  active.interrupted = true;
  killChildTree(active.child);
  // Keep map entry until exit so the exit handler can read interrupted=true.
  return true;
}

/** Whether a headless CLI is currently running for this thread. */
export function isHeadlessThreadActive(threadId: string): boolean {
  return activeByThread.has(threadId);
}
