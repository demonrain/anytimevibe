import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { CliEngine, PermissionMode } from "@anytimevibe/protocol";
import { collectLocalProxyEnv, mergeProxyIntoEnv } from "../local-proxy";
import { windowsCmdArguments } from "../windows-command";
import { resolveEngineBinary } from "./detect";
import type { BackendStreamEvent, HeadlessRunOptions, HeadlessRunResult, StreamDeltaKind } from "./types";

type ActiveRun = {
  child: ChildProcess;
  turnId: string;
};

const activeByThread = new Map<string, ActiveRun>();

/** Default headless timeout (Claude rate-limit retries can take a while). */
const HEADLESS_TIMEOUT_MS = Number(process.env.ANYTIMEVIBE_HEADLESS_TIMEOUT_MS || 8 * 60_000);

function permissionArgs(engine: CliEngine, mode: PermissionMode): string[] {
  if (engine === "claude") {
    if (mode === "full-access") {
      return ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"];
    }
    if (mode === "read-only") {
      return ["--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep"];
    }
    return ["--permission-mode", "acceptEdits"];
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
    const model = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "sonnet";
    args.push(
      "-p", options.prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", model
    );
    // Only use --bare when API key is present (bare skips keychain/OAuth).
    if (process.env.ANTHROPIC_API_KEY) args.push("--bare");
    if (options.providerSessionId) args.push("--resume", options.providerSessionId);
    args.push(...permissionArgs(engine, options.permissionMode));
    return args;
  }
  const model = process.env.GROK_MODEL || process.env.XAI_MODEL;
  args.push(
    "-p", options.prompt,
    "--output-format", "streaming-json",
    "--cwd", options.cwd
  );
  if (model) args.push("--model", model);
  if (options.providerSessionId) args.push("--resume", options.providerSessionId);
  args.push(...permissionArgs(engine, options.permissionMode));
  return args;
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
      emitDelta(onEvent, options, "stage:init", "stage", "\n▶ Claude 会话初始化\n");
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
        state.text += String(block.text);
        state.sawAssistant = true;
        emitDelta(onEvent, options, "assistant", "assistant", String(block.text));
      }
    }
    return;
  }
  if (type === "result") {
    if (parsed.session_id) state.sessionId = String(parsed.session_id);
    if (typeof parsed.result === "string" && parsed.result) {
      if (!state.sawAssistant) {
        state.text = parsed.result;
        state.sawAssistant = true;
        emitDelta(onEvent, options, "assistant", "assistant", parsed.result);
      }
      if (parsed.is_error) {
        state.failed = true;
        state.errorMessage = parsed.result;
        onEvent({ type: "error", threadId: options.threadId, message: parsed.result });
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
    // Stream thinking as process log so users see progress even before final text.
    emitDelta(onEvent, options, "thought", "thought", String(parsed.data));
    return;
  }
  if (type === "end") {
    if (parsed.sessionId) state.sessionId = String(parsed.sessionId);
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
    try { existing.child.kill(); } catch { /* ignore */ }
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

  const args = buildArgs(engine, options);
  const isWindows = process.platform === "win32";
  const useCmdShim = isWindows && /\.cmd$/i.test(command);
  const executable = useCmdShim ? (process.env.ComSpec ?? "cmd.exe") : command;
  const finalArgs = useCmdShim ? windowsCmdArguments(command, args) : args;

  const proxy = await collectLocalProxyEnv();
  const env = mergeProxyIntoEnv(process.env, proxy);

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

  const child = spawn(executable, finalArgs, {
    cwd: options.cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: useCmdShim,
    stdio: ["ignore", "pipe", "pipe"]
  });
  activeByThread.set(options.threadId, { child, turnId: options.turnId });

  const state: ParseState = {
    sessionId: options.providerSessionId || "",
    text: "",
    failed: false,
    errorMessage: "",
    sawAssistant: false
  };

  const result = await new Promise<HeadlessRunResult>((resolve) => {
    let settled = false;
    const finish = (status: HeadlessRunResult["status"]) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      activeByThread.delete(options.threadId);
      resolve({
        providerSessionId: state.sessionId || options.providerSessionId || options.threadId,
        status,
        text: state.text || state.errorMessage
      });
    };

    const timeout = setTimeout(() => {
      state.failed = true;
      state.errorMessage = `${engine === "claude" ? "Claude" : "Grok"} 执行超时（${Math.round(HEADLESS_TIMEOUT_MS / 1000)}s），已终止`;
      safeOnEvent({ type: "error", threadId: options.threadId, message: state.errorMessage });
      try { child.kill(); } catch { /* ignore */ }
      finish("failed");
    }, HEADLESS_TIMEOUT_MS);

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
      state.failed = true;
      state.errorMessage = error.message;
      safeOnEvent({ type: "error", threadId: options.threadId, message: error.message });
      finish("failed");
    });
    child.on("exit", (code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGINT") {
        finish(state.failed ? "failed" : "interrupted");
        return;
      }
      if (state.failed || (code !== 0 && code !== null)) {
        if (!state.errorMessage) {
          state.errorMessage = engine === "claude"
            ? `Claude 退出码 ${code ?? "unknown"}（未登录请执行 claude auth login；限流会自动重试）`
            : `Grok 退出码 ${code ?? "unknown"}`;
          safeOnEvent({ type: "error", threadId: options.threadId, message: state.errorMessage });
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
    status: result.status
  });
  await eventChain;
  return result;
}

export function interruptHeadlessThread(threadId: string): boolean {
  const active = activeByThread.get(threadId);
  if (!active) return false;
  try {
    active.child.kill();
  } catch {
    // ignore
  }
  activeByThread.delete(threadId);
  return true;
}
