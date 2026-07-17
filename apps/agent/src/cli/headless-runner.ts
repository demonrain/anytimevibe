import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { CliEngine, ContextUsage, PermissionMode } from "@anytimevibe/protocol";
import { collectLocalProxyEnv, mergeProxyIntoEnv } from "../local-proxy";
import { windowsCmdArguments, windowsNeedsCmdShim } from "../windows-command";
import { resolveEngineBinary } from "./detect";
import type { BackendStreamEvent, HeadlessRunOptions, HeadlessRunResult, StreamDeltaKind } from "./types";
import { ensureWorkspaceTrusted } from "./workspace-trust";

type ActiveRun = {
  child: ChildProcess;
  turnId: string;
  /** Set by interruptHeadlessThread; exit handler must treat as interrupted not failed. */
  interrupted: boolean;
};

const activeByThread = new Map<string, ActiveRun>();

/**
 * Kill the CLI process tree. On Windows headless spawns go through cmd.exe — bare
 * child.kill() only ends the shell and leaves claude/grok running.
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

/** Default headless timeout (Claude rate-limit retries can take a while). */
const HEADLESS_TIMEOUT_MS = Number(process.env.ANYTIMEVIBE_HEADLESS_TIMEOUT_MS || 8 * 60_000);

function permissionArgs(engine: CliEngine, mode: PermissionMode): string[] {
  if (engine === "claude") {
    // Headless must never stop on trust/permission prompts (workspace trust is pre-marked separately).
    if (mode === "full-access") {
      return ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"];
    }
    if (mode === "read-only") {
      return ["--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep"];
    }
    // acceptEdits still needs non-interactive safety for untrusted-folder edge cases
    return ["--permission-mode", "acceptEdits", "--dangerously-skip-permissions"];
  }
  // grok: always-approve so headless never blocks on TTY
  if (mode === "read-only") {
    return ["--permission-mode", "dontAsk", "--tools", "read_file,grep,list_dir"];
  }
  return ["--always-approve"];
}

function buildArgs(engine: CliEngine, options: HeadlessRunOptions): string[] {
  const args: string[] = [];
  if (engine === "claude") {
    // Prefer per-task model; fall back to env; never force offline "sonnet" aliases.
    const model = (options.model || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "").trim();
    args.push(
      "-p", options.prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages"
    );
    if (model) args.push("--model", model);
    if (options.reasoningEffort) args.push("--effort", options.reasoningEffort);
    // Only use --bare when API key is present (bare skips keychain/OAuth).
    if (process.env.ANTHROPIC_API_KEY) args.push("--bare");
    if (options.providerSessionId) args.push("--resume", options.providerSessionId);
    args.push(...permissionArgs(engine, options.permissionMode));
    return args;
  }
  const model = (options.model || process.env.GROK_MODEL || process.env.XAI_MODEL || "").trim();
  args.push(
    "-p", options.prompt,
    "--output-format", "streaming-json",
    "--cwd", options.cwd
  );
  if (model) args.push("--model", model);
  if (options.reasoningEffort && options.reasoningEffort !== "max") {
    // Grok uses --reasoning-effort; "max" maps to high for compatibility
    args.push("--reasoning-effort", options.reasoningEffort === "xhigh" ? "high" : options.reasoningEffort);
  } else if (options.reasoningEffort === "max" || options.reasoningEffort === "xhigh") {
    args.push("--reasoning-effort", "high");
  }
  if (options.providerSessionId) args.push("--resume", options.providerSessionId);
  args.push(...permissionArgs(engine, options.permissionMode));
  return args;
}

function usageFromUnknown(raw: unknown, contextWindow?: number): ContextUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const input = Number(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0) || 0;
  const output = Number(u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0) || 0;
  const total = Number(u.total_tokens ?? u.totalTokens ?? input + output) || input + output;
  const window = contextWindow || Number(u.context_window ?? u.contextWindow ?? 0) || undefined;
  if (!input && !output && !total) return undefined;
  return {
    ...(input ? { inputTokens: input } : {}),
    ...(output ? { outputTokens: output } : {}),
    ...(total ? { totalTokens: total } : {}),
    ...(window ? { contextWindow: window } : {}),
    ...(window && total ? { remainingTokens: Math.max(0, window - total) } : {})
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
  sawAssistant: boolean;
  sawThoughtStage: boolean;
  lastProgressAt: number;
  contextUsage?: ContextUsage;
  model?: string;
};

