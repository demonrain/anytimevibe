import { describe, expect, it } from "vitest";
import type { CliEngine, CliEngineInfo, EngineOperation } from "@anytimevibe/protocol";
import { EngineMaintenance, sanitizeEngineMaintenanceDetail } from "./engine-maintenance";

function fixture() {
  let engines: CliEngineInfo[] = [{ engine: "pi", ready: true, version: "1.0.0", latestVersion: "1.1.0" }];
  const externalBusy: CliEngine[] = [];
  const phases: EngineOperation[] = [];
  const effects: string[] = [];
  let upgrade: () => Promise<void> = async () => {
    effects.push("upgrade");
    engines = [{ engine: "pi", ready: true, version: "1.1.0", latestVersion: "1.1.0" }];
  };
  let install: () => Promise<void> = async () => {
    effects.push("install");
    engines = [{ engine: "pi", ready: true, version: "1.1.0", latestVersion: "1.1.0" }];
  };
  const manager = new EngineMaintenance({
    busyEngines: () => externalBusy,
    installedEngine: (engine) => engines.find((item) => item.engine === engine),
    detect: async () => { effects.push("detect"); return engines; },
    prepareUpdate: async () => { effects.push("prepare"); },
    upgrade: async (_engine, _version, onOutput) => { onOutput("download complete"); await upgrade(); },
    install: async (_engine, onOutput) => { onOutput("install complete"); await install(); },
    installRuntime: async () => "22.0.0",
    reload: async () => { effects.push("reload"); },
    syncModels: async () => { effects.push("sync"); },
    notify: async (operation) => { phases.push({ ...operation }); }
  });
  return {
    manager, externalBusy, phases, effects,
    setUpgrade: (value: () => Promise<void>) => { upgrade = value; },
    setInstall: (value: () => Promise<void>) => { install = value; },
    setEngines: (value: CliEngineInfo[]) => { engines = value; }
  };
}

const update = () => ({ type: "host.engine.update" as const, commandId: crypto.randomUUID(), cliEngine: "pi" as const });
const installCommand = () => ({ type: "host.engine.install" as const, commandId: crypto.randomUUID(), cliEngine: "pi" as const });
const runtimeInstall = () => ({ type: "host.runtime.install" as const, commandId: crypto.randomUUID() });

