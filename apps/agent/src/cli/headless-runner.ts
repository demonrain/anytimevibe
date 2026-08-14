import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CliEngine, ContextUsage, PermissionMode } from "@anytimevibe/protocol";
import { cloudProxyChildEnv, collectLocalProxyEnv, ensureCursorHttp1ForProxy, stripProxyFromEnv } from "../local-proxy";
import { windowsCmdArguments, windowsNeedsCmdShim } from "../windows-command";
import { resolveCursorSpawnTarget, resolveEngineBinary } from "./detect";
import { formatAgySpawnArgs, formatCursorModelArg, parseCursorModelRef } from "./model-catalog";
import { explainGrokSerializationError, prepareGrokResponsesCompat } from "./grok-responses-compat";
import { headlessPermissionArgs } from "./permission-args";
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
} {
  const parsed = parseCursorModelRef(model);
  return {
    model: parsed.base,
    ...(parsed.fast !== undefined ? { fast: parsed.fast } : {}),
    ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {})
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
      || process.env.CLAUDE_MODEL
      || process.env.ANTHROPIC_MODEL
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
    if (childEnv.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY) args.push("--bare");
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
    const modelArg = formatCursorModelArg(hints.model, {
      ...(options.reasoningEffort || hints.reasoningEffort
        ? { reasoningEffort: options.reasoningEffort || hints.reasoningEffort }
        : {}),
      ...(hints.fast !== undefined ? { fast: hints.fast } : {})
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
      options.model || process.env.AGY_MODEL || process.env.ANTIGRAVITY_MODEL,
      options.reasoningEffort
    );
    args.push(
      "-p", options.prompt,
      "--output-format", "stream-json",
      "--print-timeout", printTimeout
    );
    if (spawn.model) args.push("--model", spawn.model);
    if (spawn.effort) args.push("--effort", spawn.effort);
    if (options.providerSessionId) args.push("--conversation", options.providerSessionId);
    args.push(...headlessPermissionArgs(engine, options.permissionMode));
    return args;
  }
  // Grok Build CLI (distinct binary: grok, not agent)
  const model = (options.model || process.env.GROK_MODEL || process.env.XAI_MODEL || "").trim();
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

function formatAgyPrintTimeout(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function usageFromUnknown(raw: unknown, contextWindow?: number): ContextUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const input = Number(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0) || 0;
  const output = Number(u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0) || 0;
  const total = Number(u.total_tokens ?? u.totalTokens ?? input + output) || input + output;
  const window = contextWindow || Number(u.context_window ?? u.contextWindow ?? 0) || undefined;
  // Optional subscription / rate-limit pool when CLI surfaces it.
  const planRemaining = Number(
    u.plan_remaining ?? u.planRemaining ?? u.rate_limit_remaining ?? u.rateLimitRemaining ?? 0
  ) || undefined;
  const planLimit = Number(
    u.plan_limit ?? u.planLimit ?? u.rate_limit_limit ?? u.rateLimitLimit ?? 0
  ) || undefined;
  const planLabelRaw = u.plan_label ?? u.planLabel ?? u.rate_limit_label ?? u.subscription;
  const planLabel = typeof planLabelRaw === "string" && planLabelRaw.trim()
    ? planLabelRaw.trim().slice(0, 80)
    : undefined;
  if (!input && !output && !total && planRemaining == null && !planLabel) return undefined;
  return {
    ...(input ? { inputTokens: input } : {}),
    ...(output ? { outputTokens: output } : {}),
    ...(total ? { totalTokens: total } : {}),
    ...(window ? { contextWindow: window } : {}),
    ...(window && total ? { remainingTokens: Math.max(0, window - total) } : {}),
    ...(planRemaining != null ? { planRemaining } : {}),
    ...(planLimit ? { planLimit } : {}),
    ...(planLabel ? { planLabel } : {})
  };
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
  const type = String(parsed.type || "");
  if (parsed.session_id) state.sessionId = String(parsed.session_id);

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
    if (parsed.session_id) state.sessionId = String(parsed.session_id);
    const usage = usageFromUnknown(parsed.usage, Number(parsed.context_window) || undefined);
    if (usage) {
      state.contextUsage = usage;
      onEvent({ type: "usage", threadId: options.threadId, contextUsage: usage });
    }
    if (typeof parsed.result === "string" && parsed.result) {
      if (parsed.is_error) {
        let message = parsed.result;
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
  const type = String(parsed.type || "");
  if (parsed.session_id) state.sessionId = String(parsed.session_id);

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

  if (type === "assistant") {
    // Cursor stream-json + --stream-partial-output (docs):
    // - timestamp_ms present, model_call_id absent → streaming delta (use)
    // - both present → pre-tool buffered flush (skip)
    // - both absent → final flush at end of turn (skip if already streamed)
    // Without partial mode, complete messages have neither field — accept each segment.
    const hasTs = Object.prototype.hasOwnProperty.call(parsed, "timestamp_ms");
    const hasMc = Object.prototype.hasOwnProperty.call(parsed, "model_call_id");
    if (hasTs && hasMc) return;
    const content = parsed.message?.content;
    const text = Array.isArray(content)
      ? content.map((block: any) => (block?.type === "text" ? String(block.text || "") : "")).join("")
      : "";
    if (!text) return;
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
      const args = asRecord(planNode.args) || asRecord(planNode.result) || planNode;
      const plan = normalizeApprovalPlan(args) || normalizeApprovalPlan(asRecord(args?.success) || args);
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
      const args = asRecord(askNode.args) || asRecord(askNode.result) || askNode;
      let questions = normalizeApprovalQuestions(args.questions);
      if (!questions.length) {
        questions = normalizeApprovalQuestions(asRecord(args.success)?.questions);
      }
      if (!questions.length) {
        questions = normalizeApprovalQuestions(askNode.questions);
      }
      // Prefer completed (full args). Emit on started only when questions are already complete —
      // empty started + immediate kill was leaving the Web card with title and no options.
      const ready = questions.length > 0;
      if (ready && (subtype === "completed" || subtype === "started")) {
        const title = String(args.title || askNode.title || "Cursor 需要你选择选项").trim()
          || "Cursor 需要你选择选项";
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
      // completed without parseable questions (e.g. headless synthetic skip) — still surface a card.
      if (subtype === "completed") {
        const title = String(args.title || askNode.title || "Cursor 需要你选择选项").trim()
          || "Cursor 需要你选择选项";
        const detail = String(
          args.prompt
          || asRecord(args.success)?.message
          || asRecord(askNode.result)?.message
          || ""
        ).trim() || "未能解析选项列表。请拒绝后在终端确认，或换一种提问方式重试。";
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
  const type = String(parsed.type || "");
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
    const usage = usageFromUnknown(parsed.usage, Number(parsed.context_window ?? parsed.contextWindow) || undefined);
    if (usage) {
      state.contextUsage = usage;
      onEvent({ type: "usage", threadId: options.threadId, contextUsage: usage });
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
  return /codex_models_manager|failed to refresh available models|failed to decode models response/i.test(line);
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
  if (state.text && incoming.startsWith(state.text)) {
    const extra = incoming.slice(state.text.length);
    state.text = incoming;
    state.sawAssistant = true;
    if (extra) emitDelta(onEvent, options, "assistant", "assistant", extra);
    return;
  }
  if (state.text && state.text.startsWith(incoming)) return;
  const previous = state.text.replace(/\uFFFD+$/g, "");
  if (previous && incoming.startsWith(previous) && incoming.length > previous.length) {
    const extra = incoming.slice(previous.length);
    state.text = incoming;
    state.sawAssistant = true;
    if (extra) emitDelta(onEvent, options, "assistant", "assistant", extra);
    return;
  }
  state.text += incoming;
  state.sawAssistant = true;
  emitDelta(onEvent, options, "assistant", "assistant", incoming);
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

  const eventName = String(parsed.event || "");
  if (eventName === "init") {
    const init = parsed.init && typeof parsed.init === "object" ? parsed.init : parsed;
    const conversationId = parsed.conversation_id || init.conversation_id;
    if (conversationId) state.sessionId = String(conversationId);
    if (typeof init.model === "string" && init.model.trim()) state.model = init.model.trim();
    return;
  }

  if (eventName === "step_update") {
    const step = parsed.step_update && typeof parsed.step_update === "object" ? parsed.step_update : parsed;
    const conversationId = step.conversation_id || parsed.conversation_id;
    if (conversationId) state.sessionId = String(conversationId);
    const stepType = String(step.step_type || "").toLowerCase();
    const usage = usageFromUnknown(step.usage);
    if (usage) {
      state.contextUsage = usage;
      onEvent({ type: "usage", threadId: options.threadId, contextUsage: usage });
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
    : (parsed.status && parsed.conversation_id ? parsed : null);
  if (result) {
    state.gotResult = true;
    if (result.conversation_id) state.sessionId = String(result.conversation_id);
    const usage = usageFromUnknown(result.usage);
    if (usage) {
      state.contextUsage = usage;
      onEvent({ type: "usage", threadId: options.threadId, contextUsage: usage });
    }
    const status = String(result.status || "").toUpperCase();
    if (status === "ERROR" || status === "INVALID") {
      emitHeadlessErrorOnce(
        state,
        onEvent,
        options,
        String(result.error || result.response || "Antigravity 运行失败")
      );
      return;
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
  // Cursor/Claude/Grok must egress via proxy (IP region gates Cursor model list).
  // Antigravity (agy) talks to Google; injecting the local Codex/Cursor gateway as HTTP_PROXY
  // makes agy hit /v1/models (gpt-5.6-sol) and truncates UTF-8 streams.
  let env = engine === "antigravity"
    ? stripProxyFromEnv({
      ...process.env,
      CI: process.env.CI || "1",
      TERM: process.env.TERM || "dumb",
      NO_COLOR: process.env.NO_COLOR || "1"
    })
    : await cloudProxyChildEnv({
      CI: process.env.CI || "1",
      TERM: process.env.TERM || "dumb",
      NO_COLOR: process.env.NO_COLOR || "1"
    });

  // CCSwitch / Cockpit rewrite ~/.claude/settings.json env on account switch.
  // Merge into the child so this turn uses the new key/base_url without restarting AnytimeVibe.
  if (engine === "claude") {
    try {
      const settingsRaw = await fs.readFile(path.join(os.homedir(), ".claude", "settings.json"), "utf8");
      const settings = JSON.parse(settingsRaw) as { env?: Record<string, string> };
      if (settings.env && typeof settings.env === "object") {
        for (const [key, value] of Object.entries(settings.env)) {
          if (typeof value === "string" && value.trim()) env[key] = value;
        }
      }
    } catch {
      // optional
    }
  }

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

  if (!options.cursorResumeRetried) {
    safeOnEvent({ type: "turn.started", threadId: options.threadId, turnId: options.turnId, prompt: options.prompt });
  }
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
  if (Object.keys(proxy).length && engine !== "antigravity") {
    const proxyNote = engine === "cursor"
      ? "\n… 已注入本机代理环境（NODE_USE_ENV_PROXY + HTTP/1.1 fallback）\n"
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
    sessionId: options.providerSessionId || "",
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
      resolve({
        providerSessionId: state.sessionId || options.providerSessionId || options.threadId,
        status,
        text: state.text || state.errorMessage,
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
        emitHeadlessErrorOnce(
          state,
          safeOnEvent,
          options,
          `${engineLabel} 超过 ${Math.round(HEADLESS_IDLE_TIMEOUT_MS / 1000)}s 无进度输出，已终止`,
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
        if (state.sessionId && state.sessionId !== options.providerSessionId) {
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
        if (!line.trim() || (engine === "antigravity" && isAgyNoiseLog(line))) return;
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
                  ? `Antigravity 退出码 ${code ?? "unknown"}（请先运行 agy 完成登录；模型请用 agy models）`
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
