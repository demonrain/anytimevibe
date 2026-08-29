/**
 * Pi coding agent headless integration via official RPC mode.
 * @see https://pi.dev/docs/latest/rpc
 * @see https://pi.dev/docs/latest/usage
 */
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { ContextUsage, ReasoningEffort } from "@anytimevibe/protocol";
import { cloudProxyChildEnv, collectLocalProxyEnv } from "../local-proxy";
import { windowsCmdArguments, windowsNeedsCmdShim } from "../windows-command";
import { headlessPermissionArgs } from "./permission-args";
import type { BackendStreamEvent, HeadlessRunOptions, HeadlessRunResult } from "./types";
import { resolveEngineBinary } from "./detect";

const HEADLESS_MAX_TIMEOUT_MS = 45 * 60_000;

type ActivePiRun = {
  child: ChildProcess;
  turnId: string;
  interrupted: boolean;
};

const activeByThread = new Map<string, ActivePiRun>();

type PiRpcLine = Record<string, unknown>;

function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void
): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.trim()) onLine(line);
    }
  });
}

function writeRpc(child: ChildProcess, payload: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(payload)}\n`);
}

function parsePiModelRef(raw: string | undefined): { provider?: string; modelId?: string; thinking?: ReasoningEffort } {
  const text = String(raw || "").trim();
  if (!text) return {};
  const colonIdx = text.lastIndexOf(":");
  if (colonIdx > 0 && !text.includes("/")) {
    const maybeThinking = text.slice(colonIdx + 1).trim().toLowerCase();
    const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    if (levels.has(maybeThinking)) {
      return {
        modelId: text.slice(0, colonIdx).trim(),
        thinking: maybeThinking as ReasoningEffort
      };
    }
  }
  const slash = text.indexOf("/");
  if (slash > 0) {
    return { provider: text.slice(0, slash).trim(), modelId: text.slice(slash + 1).trim() };
  }
  return { modelId: text };
}

function contextUsageFromPi(event: PiRpcLine): ContextUsage | undefined {
  const usage = event.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = Number(u.input ?? u.inputTokens ?? 0);
  const output = Number(u.output ?? u.outputTokens ?? 0);
  const total = Number(u.totalTokens ?? input + output);
  if (!total && !input && !output) return undefined;
  return {
    inputTokens: input || undefined,
    outputTokens: output || undefined,
    totalTokens: total || undefined
  };
}

function buildPiSpawnArgs(options: HeadlessRunOptions): string[] {
  const args = ["--mode", "rpc", "--approve"];
  const resumeId = String(options.providerSessionId || "").trim();
  if (resumeId && resumeId !== options.threadId) {
    args.push("--session", resumeId);
  }
  const modelRef = parsePiModelRef(options.model);
  if (modelRef.provider) args.push("--provider", modelRef.provider);
  if (modelRef.modelId) args.push("--model", modelRef.modelId);
  const thinking = options.reasoningEffort || modelRef.thinking;
  if (thinking) args.push("--thinking", thinking);
  args.push(...headlessPermissionArgs("pi", options.permissionMode));
  return args;
}

export function interruptPiThread(threadId: string): boolean {
  const active = activeByThread.get(threadId);
  if (!active) return false;
  active.interrupted = true;
  try {
    writeRpc(active.child, { type: "abort" });
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      active.child.kill();
    } catch {
      // ignore
    }
  }, 800);
  return true;
}

export function isPiThreadActive(threadId: string): boolean {
  return activeByThread.has(threadId);
}

export async function runPiRpcTurn(
  options: HeadlessRunOptions,
  onEvent: (event: BackendStreamEvent) => Promise<void> | void
): Promise<HeadlessRunResult> {
  const binary = await resolveEngineBinary("pi");
  let eventChain: Promise<void> = Promise.resolve();
  const safeOnEvent = (event: BackendStreamEvent) => {
    eventChain = eventChain.then(async () => {
      await onEvent(event);
    }).catch((error) => {
      console.error("[pi-rpc] event handler failed", error);
    });
  };

  if (!binary) {
    const message = "未找到 Pi CLI（pi）。请安装：npm install -g --ignore-scripts @earendil-works/pi-coding-agent";
    safeOnEvent({ type: "error", threadId: options.threadId, message });
    safeOnEvent({ type: "turn.started", threadId: options.threadId, turnId: options.turnId, prompt: options.prompt });
    safeOnEvent({ type: "turn.completed", threadId: options.threadId, turnId: options.turnId, status: "failed" });
    await eventChain;
    return { providerSessionId: "", status: "failed", text: message };
  }

  const useCmdShim = windowsNeedsCmdShim(binary);
  const executable = useCmdShim ? (process.env.ComSpec ?? "cmd.exe") : binary;
  const spawnArgs = useCmdShim
    ? windowsCmdArguments(binary, buildPiSpawnArgs(options))
    : buildPiSpawnArgs(options);

  const proxy = await collectLocalProxyEnv();
  const env = await cloudProxyChildEnv({ ...process.env, ...proxy });

  safeOnEvent({
    type: "turn.info",
    threadId: options.threadId,
    turnId: options.turnId,
    runInfo: {
      engine: "pi",
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      endpoint: "pi-rpc"
    }
  });
  if (!options.piResumeRetried) {
    safeOnEvent({ type: "turn.started", threadId: options.threadId, turnId: options.turnId, prompt: options.prompt });
  }
  safeOnEvent({
    type: "delta",
    threadId: options.threadId,
    turnId: options.turnId,
    itemId: "stage:pi",
    kind: "stage",
    delta: "\n▶ 使用 Pi 执行（RPC 模式）\n"
  });

  const child = spawn(executable, spawnArgs, {
    cwd: options.cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: useCmdShim,
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcess;

  const runMeta: ActivePiRun = { child, turnId: options.turnId, interrupted: false };
  activeByThread.set(options.threadId, runMeta);

  let sessionId = String(options.providerSessionId || "").trim();
  let text = "";
  let failed = false;
  let errorMessage = "";
  let contextUsage: ContextUsage | undefined;
  let settled = false;
  const promptId = `pi-prompt-${options.turnId}`;

  const finishWaiters: Array<(result: HeadlessRunResult) => void> = [];

  attachJsonlReader(child.stdout!, (line) => {
    let parsed: PiRpcLine;
    try {
      parsed = JSON.parse(line) as PiRpcLine;
    } catch {
      return;
    }
    const type = String(parsed.type || "");

    if (type === "response") {
      const command = String(parsed.command || "");
      if (command === "prompt" && parsed.success === false) {
        failed = true;
        errorMessage = String((parsed as { error?: string }).error || "Pi prompt 被拒绝");
      }
      if (command === "get_state" && parsed.success === true) {
        const data = parsed.data as Record<string, unknown> | undefined;
        const sid = String(data?.sessionId || "").trim();
        if (sid) sessionId = sid;
      }
      return;
    }

    if (type === "message_update") {
      const usage = contextUsageFromPi(parsed);
      if (usage) contextUsage = usage;
      const deltaEvent = parsed.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!deltaEvent) return;
      const deltaType = String(deltaEvent.type || "");
      if (deltaType === "text_delta") {
        const delta = String(deltaEvent.delta || "");
        if (delta) {
          text += delta;
          safeOnEvent({
            type: "delta",
            threadId: options.threadId,
            turnId: options.turnId,
            itemId: "assistant",
            kind: "assistant",
            delta
          });
        }
      } else if (deltaType === "thinking_delta") {
        const delta = String(deltaEvent.delta || "");
        if (delta) {
          safeOnEvent({
            type: "delta",
            threadId: options.threadId,
            turnId: options.turnId,
            itemId: "thought",
            kind: "thought",
            delta
          });
        }
      }
      return;
    }

    if (type === "tool_execution_start") {
      const toolName = String(parsed.toolName || "tool");
      safeOnEvent({
        type: "delta",
        threadId: options.threadId,
        turnId: options.turnId,
        itemId: `tool:${parsed.toolCallId || toolName}`,
        kind: "exec",
        delta: `\n⚙ ${toolName}\n`
      });
      return;
    }

    if (type === "extension_error") {
      const message = String(parsed.message || parsed.error || "Pi extension error");
      failed = true;
      errorMessage = message;
      safeOnEvent({ type: "error", threadId: options.threadId, message });
      return;
    }

    if (type === "agent_settled") {
      settled = true;
      writeRpc(child, { type: "get_state", id: "get-state-final" });
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }, 400);
      return;
    }
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });

  const timeout = setTimeout(() => {
    if (!settled) {
      failed = true;
      errorMessage = "Pi RPC 超时";
      try {
        writeRpc(child, { type: "abort" });
        child.kill();
      } catch {
        // ignore
      }
    }
  }, HEADLESS_MAX_TIMEOUT_MS);
  timeout.unref?.();

  const resultPromise = new Promise<HeadlessRunResult>((resolve) => {
    finishWaiters.push(resolve);
  });

  child.on("error", (error) => {
    failed = true;
    errorMessage = error.message;
  });

  child.on("close", (code) => {
    clearTimeout(timeout);
    activeByThread.delete(options.threadId);
    if (!settled && !runMeta.interrupted && code !== 0 && !failed) {
      failed = true;
      errorMessage = stderr.trim() || `Pi RPC 退出码 ${code ?? "unknown"}`;
    }
    const status = runMeta.interrupted
      ? "interrupted"
      : failed
        ? "failed"
        : "completed";
    if (sessionId && sessionId !== options.threadId) {
      safeOnEvent({ type: "session", threadId: options.threadId, providerSessionId: sessionId });
    }
    if (contextUsage) {
      safeOnEvent({ type: "usage", threadId: options.threadId, contextUsage });
    }
    safeOnEvent({
      type: "turn.completed",
      threadId: options.threadId,
      turnId: options.turnId,
      status,
      ...(contextUsage ? { contextUsage } : {})
    });
    void eventChain.then(() => {
      for (const finish of finishWaiters.splice(0)) {
        finish({
          providerSessionId: sessionId && sessionId !== options.threadId ? sessionId : "",
          status,
          text,
          ...(contextUsage ? { contextUsage } : {}),
          ...(failed && !sessionId ? { clearProviderSession: Boolean(options.providerSessionId) } : {})
        });
      }
    });
  });

  // Bootstrap: optional model/thinking via RPC when spawn flags are insufficient.
  const modelRef = parsePiModelRef(options.model);
  if (modelRef.provider && modelRef.modelId) {
    writeRpc(child, {
      type: "set_model",
      provider: modelRef.provider,
      modelId: modelRef.modelId,
      id: "set-model"
    });
  }
  const thinking = options.reasoningEffort || modelRef.thinking;
  if (thinking) {
    writeRpc(child, { type: "set_thinking_level", level: thinking, id: "set-thinking" });
  }

  writeRpc(child, { type: "prompt", message: options.prompt, id: promptId });

  return resultPromise;
}

export function piDefaultSessionsRoot(): string {
  return path.join(os.homedir(), ".pi", "agent", "sessions");
}
