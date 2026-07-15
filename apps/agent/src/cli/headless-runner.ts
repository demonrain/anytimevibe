import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { CliEngine, PermissionMode } from "@anytimevibe/protocol";
import { windowsCmdArguments } from "../windows-command";
import { resolveEngineBinary } from "./detect";
import type { BackendStreamEvent, HeadlessRunOptions, HeadlessRunResult, StreamDeltaKind } from "./types";

type ActiveRun = {
  child: ChildProcess;
  turnId: string;
};

const activeByThread = new Map<string, ActiveRun>();

function permissionArgs(engine: CliEngine, mode: PermissionMode): string[] {
  // Headless remote runs must not block on TTY permission prompts.
  if (engine === "claude") {
    if (mode === "full-access") {
      return ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"];
    }
    if (mode === "read-only") {
      return ["--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep"];
    }
    // acceptEdits for remaining modes
    return ["--permission-mode", "acceptEdits"];
  }
  // grok: always-approve for unattended agent use (acceptEdits alone can hang without TTY)
  if (mode === "read-only") {
    return ["--permission-mode", "dontAsk", "--tools", "read_file,grep,list_dir,web_search"];
  }
  if (mode === "full-access" || mode === "approve-for-me" || mode === "ask-for-approval") {
    return ["--always-approve"];
  }
  return ["--always-approve"];
}

