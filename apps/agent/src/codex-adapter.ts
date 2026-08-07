import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { windowsCmdArguments } from "./windows-command";
import type { PermissionMode } from "@anytimevibe/protocol";

type RpcId = string | number;
type JsonObject = Record<string, any>;

/** One-click install pin for Agent environment setup (floor; newer CLIs remain accepted). */
export const CODEX_INSTALL_PACKAGE = "@openai/codex@0.145.0";
/** Human-readable floor shown in UI / error messages. */
export const CODEX_COMPAT_LABEL = "≥ 0.144.0";

/**
 * True when local `codex --version` is new enough for app-server.
 * Accepts stable and prerelease strings such as `0.146.0-alpha.3.1`.
 * Floor is 0.144.0 — do not pin an upper bound so engine upgrades keep working.
 */
export function isCodexCompatibleVersion(version: string | undefined | null): boolean {
  if (!version) return false;
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 0) return true;
  if (major === 0 && minor >= 144) return true;
  return false;
}

/**
 * Map web permission mode to Codex app-server thread/turn params.
 * Labels match Codex CLI: Read Only / Ask for approval / Approve for me / Full Access.
 */
export function codexPermissionParams(permissionMode: PermissionMode = "ask-for-approval"): Record<string, string> {
  // Legacy aliases
  if (permissionMode === "inherit") return {};
  if (permissionMode === "workspace-write") {
    return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
  if (permissionMode === "full-access") return { approvalPolicy: "never", sandbox: "danger-full-access" };
  if (permissionMode === "approve-for-me") return { approvalPolicy: "never", sandbox: "workspace-write" };
  if (permissionMode === "ask-for-approval") return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  if (permissionMode === "read-only") return { approvalPolicy: "on-request", sandbox: "read-only" };
  return {};
}

export function threadStartParams(cwd: string, permissionMode: PermissionMode = "ask-for-approval"): { cwd: string; approvalPolicy?: string; sandbox?: string } {
  const policy = codexPermissionParams(permissionMode);
  return Object.keys(policy).length ? { cwd, ...policy } : { cwd };
}

/** Params for thread/resume — empty object when inheriting local client config. */
export function threadResumeParams(threadId: string, permissionMode: PermissionMode = "ask-for-approval"): Record<string, string> {
  const policy = codexPermissionParams(permissionMode);
  return Object.keys(policy).length ? { threadId, ...policy } : { threadId };
}

export class CodexAdapter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<RpcId, { resolve(value: any): void; reject(error: Error): void }>();

  constructor(
    private readonly codexCommand: string,
    private readonly onServerMessage: (message: JsonObject) => void,
    private readonly onExit: (detail: string) => void
  ) {}

  async start(): Promise<void> {
    if (this.process) return;
    const isWindows = process.platform === "win32";
    const executable = isWindows ? process.env.ComSpec ?? "cmd.exe" : this.codexCommand;
    const args = isWindows
      ? windowsCmdArguments(this.codexCommand, ["app-server", "--stdio"])
      : ["app-server", "--stdio"];
    const child = spawn(executable, args, {
      windowsHide: true,
      windowsVerbatimArguments: isWindows,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) this.onServerMessage({ method: "agent/log", params: { line } });
    });
    child.on("exit", (code, signal) => {
      this.process = null;
      const detail = `Codex app-server exited (${code ?? signal ?? "unknown"})`;
      for (const pending of this.pending.values()) pending.reject(new Error(detail));
      this.pending.clear();
      this.onExit(detail);
    });
    child.on("error", (error) => this.onExit(error.message));

    await this.request("initialize", {
      clientInfo: { name: "anytimevibe-agent", title: "随码", version: "0.4.23" },
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
    this.notify("initialized");
  }

  stop(): void {
    const child = this.process;
    this.process = null;
    if (!child) return;
    child.removeAllListeners("exit");
    child.removeAllListeners("error");
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Codex app-server stopped"));
    }
    this.pending.clear();
    try {
      child.kill();
    } catch {
      // ignore
    }
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    this.write({ method, id, ...(params === undefined ? {} : { params }) });
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, message: string): void {
    this.write({ id, error: { code: -32001, message } });
  }

  private write(message: JsonObject): void {
    if (!this.process) throw new Error("Codex app-server is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.onServerMessage({ method: "agent/log", params: { line } });
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed"));
      else pending.resolve(message.result);
      return;
    }
    this.onServerMessage(message);
  }
}