function handleClaudeLine(
  line: string,
  options: HeadlessRunOptions,
  state: ParseState,
  onEvent: (event: BackendStreamEvent) => void
): void {
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
    const delta = parsed.event?.delta;
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
  if (type === "assistant" && parsed.message?.content) {
    for (const block of parsed.message.content) {
      if (block?.type === "text" && block.text && !state.sawAssistant) {
        const text = String(block.text);
        // Synthetic assistant error payloads (auth / model offline)
        if (parsed.message?.model === "<synthetic>" || /API Error:|not logged in|已下线/i.test(text)) {
          state.failed = true;
          state.errorMessage = text;
          onEvent({ type: "error", threadId: options.threadId, message: text });
          emitDelta(onEvent, options, "stage:error", "stage", `\n✗ ${text}\n`);
        } else {
          state.text += text;
          state.sawAssistant = true;
          emitDelta(onEvent, options, "assistant", "assistant", text);
        }
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
        state.failed = true;
        state.errorMessage = parsed.result;
        // Common after interactive trust decline
        if (/trust|workspace|not.*allowed|permission/i.test(parsed.result)) {
          state.errorMessage = `${parsed.result}\n（若曾在接力终端拒绝信任目录，请在本机重新接力并选择信任，或删除该目录后重建任务）`;
        }
        onEvent({ type: "error", threadId: options.threadId, message: state.errorMessage });
        emitDelta(onEvent, options, "stage:error", "stage", `\n✗ ${state.errorMessage}\n`);
      } else if (!state.sawAssistant) {
        state.text = parsed.result;
        state.sawAssistant = true;
        emitDelta(onEvent, options, "assistant", "assistant", parsed.result);
      }
    } else if (parsed.is_error) {
      state.failed = true;
      state.errorMessage = "Claude 运行失败";
      onEvent({ type: "error", threadId: options.threadId, message: state.errorMessage });
    }
  }
}