function buildArgs(engine: CliEngine, options: HeadlessRunOptions): string[] {
  const args: string[] = [];
  if (engine === "claude") {
    // Do not force --session-id on create: Claude assigns one and returns it.
    args.push(
      "-p", options.prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages"
    );
    // --bare skips OAuth/keychain; only use when ANTHROPIC_API_KEY is set.
    if (process.env.ANTHROPIC_API_KEY) args.push("--bare");
    if (options.providerSessionId) args.push("--resume", options.providerSessionId);
    args.push(...permissionArgs(engine, options.permissionMode));
    return args;
  }
  // grok — never force client-chosen session id on first turn; resume only when we have one.
  args.push(
    "-p", options.prompt,
    "--output-format", "streaming-json",
    "--cwd", options.cwd
  );
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
  if (type === "stream_event") {
    const delta = parsed.event?.delta;
    if (delta?.type === "text_delta" && delta.text) {
      state.text += String(delta.text);
      emitDelta(onEvent, options, "assistant", "assistant", String(delta.text));
    }
    return;
  }
  if (type === "content_block_delta" && parsed.delta?.text) {
    state.text += String(parsed.delta.text);
    emitDelta(onEvent, options, "assistant", "assistant", String(parsed.delta.text));
    return;
  }
  if (type === "assistant" && parsed.message?.content) {
    for (const block of parsed.message.content) {
      if (block?.type === "text" && block.text) {
        if (!state.text.includes(String(block.text))) {
          // Prefer partials; still accept if only full blocks arrive.
          if (!state.text) {
            state.text += String(block.text);
            emitDelta(onEvent, options, "assistant", "assistant", String(block.text));
          }
        }
      }
    }
    return;
  }
  if (type === "result") {
    if (parsed.session_id) state.sessionId = String(parsed.session_id);
    if (typeof parsed.result === "string" && parsed.result) {
      if (!state.text) {
        state.text = parsed.result;
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
    return;
  }
  if (type === "system" && parsed.subtype === "init") {
    emitDelta(onEvent, options, "stage:init", "stage", "\n▶ Claude 会话初始化\n");
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
    emitDelta(onEvent, options, "assistant", "assistant", String(parsed.data));
    return;
  }
  if (type === "thought" && parsed.data != null) {
    emitDelta(onEvent, options, "thought", "thought", String(parsed.data));
    return;
  }
  if (type === "end") {
    if (parsed.sessionId) state.sessionId = String(parsed.sessionId);
    // Some builds only put final text on end
    if (!state.text && typeof parsed.text === "string" && parsed.text) {
      state.text = parsed.text;
      emitDelta(onEvent, options, "assistant", "assistant", parsed.text);
    }
    return;
  }
  if (type === "error") {
    state.failed = true;
    state.errorMessage = String(parsed.message || "Grok 运行失败");
    onEvent({ type: "error", threadId: options.threadId, message: state.errorMessage });
  }
  // json single-object mode fallback fields
  if (parsed.sessionId && !state.sessionId) state.sessionId = String(parsed.sessionId);
  if (typeof parsed.text === "string" && parsed.text && type !== "text" && !state.text) {
    state.text = parsed.text;
    emitDelta(onEvent, options, "assistant", "assistant", parsed.text);
  }
}

export async function runHeadlessTurn(
  engine: Exclude<CliEngine, "codex">,
  options: HeadlessRunOptions,
  onEvent: (event: BackendStreamEvent) => void
): Promise<HeadlessRunResult> {
  const existing = activeByThread.get(options.threadId);
  if (existing) {
    try { existing.child.kill(); } catch { /* ignore */ }
    activeByThread.delete(options.threadId);
  }

  const command = await resolveEngineBinary(engine);
  if (!command) {
    const message = engine === "claude"
      ? "未找到 Claude Code CLI，请安装并确保 claude 在 PATH 中"
      : "未找到 Grok Build CLI，请安装并确保 grok 在 PATH 中";
    onEvent({ type: "error", threadId: options.threadId, message });
    onEvent({ type: "turn.started", threadId: options.threadId, turnId: options.turnId, prompt: options.prompt });
    onEvent({ type: "turn.completed", threadId: options.threadId, turnId: options.turnId, status: "failed" });
    return { providerSessionId: options.providerSessionId || options.threadId, status: "failed", text: message };
  }

  const args = buildArgs(engine, options);
  const isWindows = process.platform === "win32";
  // Prefer direct spawn of the absolute binary; fall back to cmd only for .cmd shims.
  const useCmdShim = isWindows && /\.cmd$/i.test(command);
  const executable = useCmdShim ? (process.env.ComSpec ?? "cmd.exe") : command;
  const finalArgs = useCmdShim ? windowsCmdArguments(command, args) : args;

  onEvent({ type: "turn.started", threadId: options.threadId, turnId: options.turnId, prompt: options.prompt });
  emitDelta(
    onEvent,
    options,
    `stage:${engine}`,
    "stage",
    `\n▶ 使用 ${engine === "claude" ? "Claude Code" : "Grok Build"} 执行\n`
  );

  const child = spawn(executable, finalArgs, {
    cwd: options.cwd,
    env: { ...process.env },
    windowsHide: true,
    windowsVerbatimArguments: useCmdShim,
    stdio: ["ignore", "pipe", "pipe"]
  });
  activeByThread.set(options.threadId, { child, turnId: options.turnId });

  const state: ParseState = {
    sessionId: options.providerSessionId || "",
    text: "",
    failed: false,
    errorMessage: ""
  };

  const result = await new Promise<HeadlessRunResult>((resolve) => {
    let settled = false;
    const finish = (status: HeadlessRunResult["status"]) => {
      if (settled) return;
      settled = true;
      activeByThread.delete(options.threadId);
      resolve({
        providerSessionId: state.sessionId || options.providerSessionId || options.threadId,
        status,
        text: state.text || state.errorMessage
      });
    };

    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (engine === "claude") handleClaudeLine(line, options, state, onEvent);
        else handleGrokLine(line, options, state, onEvent);
        if (state.sessionId && state.sessionId !== options.providerSessionId) {
          onEvent({ type: "session", threadId: options.threadId, providerSessionId: state.sessionId });
        }
      });
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        if (line.trim()) emitDelta(onEvent, options, "cli-log", "cli-log", `${line}\n`);
      });
    }
    child.on("error", (error) => {
      state.failed = true;
      state.errorMessage = error.message;
      onEvent({ type: "error", threadId: options.threadId, message: error.message });
      finish("failed");
    });
    child.on("exit", (code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGINT") {
        finish("interrupted");
        return;
      }
      if (state.failed || (code !== 0 && code !== null)) {
        if (!state.errorMessage && state.text) state.errorMessage = state.text;
        if (!state.errorMessage) {
          state.errorMessage = engine === "claude"
            ? `Claude 退出码 ${code ?? "unknown"}（若未登录请在电脑端执行 claude auth login）`
            : `Grok 退出码 ${code ?? "unknown"}`;
          onEvent({ type: "error", threadId: options.threadId, message: state.errorMessage });
        }
        finish("failed");
        return;
      }
      finish("completed");
    });
  });

  onEvent({
    type: "turn.completed",
    threadId: options.threadId,
    turnId: options.turnId,
    status: result.status
  });
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