/** Normalize Codex timestamps (seconds or ms epoch) to unix seconds. */
export function normalizeUnixSeconds(value: unknown, fallback = Date.now() / 1000): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Milliseconds epoch (≈ year 2001+)
  if (n > 1e12) return n / 1000;
  return n;
}

/** Pull a human-readable error from a Codex turn / item payload. */
export function extractCodexTurnError(turn: JsonObject | undefined | null): string | undefined {
  if (!turn || typeof turn !== "object") return undefined;
  const direct = turn.error ?? turn.errorMessage ?? turn.message ?? turn.failureReason ?? turn.reason;
  if (typeof direct === "string" && direct.trim()) return explainCodexUpstreamError(direct.trim());
  if (direct && typeof direct === "object") {
    const nested = (direct as JsonObject).message ?? (direct as JsonObject).detail ?? (direct as JsonObject).text;
    if (typeof nested === "string" && nested.trim()) return explainCodexUpstreamError(nested.trim());
  }
  for (const item of turn.items ?? []) {
    const type = String(item?.type ?? "").toLowerCase();
    if (type === "error" || type === "systemerror" || type === "systemmessage" || type === "system") {
      const text = String(item.text ?? item.message ?? item.detail ?? "").trim();
      if (text) return explainCodexUpstreamError(text);
    }
    if (item?.error) {
      if (typeof item.error === "string" && item.error.trim()) return explainCodexUpstreamError(item.error.trim());
      if (typeof item.error === "object" && item.error) {
        const msg = String((item.error as JsonObject).message ?? (item.error as JsonObject).detail ?? "").trim();
        if (msg) return explainCodexUpstreamError(msg);
      }
    }
  }
  return undefined;
}

/**
 * Annotate opaque upstream transport failures (e.g. nginx 499) so users know this is
 * usually a client-side abort / timeout / provider mismatch — not an AnytimeVibe bug.
 */
export function explainCodexUpstreamError(message: string): string {
  const raw = String(message || "").trim();
  if (!raw) return raw;
  if (/status\s*499|Client Closed Request/i.test(raw)) {
    return [
      raw,
      "",
      "说明：HTTP 499 表示 Codex 作为客户端提前断开了上游请求（常见：推理过久被超时/代理掐断、app-server 中途重启、或 model_provider 与本机 CLI 不一致）。",
      "请确认 ~/.codex/config.toml 的 model_provider 与 CLI 一致、本地网关端口可达，并先试用较低的 reasoning effort。"
    ].join("\n");
  }
  if (/ECONNREFUSED|connection refused|Failed to connect|tcp connect error/i.test(raw)) {
    return [
      raw,
      "",
      "说明：连不上模型供应商地址。若使用 codex_local_access，请先启动本机网关后再从随码下发任务。"
    ].join("\n");
  }
  return raw;
}

export function isTerminalTurnStatus(status: string): boolean {
  const normalized = status.toLowerCase().replace(/[\s_-]/g, "");
  return (
    normalized === "completed"
    || normalized === "complete"
    || normalized === "success"
    || normalized === "succeeded"
    || normalized === "failed"
    || normalized === "error"
    || normalized === "systemerror"
    || normalized.includes("error")
    || normalized.includes("fail")
    || normalized === "interrupted"
    || normalized === "cancelled"
    || normalized === "canceled"
    || normalized === "stopped"
  );
}

