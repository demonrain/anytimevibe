import type { CliEngine, CliEngineInfo, ClientCommand, EngineOperation } from "@anytimevibe/protocol";
import { compareVersions, normalizeVersionLabel } from "./version-compare";

export type EngineMaintenanceCommand = Extract<ClientCommand, { type: "host.engine.update" | "host.engine.refresh" }>;
export type EngineMaintenanceDependencies = {
  busyEngines(): CliEngine[];
  installedEngine(engine: CliEngine): CliEngineInfo | undefined;
  detect(checkUpdates: boolean, engine?: CliEngine): Promise<CliEngineInfo[]>;
  prepareUpdate(engine: CliEngine): Promise<void>;
  upgrade(engine: CliEngine, version: string | undefined, onOutput: (text: string) => void): Promise<void>;
  reload(engine: CliEngine): Promise<void>;
  syncModels(engine?: CliEngine): Promise<void>;
  notify(operation: EngineOperation): Promise<void>;
};

export class EngineMaintenance {
  private current: EngineOperation | undefined;
  private inFlight = false;
  private notificationQueue: Promise<void> = Promise.resolve();
  private readonly startingRuns = new Map<CliEngine, number>();

  constructor(private readonly dependencies: EngineMaintenanceDependencies) {}

  get operation(): EngineOperation | undefined { return this.current ? { ...this.current } : undefined; }
  get busy(): boolean { return this.inFlight; }

  isUpdating(engine: CliEngine): boolean {
    return this.inFlight && this.current?.action === "update" && this.current.cliEngine === engine;
  }

  busyEngines(): CliEngine[] {
    return [...new Set([...this.dependencies.busyEngines(), ...this.startingRuns.keys()])];
  }

  /** Acquire synchronously, before any await that prepares a task or native process. */
  reserveRun(engine: CliEngine): () => void {
    if (this.isUpdating(engine)) throw new Error(`${engine} 正在升级，请等待升级及模型同步完成后再运行任务。`);
    this.startingRuns.set(engine, (this.startingRuns.get(engine) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.startingRuns.get(engine) ?? 1) - 1;
      if (count > 0) this.startingRuns.set(engine, count);
      else this.startingRuns.delete(engine);
    };
  }

  private async report(patch: Partial<EngineOperation>): Promise<void> {
    this.current = { ...this.current!, ...patch, updatedAt: new Date().toISOString() };
    const snapshot = { ...this.current };
    // A disconnected browser/relay must not abort an upgrade already executing locally.
    this.notificationQueue = this.notificationQueue
      .then(() => this.dependencies.notify(snapshot))
      .catch(() => undefined);
    await this.notificationQueue;
  }

  async execute(command: EngineMaintenanceCommand): Promise<void> {
    if (this.inFlight) throw new Error("正在升级或同步编码引擎，请等待当前操作完成。");
    const action = command.type === "host.engine.update" ? "update" : "refresh";
    const engine = command.cliEngine;
    const before = engine ? this.dependencies.installedEngine(engine) : undefined;
    if (action === "update") {
      if (!before?.ready) throw new Error(`${engine} 尚未安装或当前不可用，请先在客户端检查 CLI。`);
      if (this.busyEngines().includes(engine!)) throw new Error(`${engine} 有任务正在运行或等待审批，请等待任务结束后再升级。`);
    }
    // The global maintenance lock also serializes package-manager and catalog operations.
    this.inFlight = true;
    const now = new Date().toISOString();
    this.current = {
      commandId: command.commandId, action,
      ...(engine ? { cliEngine: engine } : {}),
      phase: action === "update" ? "updating" : "checking", startedAt: now, updatedAt: now,
      ...(before?.version ? { previousVersion: before.version } : {})
    };
    let upgradeExecuted = false;
    try {
      await this.report({ detail: action === "update" ? "正在准备升级 CLI…" : "正在重新检测编码引擎…" });
      if (action === "update") {
        const current = normalizeVersionLabel(before?.version);
        const latest = normalizeVersionLabel(before?.latestVersion);
        const alreadyCurrent = Boolean(current && latest && compareVersions(current, latest) >= 0);
        if (!alreadyCurrent) {
          await this.dependencies.prepareUpdate(engine!);
          upgradeExecuted = true;
          await this.dependencies.upgrade(engine!, latest, (output) => {
            if (this.current?.phase !== "updating") return;
            const detail = sanitizeEngineMaintenanceDetail(output);
            if (detail) void this.report({ detail }).catch(() => undefined);
          });
        }
        await this.report({ phase: "verifying", detail: "正在验证升级后实际使用的 CLI 版本…" });
        const detected = (await this.dependencies.detect(true, engine)).find((item) => item.engine === engine);
        const version = normalizeVersionLabel(detected?.version);
        if (!detected?.ready || !version || !/\d+\.\d+\.\d+/.test(version)) {
          throw new Error("升级后未能检测到可用 CLI 或读取版本，请在客户端检查安装路径及权限。");
        }
        if (latest && compareVersions(version, latest) < 0) {
          throw new Error(`升级后实际使用的版本仍为 ${version}（目标 ${latest}）。可能有另一份安装或自定义启动路径覆盖了新版本，请在客户端检查 PATH。`);
        }
        if (current && compareVersions(version, current) < 0) throw new Error(`检测到版本从 ${current} 降为 ${version}，请在客户端检查安装来源。`);
        await this.report({ version, phase: "syncing", detail: "CLI 版本已验证，正在重载并同步模型目录…" });
        if (upgradeExecuted) await this.dependencies.reload(engine!);
      } else {
        await this.dependencies.detect(
          command.type === "host.engine.refresh" && command.checkUpdates === true,
          engine
        );
        await this.report({ phase: "syncing", detail: "正在读取 CLI 模型目录及本机配置…" });
      }
      await this.dependencies.syncModels(engine);
      await this.report({ phase: "completed", detail: action === "update"
        ? "CLI 升级检查及模型同步完成；模型来源和可用范围以引擎返回结果为准。"
        : "引擎检测及模型同步完成；无法读取实时目录时会标注缓存、配置或候选列表。" });
    } catch (error) {
      // Installation can have partially changed files even when npm/self-update fails.
      // Refresh what is actually usable; never turn the command failure into a success.
      await this.dependencies.detect(false, engine).catch(() => undefined);
      await this.dependencies.syncModels(engine).catch(() => undefined);
      const message = sanitizeEngineMaintenanceDetail(error instanceof Error ? error.message : String(error));
      await this.report({ phase: "failed", detail: message || "编码引擎操作失败，请检查客户端日志。" });
      throw new Error(message || "编码引擎操作失败");
    } finally {
      this.inFlight = false;
    }
  }
}

export function sanitizeEngineMaintenanceDetail(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b(sk-[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim().slice(-1000);
}
