import { describe, expect, it } from "vitest";
import {
  ClientUpdateController,
  isClientUpdateBusy,
  type ClientUpdateIntent,
  type NativeUpdateState
} from "./client-update";

const id = "11111111-1111-4111-8111-111111111111";
function fixture(options: { busy?: boolean; busyMessage?: string; intent?: ClientUpdateIntent; version?: string; prepareFailure?: string } = {}) {
  let busy = options.busy ?? false;
  let busyMessage = options.busyMessage;
  let intent = options.intent;
  let checks = 0;
  let launches = 0;
  const controller = new ClientUpdateController({
    supported: true, currentVersion: options.version || "0.5.23", intent,
    busy: () => busy,
    busyMessage: () => busyMessage,
    persist: async (value) => { intent = value; },
    check: async () => { checks++; },
    prepare: async () => {
      if (options.prepareFailure) throw new Error(options.prepareFailure);
      return { launch: async () => { launches++; } };
    },
    quit: () => {},
    notify: async () => {}
  });
  return { controller, setBusy: (value: boolean) => { busy = value; },
    setBusyMessage: (value: string | undefined) => { busyMessage = value; }, saved: () => intent,
    checks: () => checks, launches: () => launches };
}
const ready: NativeUpdateState = { status: "ready", version: "0.5.24", progress: 100 };

