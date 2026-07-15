import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { CliEngine, PermissionMode } from "@anytimevibe/protocol";
import { windowsCmdArguments } from "../windows-command";
import { resolveEngineCommand } from "./detect";
import type { BackendStreamEvent, HeadlessRunOptions, HeadlessRunResult, StreamDeltaKind } from "./types";

type ActiveRun = {
  child: ChildProcess;
  turnId: string;
};

const activeByThread = new Map<string, ActiveRun>();

function permissionArgs(engine: CliEngine, mode: PermissionMode): string[] {
  // Headless CLIs cannot easily surface interactive approval cards like Codex app-server.
  // Map product modes to closest non-interactive flags.
  if (engine === "claude") {
    if (mode === "full-access") return ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"];
    if (mode === "approve-for-me") return ["--permission-mode", "acceptEdits"];
    if (mode === "read-only") return ["--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep"];
    // ask-for-approval / default → acceptEdits so remote turns do not hang waiting for TTY
    return ["--permission-mode", "acceptEdits"];
  }
  // grok
  if (mode === "full-access") return ["--always-approve", "--permission-mode", "bypassPermissions"];
  if (mode === "approve-for-me") return ["--permission-mode", "acceptEdits"];
  if (mode === "read-only") return ["--permission-mode", "dontAsk", "--tools", "read_file,grep,list_dir,web_search"];
  return ["--permission-mode", "acceptEdits"];
}

function buildArgs(engine: CliEngine, options: HeadlessRunOptions): string[] {
  const args: string[] = [];
  if (engine === "claude") {
    args.push(
      "-p", options.prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--bare"
    );
    if (options.providerSessionId) args.push("--resume", options.providerSessionId);
    else if (options.preferredSessionId) args.push("--session-id", options.preferredSessionId);
    args.push(...permissionArgs(engine, options.permissionMode));
    return args;
  }
  // grok
  args.push(
    "-p", options.prompt,
    "--output-format", "streaming-json",
    "--cwd", options.cwd
  );
  if (options.providerSessionId) args.push("--resume", options.providerSessionId);
  else if (options.preferredSessionId) args.push("--session-id", options.preferredSessionId);
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

function handleClaudeLine(
  line: string,
  options: HeadlessRunOptions,
  state: { sessionId: string; text: string },
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
  if (type === "assistant" && parsed.message?.content) {
    for (const block of parsed.message.content) {
      if (block?.type === "text" && block.text) {
        // Prefer partial stream; still accept full blocks if no partials.
        if (!state.text) {
          state.text += String(block.text);
          emitDelta(onEvent, options, "assistant", "assistant", String(block.text));
        }
      }
    }
    return;
  }
  if (type === "result") {
    if (parsed.session_id) state.sessionId = String(parsed.session_id);
    if (typeof parsed.result === "string" && parsed.result && !state.text) {
      state.text = parsed.result;
      emitDelta(onEvent, options, "assistant", "assistant", parsed.result);
    }
    if (parsed.is_error) {
      const msg = typeof parsed.result === "string" ? parsed.result : "Claude 运行失败";
      onEvent({ type: "error", threadId: options.threadId, message: msg });
    }
    return;
  }
  if (type === "system" && parsed.subtype === "init") {
    emitDelta(onEvent, options, `stage:init`, "stage", "\n▶ Claude 会话初始化\n");
  }
}

function handleGrokLine(
  line: string,
  options: HeadlessRunOptions,
  state: { sessionId: string; text: string },
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
  if (type === "text" && parsed.data) {
    state.text += String(parsed.data);
    emitDelta(onEvent, options, "assistant", "assistant", String(parsed.data));
    return;
  }
  if (type === "thought" && parsed.data) {
    emitDelta(onEvent, options, "thought", "thought", String(parsed.data));
    return;
  }
  if (type === "end") {
    if (parsed.sessionId) state.sessionId = String(parsed.sessionId);
    return;
  }
  if (type === "error") {
    onEvent({ type: "error", threadId: options.threadId, message: String(parsed.message || "Grok 运行失败") });
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

  const command = resolveEngineCommand(engine);
  const args = buildArgs(engine, options);
  const isWindows = process.platform === "win32";
  const executable = isWindows ? process.env.ComSpec ?? "cmd.exe" : command;
  const finalArgs = isWindows ? windowsCmdArguments(command, args) : args;

  onEvent({ type: "turn.started", threadId: options.threadId, turnId: options.turnId, prompt: options.prompt });
  emitDelta(onEvent, options, `stage:${engine}`, "stage", `\n▶ 使用 ${engine === "claude" ? "Claude Code" : "Grok Build"} 执行\n`);

  const child = spawn(executable, finalArgs, {
    cwd: options.cwd,
    env: process.env,
    windowsHide: true,
    windowsVerbatimArguments: isWindows,
    stdio: ["ignore", "pipe", "pipe"]
  });
  activeByThread.set(options.threadId, { child, turnId: options.turnId });

  const state = {
    sessionId: options.providerSessionId || options.preferredSessionId || randomUUID(),
    text: ""
  };

  const result = await new Promise<HeadlessRunResult>((resolve) => {
    let settled = false;
    const finish = (status: HeadlessRunResult["status"]) => {
      if (settled) return;
      settled = true;
      activeByThread.delete(options.threadId);
      resolve({ providerSessionId: state.sessionId, status, text: state.text });
    };

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (engine === "claude") handleClaudeLine(line, options, state, onEvent);
      else handleGrokLine(line, options, state, onEvent);
      if (state.sessionId && state.sessionId !== options.providerSessionId) {
        onEvent({ type: "session", threadId: options.threadId, providerSessionId: state.sessionId });
      }
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) emitDelta(onEvent, options, "cli-log", "cli-log", `${line}\n`);
    });
    child.on("error", (error) => {
      onEvent({ type: "error", threadId: options.threadId, message: error.message });
      finish("failed");
    });
    child.on("exit", (code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGINT") {
        finish("interrupted");
        return;
      }
      finish(code === 0 ? "completed" : "failed");
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