describe("engine maintenance", () => {
  it("installs the Node.js runtime as a separate maintenance operation", async () => {
    const f = fixture();
    await f.manager.execute(runtimeInstall());
    expect(f.effects).toEqual(["detect", "sync"]);
    expect(f.manager.operation).toMatchObject({ action: "runtime-install", phase: "completed", version: "22.0.0" });
  });
  it("installs a missing engine and verifies the resulting CLI", async () => {
    const f = fixture();
    f.setEngines([{ engine: "pi", ready: false }]);
    await f.manager.execute(installCommand());
    expect(f.effects).toEqual(["install", "detect", "sync"]);
    expect(f.manager.operation).toMatchObject({ action: "install", phase: "completed", version: "1.1.0" });
  });

  it("blocks new tasks while the remote engine installation is running", async () => {
    const f = fixture();
    f.setEngines([{ engine: "pi", ready: false }]);
    let notifyInstallEntered!: () => void;
    const installEntered = new Promise<void>((resolve) => { notifyInstallEntered = resolve; });
    let releaseInstall!: () => void;
    f.setInstall(() => { notifyInstallEntered(); return new Promise<void>((resolve) => { releaseInstall = resolve; }); });
    const installing = f.manager.execute(installCommand());
    try {
      await installEntered;
      expect(() => f.manager.reserveRun("pi")).toThrow(/正在升级/);
    } finally {
      releaseInstall();
      f.setEngines([{ engine: "pi", ready: true, version: "1.1.0", latestVersion: "1.1.0" }]);
      await installing;
    }
  });

  it("re-detects after an install failure and reports failed", async () => {
    const f = fixture();
    f.setEngines([{ engine: "pi", ready: false }]);
    f.setInstall(async () => { throw new Error("npm exited 17"); });
    await expect(f.manager.execute(installCommand())).rejects.toThrow("npm exited 17");
    expect(f.manager.operation).toMatchObject({ action: "install", phase: "failed" });
    expect(f.effects).toContain("detect");
    expect(f.manager.busy).toBe(false);
  });
  it("blocks updates for an engine with a running task", async () => {
    const f = fixture();
    f.externalBusy.push("pi");
    await expect(f.manager.execute(update())).rejects.toThrow(/运行/);
    expect(f.effects).toEqual([]);
  });

  it("protects the asynchronous task-start gap before a native process exists", async () => {
    const f = fixture();
    const release = f.manager.reserveRun("pi");
    expect(f.manager.busyEngines()).toContain("pi");
    await expect(f.manager.execute(update())).rejects.toThrow(/运行/);
    release();
    await f.manager.execute(update());
    expect(f.manager.operation?.phase).toBe("completed");
  });

  it("holds the update lock through version verification and model sync", async () => {
    const f = fixture();
    let finish!: () => void;
    f.setUpgrade(() => new Promise<void>((resolve) => { finish = resolve; }));
    const command = update();
    const running = f.manager.execute(command);
    void running.catch(() => {});
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    expect(f.manager.isUpdating("pi")).toBe(true);
    expect(() => f.manager.reserveRun("pi")).toThrow(/升级/);
    const otherRelease = f.manager.reserveRun("claude");
    otherRelease();
    await expect(f.manager.execute(update())).rejects.toThrow(/正在/);
    f.setEngines([{ engine: "pi", ready: true, version: "1.1.0" }]);
    finish();
    await running;
    expect(f.manager.busy).toBe(false);
    expect(f.manager.operation).toMatchObject({ commandId: command.commandId, phase: "completed", version: "1.1.0" });
    expect(f.effects).toEqual(["prepare", "detect", "reload", "sync"]);
  });

  it("does not report success when the updated CLI still resolves to an old version", async () => {
    const f = fixture();
    f.setUpgrade(async () => {});
    await expect(f.manager.execute(update())).rejects.toThrow(/1\.1\.0|版本/);
    expect(f.manager.operation?.phase).toBe("failed");
    expect(f.phases.some((item) => item.phase === "completed")).toBe(false);
    expect(f.manager.isUpdating("pi")).toBe(false);
  });

  it("releases the lock and re-detects after an upgrade command fails", async () => {
    const f = fixture();
    f.setUpgrade(async () => { throw new Error("npm exited 17"); });
    await expect(f.manager.execute(update())).rejects.toThrow("npm exited 17");
    expect(f.manager.operation).toMatchObject({ phase: "failed", detail: "npm exited 17" });
    expect(f.effects).toContain("detect");
    expect(f.manager.busy).toBe(false);
    expect(() => f.manager.reserveRun("pi")).not.toThrow();
  });

  it("does not downgrade a CLI that is already newer than the published stable version", async () => {
    const f = fixture();
    f.setEngines([{ engine: "pi", ready: true, version: "1.2.0", latestVersion: "1.1.0" }]);
    await f.manager.execute(update());
    expect(f.effects).not.toContain("upgrade");
    expect(f.manager.operation).toMatchObject({ phase: "completed", version: "1.2.0" });
  });

  it("refreshes catalogs without running an upgrade or blocking tasks", async () => {
    const f = fixture();
    f.externalBusy.push("pi");
    await f.manager.execute({ type: "host.engine.refresh", commandId: crypto.randomUUID(), checkUpdates: true });
    expect(f.effects).toEqual(["detect", "sync"]);
    expect(f.manager.operation).toMatchObject({ action: "refresh", phase: "completed" });
  });

  it("rejects updates for engines that are not installed", async () => {
    const f = fixture();
    f.setEngines([{ engine: "pi", ready: false }]);
    await expect(f.manager.execute(update())).rejects.toThrow(/安装/);
    expect(f.effects).toEqual([]);
  });

  it("removes secrets and terminal escapes from externally visible progress", () => {
    const detail = sanitizeEngineMaintenanceDetail("\u001b[31mfailed\u001b[0m https://user:password@proxy.example:8080 Authorization: Bearer secret-token sk-exampleSecret123");
    expect(detail).toContain("failed");
    expect(detail).not.toMatch(/password|secret-token|exampleSecret|\u001b/);
    expect(sanitizeEngineMaintenanceDetail("x".repeat(1500)).length).toBeLessThanOrEqual(1000);
  });
});