describe("remote client update control", () => {
  it("does not block on internal Codex housekeeping when no user work is active", () => {
    expect(isClientUpdateBusy({
      clientOperations: 0,
      engineMaintenanceBusy: false,
      busyEngines: [],
      codexMessageChains: 1,
      codexReloadInFlight: true,
      capabilityRefreshInFlight: true
    })).toBe(false);
  });

  it("downloads while busy and waits for all work before installing", async () => {
    const f = fixture({ busy: true });
    await f.controller.execute({ commandId: id, action: "upgrade" });
    expect(f.checks()).toBe(1);
    await f.controller.observe(ready);
    await f.controller.tick();
    expect(f.controller.state.status).toBe("waiting");
    expect(f.launches()).toBe(0);
    f.setBusy(false);
    await f.controller.tick();
    expect(f.launches()).toBe(1);
    expect(f.saved()).toMatchObject({ commandId: id, phase: "installing", targetVersion: "0.5.24" });
  });

  it("reports the specific operation that is keeping a downloaded update waiting", async () => {
    const f = fixture({ busy: true, busyMessage: "Waiting for local operation 1" });
    await f.controller.execute({ commandId: id, action: "upgrade" });
    await f.controller.observe(ready);
    await f.controller.tick();

    expect(f.controller.state).toMatchObject({ status: "waiting", message: "Waiting for local operation 1" });

    f.setBusyMessage("Waiting for Codex task");
    await f.controller.tick();
    expect(f.controller.state.message).toBe("Waiting for Codex task");
  });

  it("does not install a background download without explicit intent", async () => {
    const f = fixture();
    await f.controller.observe(ready);
    await f.controller.tick();
    expect(f.launches()).toBe(0);
    expect(f.controller.state.status).toBe("ready");
  });

  it("cancels a delayed installation while retaining a downloaded package", async () => {
    const f = fixture({ busy: true });
    await f.controller.execute({ commandId: id, action: "upgrade" });
    await f.controller.observe(ready);
    await f.controller.execute({ commandId: crypto.randomUUID(), action: "cancel" });
    f.setBusy(false);
    await f.controller.tick();
    expect(f.saved()).toBeUndefined();
    expect(f.launches()).toBe(0);
    expect(f.controller.state).toMatchObject({ status: "ready", installWhenIdle: false });
  });

  it("keeps the client running when silent installation cannot be prepared", async () => {
    const f = fixture({ prepareFailure: "Directory is read-only" });
    await f.controller.execute({ commandId: id, action: "upgrade" });
    await f.controller.observe(ready);
    await f.controller.tick();
    expect(f.controller.state).toMatchObject({ status: "error", message: "Directory is read-only" });
    expect(f.controller.applying).toBe(false);
    expect(f.launches()).toBe(0);
    expect(f.saved()).toBeUndefined();
  });

  it("deduplicates repeated upgrade clicks", async () => {
    const f = fixture({ busy: true });
    await f.controller.execute({ commandId: id, action: "upgrade" });
    await f.controller.execute({ commandId: crypto.randomUUID(), action: "upgrade" });
    expect(f.checks()).toBe(1);
    await f.controller.observe(ready);
    f.setBusy(false);
    await Promise.all([f.controller.tick(), f.controller.tick()]);
    expect(f.launches()).toBe(1);
  });

  it("confirms the running version after restarting", () => {
    const intent: ClientUpdateIntent = { commandId: id, beforeVersion: "0.5.23", targetVersion: "0.5.24", phase: "installing" };
    expect(fixture({ intent, version: "0.5.24" }).controller.state.status).toBe("completed");
    expect(fixture({ intent, version: "0.5.23" }).controller.state.status).toBe("error");
  });

  it("retains the restart result through the startup background check", async () => {
    const intent: ClientUpdateIntent = { commandId: id, beforeVersion: "0.5.23", targetVersion: "0.5.24", phase: "installing" };
    const f = fixture({ intent, version: "0.5.24" });
    await f.controller.tick();
    await f.controller.observe({ status: "checking" });
    await f.controller.observe({ status: "idle", message: "Already up to date" });
    expect(f.controller.state.status).toBe("completed");
    expect(f.saved()).toBeUndefined();
  });

  it("waits for stable installer confirmation before clearing the intent", async () => {
    const intent: ClientUpdateIntent = { commandId: id, beforeVersion: "0.5.23", targetVersion: "0.5.24", phase: "installing" };
    let saved: ClientUpdateIntent | undefined = intent;
    const controller = new ClientUpdateController({ supported: true, currentVersion: "0.5.24", intent,
      awaitingInstallerResult: true, busy: () => false,
      persist: async (next) => { saved = next; }, check: async () => {}, notify: async () => {}, quit: () => {},
      prepare: async () => ({ launch: async () => {} }) });
    expect(controller.state.status).toBe("installing");
    expect(controller.applying).toBe(true);
    await controller.tick();
    expect(saved).toEqual(intent);
    await controller.confirmRestart({ success: true });
    expect(controller.state.status).toBe("completed");
    expect(controller.applying).toBe(false);
    expect(saved).toBeUndefined();
  });

  it("cannot report completion when the installer reports startup failure", async () => {
    const intent: ClientUpdateIntent = { commandId: id, beforeVersion: "0.5.23", targetVersion: "0.5.24", phase: "installing" };
    const controller = new ClientUpdateController({ supported: true, currentVersion: "0.5.24", intent,
      awaitingInstallerResult: true, busy: () => false, persist: async () => {}, check: async () => {},
      notify: async () => {}, quit: () => {}, prepare: async () => ({ launch: async () => {} }) });
    await controller.confirmRestart({ success: false, message: "Target client did not provide stable heartbeats" });
    expect(controller.state).toMatchObject({ status: "error", message: "Target client did not provide stable heartbeats" });
    expect(controller.applying).toBe(false);
  });

  it("does not quit if saving the installation intent fails", async () => {
    let quit = false;
    let launch = false;
    const controller = new ClientUpdateController({ supported: true, currentVersion: "0.5.23", busy: () => false,
      persist: async (intent) => { if (intent?.phase === "installing") throw new Error("Disk full"); },
      check: async () => {}, notify: async () => {}, quit: () => { quit = true; },
      prepare: async () => ({ launch: async () => { launch = true; } }) });
    await controller.execute({ commandId: id, action: "upgrade" });
    await controller.observe(ready);
    await controller.tick();
    expect(quit).toBe(false);
    expect(launch).toBe(false);
    expect(controller.state.status).toBe("error");
  });

  it("cancels while the installer is still being prepared", async () => {
    let finish!: () => void;
    let launched = false;
    let disposed = false;
    const prepared = new Promise<void>((resolve) => { finish = resolve; });
    const controller = new ClientUpdateController({ supported: true, currentVersion: "0.5.23", busy: () => false,
      persist: async () => {}, check: async () => {}, notify: async () => {}, quit: () => {},
      prepare: async () => { await prepared; return { launch: async () => { launched = true; }, dispose: async () => { disposed = true; } }; } });
    await controller.execute({ commandId: id, action: "upgrade" });
    await controller.observe(ready);
    const install = controller.tick();
    await controller.execute({ commandId: crypto.randomUUID(), action: "cancel" });
    finish();
    await install;
    expect(launched).toBe(false);
    expect(disposed).toBe(true);
    expect(controller.applying).toBe(false);
    expect(controller.state.installWhenIdle).toBe(false);
  });

  it("cancels preparation even while the upgrade action is waiting for a slow notification", async () => {
    let finishPrepare!: () => void;
    let finishNotify!: () => void;
    let launches = 0;
    let notificationStarted = false;
    const preparation = new Promise<void>((resolve) => { finishPrepare = resolve; });
    const notification = new Promise<void>((resolve) => { finishNotify = resolve; });
    const controller = new ClientUpdateController({ supported: true, currentVersion: "0.5.23", busy: () => false,
      persist: async () => {}, check: async () => {}, quit: () => {},
      notify: async (state) => { if (state.installWhenIdle) { notificationStarted = true; await notification; } },
      prepare: async () => { await preparation; return { launch: async () => { launches++; } }; } });
    await controller.observe(ready);
    const upgrade = controller.execute({ commandId: id, action: "upgrade" });
    for (let i = 0; i < 20 && !notificationStarted; i++) await Promise.resolve();
    expect(notificationStarted).toBe(true);
    const install = controller.tick();
    const cancel = controller.execute({ commandId: crypto.randomUUID(), action: "cancel" });
    finishPrepare();
    finishNotify();
    await Promise.allSettled([upgrade, install, cancel]);
    expect(launches).toBe(0);
    expect(controller.state.installWhenIdle).toBe(false);
  });

  it("acknowledges the submitted command when persistence fails", async () => {
    const controller = new ClientUpdateController({ supported: true, currentVersion: "0.5.23", busy: () => false,
      persist: async () => { throw new Error("Read-only data directory"); }, check: async () => {},
      notify: async () => {}, quit: () => {}, prepare: async () => ({ launch: async () => {} }) });
    await controller.execute({ commandId: id, action: "upgrade" });
    expect(controller.state).toMatchObject({ status: "error", commandId: id, installWhenIdle: false });
  });

  it("keeps the client online if the helper does not acknowledge readiness", async () => {
    let quit = false;
    let saved: ClientUpdateIntent | undefined;
    const controller = new ClientUpdateController({ supported: true, currentVersion: "0.5.23", busy: () => false,
      persist: async (intent) => { saved = intent; }, check: async () => {},
      notify: async () => { throw new Error("Relay offline"); }, quit: () => { quit = true; },
      prepare: async () => ({ launch: async () => { throw new Error("Helper not ready"); } }) });
    await controller.execute({ commandId: id, action: "upgrade" });
    await controller.observe(ready);
    await controller.tick();
    expect(quit).toBe(false);
    expect(saved).toBeUndefined();
    expect(controller.applying).toBe(false);
    expect(controller.state).toMatchObject({ status: "error", message: "Helper not ready" });
  });

  it("clears deferred installation after a failed download", async () => {
    const f = fixture();
    await f.controller.execute({ commandId: id, action: "upgrade" });
    await f.controller.observe({ status: "error", message: "Checksum mismatch" });
    await f.controller.observe(ready);
    await f.controller.tick();
    expect(f.saved()).toBeUndefined();
    expect(f.launches()).toBe(0);
  });

  it("a concurrent check does not cancel a requested upgrade", async () => {
    const f = fixture({ busy: true });
    await f.controller.execute({ commandId: id, action: "upgrade" });
    await f.controller.observe({ status: "downloading", version: "0.5.24", progress: 30 });
    await f.controller.execute({ commandId: crypto.randomUUID(), action: "check" });
    expect(f.controller.state).toMatchObject({ status: "downloading", installWhenIdle: true, progress: 30 });
    await f.controller.observe(ready);
    f.setBusy(false);
    await f.controller.tick();
    expect(f.launches()).toBe(1);
  });

  it("never applies while new work appeared during preparation", async () => {
    let busy = false;
    let launched = false;
    const controller = new ClientUpdateController({ supported: true, currentVersion: "0.5.23", busy: () => busy,
      persist: async () => {}, check: async () => {}, notify: async () => {}, quit: () => {},
      prepare: async () => { busy = true; return { launch: async () => { launched = true; } }; } });
    await controller.execute({ commandId: id, action: "upgrade" });
    await controller.observe(ready);
    await controller.tick();
    expect(launched).toBe(false);
    expect(controller.state.status).toBe("waiting");
  });
});
