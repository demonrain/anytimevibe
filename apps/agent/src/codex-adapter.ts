import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { windowsCmdArguments } from "./windows-command";
import { localGatewayChildEnv } from "./local-proxy";
import { isCodexModelsManagerNoise } from "./cli/log-noise";
import { resolveCodexOpenaiBaseUrlForEnv, resolveCodexRelayApiKeyForEnv } from "./cli/codex-gateway";
import type { PermissionMode } from "@anytimevibe/protocol";
import { PRODUCT_VERSION } from "@anytimevibe/protocol";

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
    const baseEnv = localGatewayChildEnv(process.env);
    // Sticky openai threads / ApiKey mode still honor OPENAI_BASE_URL for the built-in
    // provider when config.toml openai_base_url alone is flaky across Codex versions.
    try {
      const openaiBase = await resolveCodexOpenaiBaseUrlForEnv();
      if (openaiBase) {
        baseEnv.OPENAI_BASE_URL = openaiBase;
        baseEnv.openai_base_url = openaiBase;
      }
      const relayKey = await resolveCodexRelayApiKeyForEnv();
      if (relayKey) {
        baseEnv.OPENAI_API_KEY = relayKey;
      }
    } catch {
      // optional
    }
    const child = spawn(executable, args, {
      windowsHide: true,
      windowsVerbatimArguments: isWindows,
      stdio: ["pipe", "pipe", "pipe"],
      // Local Codex gateway only — never inherit Clash HTTP_PROXY.
      env: baseEnv
    });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (!line.trim()) return;
      // Custom /v1/models gateways often return OpenAI {"data":[...]} — Codex logs ERROR
      // then falls back to cache. Do not forward that noise into active task transcripts.
      if (isCodexModelsManagerNoise(line)) return;
      this.onServerMessage({ method: "agent/log", params: { line } });
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
      clientInfo: { name: "anytimevibe-agent", title: "随码", version: PRODUCT_VERSION },
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
    this.notify("initialized");
  }

  stop(options?: { intentional?: boolean }): void {
    const child = this.process;
    this.process = null;
    if (!child) return;
    child.removeAllListeners("exit");
    child.removeAllListeners("error");
    const detail = options?.intentional
      ? "Codex app-server reloading"
      : "Codex app-server stopped";
    for (const pending of this.pending.values()) {
      pending.reject(new Error(detail));
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
  if (
    /refresh token was revoked|access token could not be refreshed|token_invalidated|refresh_token_invalidated|authentication token has been invalidated|Your session has ended|Encountered invalidated oauth|MCP client for `codex_apps` failed/i.test(raw)
  ) {
    return [
      raw,
      "",
      "说明：本机 ~/.codex/auth.json 仍是 ChatGPT OAuth 登录态，但 refresh token 已失效。",
      "自定义 / 中转供应商即使 requires_openai_auth=false，只要 auth.json 里还留着 tokens，Codex 仍会走 ChatGPT 登录并访问官方接口，导致 401。",
      "处理：随码会在切号热重载时自动清掉 OAuth tokens、改用 API Key；也可在切号工具中关闭「切换时保留官方 Codex 登录」后重新切换一次供应商。"
    ].join("\n");
  }
  const hitsOfficialOpenai = /url:\s*https:\/\/api\.openai\.com\//i.test(raw);
  const invalidApiKey = /Incorrect API key provided|invalid_api_key|INVALID_API_KEY/i.test(raw);
  if (hitsOfficialOpenai) {
    return [
      raw,
      "",
      "说明：当前是 API Key 模式，但请求打到了官方 https://api.openai.com，而不是你在 config.toml 里配置的自定义 base_url。",
      "常见原因：① 旧线程仍绑定内置 provider=openai；② 切号软件冲掉了 model_provider / openai_base_url；③ openai_base_url 配置无效。",
      "处理：确认 ~/.codex/config.toml 中 model_provider 指向自定义供应商且 openai_base_url 正确；随码会尝试自动修复并注入 OPENAI_BASE_URL。可继续旧会话或新开任务验证。"
    ].join("\n");
  }
  if (invalidApiKey) {
    return [
      raw,
      "",
      "说明：请求已打到自定义 / 中转供应商，但对方拒绝了当前 API Key（不是打到官方 api.openai.com）。",
      "常见原因：① 切号后 config.toml 没有 experimental_bearer_token，Codex 仍带上旧 ChatGPT token；② 切号工具里的密钥已失效。",
      "处理：在切号工具确认当前供应商密钥有效后重新切换一次；随码会把该密钥写入供应商 bearer 并注入 Codex 进程。请重启随码或新开任务后再试。"
    ].join("\n");
  }
  if (/auth_unavailable|no auth available/i.test(raw)) {
    return [
      raw,
      "",
      "说明：本机 Cockpit 网关在线，但账号池当前没有可调度账号（冷却、授权失效或额度受限）。",
      "处理：到 Cockpit Tools → API 服务页检查 / 刷新 Codex 账号授权；随码不会改写或重启 Cockpit 服务。"
    ].join("\n");
  }
  if (/status\s*499|Client Closed Request/i.test(raw)) {
    return [
      raw,
      "",
      "说明：HTTP 499 表示「客户端」在上游还没回完时就断开了连接（nginx 记法）。",
      "链路一般是：Codex app-server → 本机 Cockpit 网关 → 上游。",
      "常见根因：Cockpit sidecar 流空闲超时过短、强制 responses_websockets、或代理干扰本机长连接。",
      "处理：在 Cockpit Tools 自行调整 Local Access / 流超时；降低 reasoning effort；确认 Agent 未给 localhost 套 HTTP_PROXY。随码不会改写或重启 Cockpit。"
    ].join("\n");
  }
  if (/ECONNREFUSED|connection refused|Failed to connect|tcp connect error|网关不可达/i.test(raw)) {
    return [
      raw,
      "",
      "说明：连不上模型供应商地址。若使用 codex_local_access（本机 Cockpit 网关），请先在 Cockpit Tools 启动 Local Access / API 服务后再从随码下发任务。"
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

function normalizeCodexItemType(type: unknown): string {
  return String(type ?? "").toLowerCase().replace(/[_-\s]/g, "");
}

function textFromCodexContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string" && part.trim()) {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const row = part as JsonObject;
    const kind = String(row.type ?? "").toLowerCase();
    if (kind && kind !== "text" && kind !== "input_text" && kind !== "output_text") continue;
    const text = String(row.text ?? row.content ?? "").trim();
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

function isCodexUserItem(item: JsonObject): boolean {
  const type = normalizeCodexItemType(item.type);
  if (type === "usermessage" || type === "user") return true;
  if (type === "message") {
    return String(item.role ?? item.sender ?? "").toLowerCase() === "user";
  }
  return false;
}

function textFromCodexUserItem(item: JsonObject): string {
  return textFromCodexContent(item.content)
    || String(item.text ?? item.message ?? "").trim();
}

/**
 * Keep the latest user prompt from our store / live transcript when Codex
 * thread/read omits it (common on systemerror / fail-fast turns).
 * Only restore the most recent missing YOU — merging every missing user from
 * `extra` can re-inject stale prompts after a clean snapshot lands.
 */
export function mergeSnapshotUserPrompts<T extends { id: string; role: string; text: string }>(
  incoming: T[],
  extra: Array<{ id?: string; role: string; text: string }>
): T[] {
  if (!extra.length) return incoming;
  const lastExtraUser = [...extra]
    .reverse()
    .find((message) => message.role === "user" && message.text.trim());
  if (!lastExtraUser) return incoming;
  const text = lastExtraUser.text.trim();
  const already = incoming.some(
    (message) => message.role === "user" && message.text.trim() === text
  );
  if (already) return incoming;
  const out: T[] = [...incoming];
  let insertAt = out.length;
  while (insertAt > 0 && out[insertAt - 1]?.role === "system") insertAt -= 1;
  out.splice(insertAt, 0, {
    id: lastExtraUser.id || `user:${insertAt}`,
    role: "user",
    text: lastExtraUser.text
  } as T);
  return out;
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
    let turnHadUser = false;
    for (const item of turn.items ?? []) {
      if (isCodexUserItem(item)) {
        const text = textFromCodexUserItem(item);
        if (text) {
          turnHadUser = true;
          messages.push({
            id: String(item.id || `user:${messages.length}`),
            role: "user",
            text,
            ...(started ? { createdAt: started } : {})
          });
        }
      }
      const agentText = item.type === "agentMessage"
        ? (String(item.text ?? "").trim() || textFromCodexContent(item.content))
        : "";
      if (agentText) {
        messages.push({
          id: item.id,
          role: "assistant",
          text: agentText,
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
    if (!turnHadUser) {
      const inputText = textFromCodexContent(turn.input) || String(turn.userMessage ?? turn.prompt ?? "").trim();
      if (inputText) {
        messages.push({
          id: `turn-input:${String(turn.id || messages.length)}`,
          role: "user",
          text: inputText,
          ...(started ? { createdAt: started } : {})
        });
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
  // Only override thread-level status with the last turn's status when the thread is vague (unknown/active/running)
  // AND the turn ended in a failure-type terminal state. Never let a previous turn's "completed" override a
  // thread that is still active — doing so made the web UI show "已完成" while the task was still running.
  const status = (
    /unknown|active|running/i.test(rawStatus)
    && lastTurnStatus
    && isTerminalTurnStatus(lastTurnStatus)
    && /error|fail|interrupt|cancel/i.test(lastTurnStatus)
  )
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