function handleGrokLine(
  line: string,
  options: HeadlessRunOptions,
  state: ParseState,
  onEvent: (event: BackendStreamEvent) => void
): void {
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
    state.failed = true;
    state.errorMessage = String(parsed.message || "Grok 运行失败");
    onEvent({ type: "error", threadId: options.threadId, message: state.errorMessage });
    emitDelta(onEvent, options, "stage:error", "stage", `\n✗ ${state.errorMessage}\n`);
    return;
  }
  if (parsed.sessionId && !state.sessionId) state.sessionId = String(parsed.sessionId);
  if (typeof parsed.text === "string" && parsed.text && !state.sawAssistant) {
    state.text = parsed.text;
    state.sawAssistant = true;
    emitDelta(onEvent, options, "assistant", "assistant", parsed.text);
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

  const command = await resolveEngineBinary(engine);
  if (!command) {
    const message = engine === "claude"
      ? "未找到 Claude Code CLI，请安装并确保 claude 在 PATH 中"
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

  const args = buildArgs(engine, options);
  // On Windows, npm global CLIs are often `claude.cmd` / extensionless shims.
  // CreateProcess cannot spawn those directly → ENOENT; always go through cmd.exe.
  const useCmdShim = windowsNeedsCmdShim(command);
  const executable = useCmdShim ? (process.env.ComSpec ?? "cmd.exe") : command;
  const finalArgs = useCmdShim ? windowsCmdArguments(command, args) : args;

  const proxy = await collectLocalProxyEnv();
  const env = mergeProxyIntoEnv(
    {
      ...process.env,
      // Headless / non-TTY friendly
      CI: process.env.CI || "1",
      TERM: process.env.TERM || "dumb",
      NO_COLOR: process.env.NO_COLOR || "1"
    },
    proxy
  );

  safeOnEvent({ type: "turn.started", threadId: options.threadId, turnId: options.turnId, prompt: options.prompt });
  emitDelta(
    safeOnEvent,
    options,
    `stage:${engine}`,
    "stage",
    `\n▶ 使用 ${engine === "claude" ? "Claude Code" : "Grok Build"} 执行\n`
  );
  if (Object.keys(proxy).length) {
    emitDelta(safeOnEvent, options, "stage:proxy", "stage", "\n… 已注入本机代理环境\n");
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
    sawAssistant: false,
    sawThoughtStage: false,
    lastProgressAt: Date.now()
  };

  const result = await new Promise<HeadlessRunResult>((resolve) => {
    let settled = false;
    const finish = (status: HeadlessRunResult["status"]) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      activeByThread.delete(options.threadId);
      resolve({
        providerSessionId: state.sessionId || options.providerSessionId || options.threadId,
        status,
        text: state.text || state.errorMessage,
        ...(state.contextUsage ? { contextUsage: state.contextUsage } : {}),
        ...(state.model || options.model ? { model: state.model || options.model } : {})
      });
    };

    const timeout = setTimeout(() => {
      state.failed = true;
      state.errorMessage = `${engine === "claude" ? "Claude" : "Grok"} 执行超时（${Math.round(HEADLESS_TIMEOUT_MS / 1000)}s），已终止`;
      safeOnEvent({ type: "error", threadId: options.threadId, message: state.errorMessage });
      emitDelta(safeOnEvent, options, "stage:timeout", "stage", `\n✗ ${state.errorMessage}\n`);
      killChildTree(child);
      finish("failed");
    }, HEADLESS_TIMEOUT_MS);

    // Periodic "still working" stage so the web never looks frozen with zero events.
    const heartbeat = setInterval(() => {
      if (settled) return;
      emitDelta(
        safeOnEvent,
        options,
        "stage:heartbeat",
        "stage",
        `\n… ${engine === "claude" ? "Claude" : "Grok"} 仍在执行…\n`
      );
    }, 20_000);

    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (engine === "claude") handleClaudeLine(line, options, state, safeOnEvent);
        else handleGrokLine(line, options, state, safeOnEvent);
        if (state.sessionId && state.sessionId !== options.providerSessionId) {
          safeOnEvent({ type: "session", threadId: options.threadId, providerSessionId: state.sessionId });
        }
      });
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        if (line.trim()) emitDelta(safeOnEvent, options, "cli-log", "cli-log", `${line}\n`);
      });
    }
    child.on("error", (error) => {
      if (runMeta.interrupted) {
        finish("interrupted");
        return;
      }
      state.failed = true;
      state.errorMessage = error.message;
      safeOnEvent({ type: "error", threadId: options.threadId, message: error.message });
      finish("failed");
    });
    child.on("exit", (code, signal) => {
      // Windows taskkill often reports null signal + non-zero code — honor interrupt flag.
      if (runMeta.interrupted || signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGKILL") {
        emitDelta(safeOnEvent, options, "stage:interrupt", "stage", "\n■ 已停止远程任务\n");
        finish("interrupted");
        return;
      }
      if (state.failed || (code !== 0 && code !== null)) {
        if (!state.errorMessage) {
          state.errorMessage = engine === "claude"
            ? `Claude 退出码 ${code ?? "unknown"}（模型不可用时请设置 CLAUDE_MODEL，或在 Claude CLI 中切换模型；未登录请执行 claude auth login）`
            : `Grok 退出码 ${code ?? "unknown"}`;
          safeOnEvent({ type: "error", threadId: options.threadId, message: state.errorMessage });
          emitDelta(safeOnEvent, options, "stage:error", "stage", `\n✗ ${state.errorMessage}\n`);
        }
        finish("failed");
        return;
      }
      finish("completed");
    });
  });

  safeOnEvent({
    type: "turn.completed",
    threadId: options.threadId,
    turnId: options.turnId,
    status: result.status,
    ...(result.contextUsage ? { contextUsage: result.contextUsage } : {})
  });
  await eventChain;
  return result;
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