export function threadToSnapshot(thread: JsonObject) {
  const messages: Array<{ id: string; role: "user" | "assistant" | "system"; text: string; createdAt?: number }> = [];
  const turns = thread.turns ?? [];
  let lastActivity = 0;
  let lastTurnStatus = "";
  let lastTurnError: string | undefined;
  for (const turn of turns) {
    const started = normalizeUnixSeconds(turn.startedAt, 0);
    const completed = normalizeUnixSeconds(turn.completedAt, 0);
    lastActivity = Math.max(lastActivity, started, completed);
    const turnStatus = String(turn.status ?? "");
    if (turnStatus) lastTurnStatus = turnStatus;
    const turnError = extractCodexTurnError(turn);
    if (turnError) lastTurnError = turnError;
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = (item.content ?? []).filter((content: JsonObject) => content.type === "text").map((content: JsonObject) => content.text).join("\n");
        if (text) {
          messages.push({
            id: item.id,
            role: "user",
            text,
            ...(started ? { createdAt: started } : {})
          });
        }
      }
      if (item.type === "agentMessage" && item.text) {
        messages.push({
          id: item.id,
          role: "assistant",
          text: item.text,
          ...(completed || started ? { createdAt: completed || started } : {})
        });
      }
      if (item.type === "plan" && item.text) messages.push({ id: item.id, role: "system", text: item.text });
      const itemType = String(item.type ?? "").toLowerCase();
      if (itemType === "error" || itemType === "systemerror" || itemType === "systemmessage") {
        const text = String(item.text ?? item.message ?? item.detail ?? "").trim();
        if (text) {
          messages.push({
            id: String(item.id || `error:${messages.length}`),
            role: "system",
            text: text.startsWith("错误") || text.startsWith("Error") ? text : `错误：${text}`,
            ...(completed || started ? { createdAt: completed || started } : {})
          });
        }
      }
    }
    // Surface terminal failure when Codex only sets turn.status without an error item.
    if (isTerminalTurnStatus(turnStatus) && /error|fail/i.test(turnStatus) && turnError) {
      const already = messages.some((m) => m.role === "system" && m.text.includes(turnError));
      if (!already) {
        messages.push({
          id: `turn-error:${String(turn.id || completed || messages.length)}`,
          role: "system",
          text: `任务失败（${turnStatus}）：${turnError}`,
          ...(completed || started ? { createdAt: completed || started } : {})
        });
      }
    }
  }
  const activeTurn = [...turns].reverse().find((turn: JsonObject) => {
    const status = String(turn.status ?? "").toLowerCase();
    return turn.id && !turn.completedAt && !isTerminalTurnStatus(status);
  });
  const createdAt = normalizeUnixSeconds(thread.createdAt);
  // Prefer explicit thread.updatedAt, else last turn activity, else createdAt — never invent "now" for idle history.
  const updatedAt = Math.max(
    normalizeUnixSeconds(thread.updatedAt, 0),
    lastActivity,
    createdAt
  );
  // Prefer absolute working directory from app-server (subdir tasks keep full path).
  const rawCwd = String(thread.cwd || thread.workingDirectory || thread.workdir || "").trim();
  const rawStatus = typeof thread.status === "string"
    ? thread.status
    : JSON.stringify(thread.status ?? "unknown");
  // Prefer last turn status when thread-level status is vague but the turn ended in systemerror/failed.
  const status = (/unknown|active|running/i.test(rawStatus) && lastTurnStatus && isTerminalTurnStatus(lastTurnStatus))
    ? lastTurnStatus
    : rawStatus;
  // If still no system error bubble but we know the failure reason, append one.
  if (isTerminalTurnStatus(status) && /error|fail/i.test(status) && lastTurnError) {
    const already = messages.some((m) => m.role === "system" && m.text.includes(lastTurnError));
    if (!already) {
      messages.push({
        id: `thread-error:${String(thread.id)}`,
        role: "system",
        text: `任务失败（${status}）：${lastTurnError}`
      });
    }
  }
  return {
    threadId: String(thread.id),
    title: String(thread.name || thread.preview || "未命名任务"),
    cwd: rawCwd,
    status,
    ...(activeTurn ? { activeTurnId: String(activeTurn.id) } : {}),
    createdAt,
    updatedAt,
    messages
  };
}
