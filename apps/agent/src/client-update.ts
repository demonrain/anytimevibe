import type { ClientCommand, ClientUpdateState } from "@anytimevibe/protocol";
import { compareVersions } from "./cli/version-compare";

export type NativeUpdateState = {
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  version?: string;
  progress?: number;
  message?: string;
};

export type ClientUpdateIntent = {
  commandId: string;
  beforeVersion: string;
  targetVersion?: string;
  phase: "requested" | "installing";
};

type Dependencies = {
  supported: boolean;
  currentVersion: string;
  intent?: ClientUpdateIntent | undefined;
  recoveryFailure?: string;
  awaitingInstallerResult?: boolean;
  busy(): boolean;
  persist(intent: ClientUpdateIntent | undefined): Promise<void>;
  check(): Promise<void>;
  prepare(intent: ClientUpdateIntent): Promise<{ launch(): Promise<void>; dispose?(): Promise<void> }>;
  quit(): void;
  notify(state: ClientUpdateState): Promise<void>;
};

/** Downloading is harmless while busy; installation needs an explicit durable intent and an idle host. */
export class ClientUpdateController {
  private snapshot: ClientUpdateState;
  private native: NativeUpdateState = { status: "idle" };
  private intent: ClientUpdateIntent | undefined;
  private generation = 0;
  private preparing = false;
  private committed = false;
  private recoveryPending = false;
  private recoveryOutcome = false;
  private awaitingInstallerResult = false;
  private pendingCancellations = 0;
  private actionQueue: Promise<void> = Promise.resolve();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private notificationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: Dependencies) {
    const saved = dependencies.intent;
    const installed = saved?.phase === "installing";
    this.intent = installed ? undefined : saved;
    this.awaitingInstallerResult = Boolean(installed && dependencies.awaitingInstallerResult);
    this.recoveryPending = Boolean(installed && !this.awaitingInstallerResult);
    this.recoveryOutcome = Boolean(installed);
    const succeeded = installed && saved.targetVersion
      && compareVersions(dependencies.currentVersion, saved.targetVersion) >= 0
      && compareVersions(dependencies.currentVersion, saved.beforeVersion) > 0
      && !dependencies.recoveryFailure;
    this.snapshot = {
      supported: dependencies.supported,
      currentVersion: dependencies.currentVersion,
      status: this.awaitingInstallerResult ? "installing" : installed ? (succeeded ? "completed" : "error") : saved ? "checking" : "idle",
      ...(saved ? { commandId: saved.commandId, version: saved.targetVersion } : {}),
      installWhenIdle: Boolean(this.intent),
      ...(installed ? { message: this.awaitingInstallerResult
        ? "客户端已启动，正在等待安装辅助进程确认运行稳定。"
        : succeeded
        ? `客户端已升级到 v${dependencies.currentVersion}，已重新启动。`
        : dependencies.recoveryFailure || "静默升级未完成，客户端已重新启动。请检查安装权限或重试。" } : {}),
      updatedAt: new Date().toISOString()
    };
  }

  get state(): ClientUpdateState { return { ...this.snapshot }; }
  /** Acquired synchronously before preparation so task launchers can reserve the host safely. */
  get applying(): boolean { return this.preparing || this.committed || this.awaitingInstallerResult; }

  /** The helper, not the first startup heartbeat, decides whether rollback is still needed. */
  async confirmRestart(result: { success: boolean; message?: string }): Promise<void> {
    if (!this.awaitingInstallerResult) return;
    this.awaitingInstallerResult = false;
    const saved = this.dependencies.intent;
    const success = result.success && saved?.targetVersion
      && compareVersions(this.dependencies.currentVersion, saved.targetVersion) >= 0
      && compareVersions(this.dependencies.currentVersion, saved.beforeVersion) > 0;
    if (!success) {
      await this.fail(result.message || "静默升级未完成，客户端已恢复运行。请检查安装权限或重试。");
      return;
    }
    try { await this.persist(undefined); }
    catch (error) { await this.fail(error); return; }
    await this.report({ status: "completed", installWhenIdle: false,
      message: `客户端已升级到 v${this.dependencies.currentVersion}，已确认运行稳定。` });
  }

  private async report(patch: Partial<ClientUpdateState>): Promise<void> {
    this.snapshot = {
      ...this.snapshot, ...patch,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(this.snapshot.updatedAt) + 1)).toISOString()
    };
    const snapshot = this.state;
    this.notificationQueue = this.notificationQueue
      .then(() => this.dependencies.notify(snapshot)).catch(() => undefined);
    // Relay failure must not abort a locally prepared update.
    await this.notificationQueue;
  }

  private persist(value: ClientUpdateIntent | undefined): Promise<void> {
    const saved = value ? { ...value } : undefined;
    const write = this.persistenceQueue.then(() => this.dependencies.persist(saved));
    this.persistenceQueue = write.catch(() => undefined);
    return write;
  }

  private async fail(error: unknown): Promise<void> {
    this.intent = undefined;
    this.generation++;
    this.committed = false;
    let message = error instanceof Error ? error.message : String(error);
    try { await this.persist(undefined); }
    catch { message += "（无法保存升级状态，请检查客户端数据目录权限。）"; }
    await this.report({ status: "error", installWhenIdle: false, message: message.slice(0, 1000) });
  }

  execute(command: Pick<Extract<ClientCommand, { type: "host.client.update" }>, "commandId" | "action">): Promise<void> {
    const cancelling = command.action === "cancel" && this.dependencies.supported
      && !this.committed && !this.awaitingInstallerResult;
    let cancellationWrite: Promise<void> | undefined;
    if (cancelling) {
      // Cancellation must invalidate a preparation immediately, even if a
      // previous check/notification is still occupying the serialized action lane.
      this.pendingCancellations++;
      this.intent = undefined;
      this.generation++;
      cancellationWrite = this.persist(undefined);
      void cancellationWrite.catch(() => undefined);
    }
    const run = this.actionQueue.then(() => this.executeAction(command, cancellationWrite));
    const finished = run.finally(() => { if (cancelling) this.pendingCancellations--; });
    this.actionQueue = finished.catch(() => undefined);
    return finished;
  }

  private async executeAction(command: { commandId: string; action: "check" | "upgrade" | "cancel" }, cancellationWrite?: Promise<void>): Promise<void> {
    if (!this.dependencies.supported) throw new Error("此客户端或平台尚不支持远程静默升级。");
    if (this.awaitingInstallerResult) throw new Error("正在确认升级后的客户端运行状态，请稍后再操作。");
    if (this.committed) throw new Error("客户端已开始安装更新，请等待重新连接。");
    if (this.preparing && command.action !== "cancel") throw new Error("正在准备静默安装，请等待安装或取消自动安装。");
    if (this.recoveryPending) {
      await this.persist(undefined);
      this.recoveryPending = false;
    }
    this.recoveryOutcome = false;
    this.snapshot = { ...this.snapshot, commandId: command.commandId };
    if (command.action === "upgrade" && this.pendingCancellations) return;
    if (command.action === "cancel") {
      this.intent = undefined;
      this.generation++;
      try { await (cancellationWrite ?? this.persist(undefined)); }
      catch (error) { await this.fail(error); return; }
      await this.report({ ...this.native, commandId: command.commandId, installWhenIdle: false,
        message: "已取消自动安装，下载完成的更新包会保留。" });
      return;
    }
    if (command.action === "upgrade" && this.intent) {
      // A repeated click acknowledges its own command without restarting the download.
      this.intent = { ...this.intent, commandId: command.commandId };
      try { await this.persist(this.intent); }
      catch (error) { await this.fail(error); return; }
      await this.report({ commandId: command.commandId });
      return;
    }
    if (command.action === "upgrade") {
      this.intent = { commandId: command.commandId, beforeVersion: this.dependencies.currentVersion, phase: "requested" };
      this.generation++;
    }
    const generation = this.generation;
    if (command.action === "upgrade") {
      try { await this.persist(this.intent); }
      catch (error) { await this.fail(error); return; }
    }
    if (generation !== this.generation) return;
    await this.report({ commandId: command.commandId, installWhenIdle: Boolean(this.intent),
      status: this.native.status === "ready" ? (this.intent && this.dependencies.busy() ? "waiting" : "ready")
        : this.native.status === "downloading" ? "downloading" : "checking",
      message: this.native.status === "ready" ? "更新包已下载，将在任务结束后静默安装。"
        : this.native.status === "downloading" ? this.native.message : "正在检查客户端更新…" });
    if (generation !== this.generation) return;
    try { await this.dependencies.check(); }
    catch (error) { if (generation === this.generation) await this.fail(error); }
  }

  async observe(native: NativeUpdateState): Promise<void> {
    this.native = { ...native, ...(native.message ? { message: native.message.slice(0, 1000) } : {}) };
    if (this.committed || this.recoveryOutcome) return;
    if (native.status === "error") { await this.fail(native.message || "客户端更新失败"); return; }
    if (native.status === "idle" && this.intent) {
      this.intent = undefined;
      this.generation++;
      try { await this.persist(undefined); }
      catch (error) { await this.fail(error); return; }
    }
    await this.report({
      ...this.native, version: native.version, progress: native.progress, message: this.native.message,
      status: native.status === "ready" && this.intent && this.dependencies.busy() ? "waiting" : native.status,
      installWhenIdle: Boolean(this.intent)
    });
  }

  async tick(): Promise<void> {
    if (this.recoveryPending) {
      this.recoveryPending = false;
      try { await this.persist(undefined); }
      catch (error) { await this.fail(error); }
      return;
    }
    if (this.applying || this.pendingCancellations || !this.intent || this.native.status !== "ready") return;
    if (this.dependencies.busy()) {
      if (this.snapshot.status !== "waiting") await this.report({ status: "waiting", message: "更新包已下载，正在等待任务和编码引擎维护结束。" });
      return;
    }
    if (!this.native.version || compareVersions(this.native.version, this.dependencies.currentVersion) <= 0) {
      await this.fail("更新包的版本无效，请重新检查更新。");
      return;
    }
    this.preparing = true;
    const generation = this.generation;
    let prepared: Awaited<ReturnType<Dependencies["prepare"]>> | undefined;
    try {
      prepared = await this.dependencies.prepare({ ...this.intent });
      if (generation !== this.generation || !this.intent || this.dependencies.busy()) {
        if (this.intent) await this.report({ status: "waiting", message: "正在等待任务和编码引擎维护结束。" });
        await prepared.dispose?.();
        return;
      }
      // After this point cancellation is disallowed. Task launchers see applying=true.
      this.committed = true;
      this.intent = { ...this.intent, phase: "installing", targetVersion: this.native.version };
      await this.persist(this.intent);
      await this.report({ status: "installing", commandId: this.intent.commandId, version: this.native.version, installWhenIdle: true,
        message: "正在静默安装并重启客户端，稍后将自动重新连接。" });
      // launch resolves only after the independent helper acknowledges it can continue.
      await prepared.launch();
      this.dependencies.quit();
    } catch (error) {
      await prepared?.dispose?.().catch(() => undefined);
      await this.fail(error);
    } finally {
      this.preparing = false;
    }
  }
}
