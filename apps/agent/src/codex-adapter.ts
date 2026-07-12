import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { windowsCmdArguments } from "./windows-command";
import type { PermissionMode } from "@anytimevibe/protocol";

type RpcId = string | number;
type JsonObject = Record<string, any>;

export function codexPermissionParams(permissionMode: PermissionMode = "inherit"): Record<string, string> {
  if (permissionMode === "full-access") return { approvalPolicy: "never", sandbox: "danger-full-access" };
  if (permissionMode === "workspace-write") return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  if (permissionMode === "read-only") return { approvalPolicy: "on-request", sandbox: "read-only" };
  return {};
}

export function threadStartParams(cwd: string, permissionMode: PermissionMode = "inherit"): { cwd: string; approvalPolicy?: string; sandbox?: string } {
  return { cwd, ...codexPermissionParams(permissionMode) };
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
      // Inherit process PATH (agent refreshes login-shell PATH on macOS GUI launches).
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
      clientInfo: { name: "anytimevibe-agent", title: "随码", version: "0.4.9" },
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
    this.notify("initialized");
  }

  stop(): void {
    const child = this.process;
    this.process = null;
    if (!child) return;
    // Detach listeners first so kill-driven "exit" does not fire onExit UI updates
    // during app quit / quitAndInstall (destroyed BrowserWindow).
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

export function threadToSnapshot(thread: JsonObject) {
  const messages: Array<{ id: string; role: "user" | "assistant" | "system"; text: string; createdAt?: number }> = [];
  const turns = thread.turns ?? [];
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = (item.content ?? []).filter((content: JsonObject) => content.type === "text").map((content: JsonObject) => content.text).join("\n");
        if (text) messages.push({ id: item.id, role: "user", text, ...(turn.startedAt ? { createdAt: turn.startedAt } : {}) });
      }
      if (item.type === "agentMessage" && item.text) {
        messages.push({ id: item.id, role: "assistant", text: item.text, ...(turn.completedAt ? { createdAt: turn.completedAt } : {}) });
      }
      if (item.type === "plan" && item.text) messages.push({ id: item.id, role: "system", text: item.text });
    }
  }
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "canceled", "interrupted"]);
  const activeTurn = [...turns].reverse().find((turn: JsonObject) => {
    const status = String(turn.status ?? "").toLowerCase();
    return turn.id && !turn.completedAt && !terminalStatuses.has(status);
  });
  return {
    threadId: String(thread.id),
    title: String(thread.name || thread.preview || "未命名任务"),
    cwd: String(thread.cwd || ""),
    status: typeof thread.status === "string" ? thread.status : JSON.stringify(thread.status ?? "unknown"),
    ...(activeTurn ? { activeTurnId: String(activeTurn.id) } : {}),
    createdAt: Number(thread.createdAt ?? Date.now() / 1000),
    updatedAt: Number(thread.updatedAt ?? Date.now() / 1000),
    messages
  };
}
