import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";
import type { CliEngineInfo } from "@anytimevibe/protocol";
import { EngineMaintenance } from "./engine-maintenance";

// Exercise production lifecycle functions without booting the Electron app.
const mainSource = createSourceFile(
  "main.ts", readFileSync(path.resolve("apps/agent/src/main.ts"), "utf8"), ScriptTarget.Latest, true
);
const names = ["ensureCodex", "ensureCodexImpl", "reserveClientOperation", "withClientOperation", "startCodexAppServer", "startCodexAppServerImpl", "stopCodexAppServer", "reloadCodexAppServer", "performCodexAppServerReload", "reconcileCodexCredentialsIfStale", "queueCodexCredentialReload"];
const declarations = names.map((name) => {
  const declaration = mainSource.statements.find((node) =>
    isFunctionDeclaration(node) && node.name?.text === name
  );
  if (!declaration) throw new Error(`Could not locate ${name}`);
  return declaration.getText(mainSource);
});
const lifecycleScript = new Script(`${transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
}).outputText}\n({ ${names.join(", ")} });`);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const upgradeEntered = deferred();
  const upgradeGate = deferred();
  let engines: CliEngineInfo[] = [{ engine: "codex", ready: true, version: "1.0.0", latestVersion: "1.1.0" }];
  const effects: string[] = [];
  const manager = new EngineMaintenance({
    busyEngines: () => [],
    installedEngine: (engine) => engines.find((item) => item.engine === engine),
    detect: async () => engines,
    prepareUpdate: async () => {},
    upgrade: async () => {
      upgradeEntered.resolve();
      await upgradeGate.promise;
      engines = [{ engine: "codex", ready: true, version: "1.1.0", latestVersion: "1.1.0" }];
    },
    reload: async () => {}, syncModels: async () => {}, notify: async () => {}
  });
  const context = {
    codex: null,
    codexStartInFlight: null,
    codexStopInFlight: null,
    quitting: false,
    installingUpdate: false,
    clientUpdateController: { applying: false },
    clientOperations: 0,
    codexVersion: "1.0.0",
    codexMessageGeneration: 0,
    codexCommand: "codex",
    codexLoadedCredentialFingerprint: null,
    codexReloadInFlight: null,
    pendingCodexAppServerReload: null,
    engineMaintenanceInstance: manager,
    getEngineMaintenance: () => manager,
    applyLoginPathToProcess: async () => {},
    noteCodexCredentialSelfWrite: () => {},
    repairCodexModelProviderConfig: async () => { effects.push("repair"); return { repaired: false }; },
    sanitizeCodexRelayAuth: async () => ({ repaired: false }),
    syncCodexRelayConfigForTurn: async () => { effects.push("credentials"); return { fingerprint: "current" }; },
    isCodexCompatibleVersion: () => true,
    readCodexCredentialFingerprint: async () => "current",
    hasActiveCodexTurn: () => false,
    publicState: { environment: { codexCompatible: true, codexInstalled: true } },
    publishHostStatus: async () => {},
    logWarn: () => {}, logInfo: () => {}, handleError: () => {},
    CodexAdapter: class {
      async start() { effects.push("start"); return {}; }
      stop() { effects.push("stop"); }
    }
  };
  const lifecycle = lifecycleScript.runInNewContext(context) as {
    ensureCodex(options?: { maintenance?: boolean }): Promise<void>;
    reloadCodexAppServer(reason: string, options?: { maintenance?: boolean }): Promise<void>;
    reconcileCodexCredentialsIfStale(reason: string): Promise<void>;
    queueCodexCredentialReload(reason: string): void;
  };
  const quitStatement = mainSource.statements.find((node) =>
    node.getText(mainSource).startsWith('app.on("before-quit",')
  );
  if (!quitStatement) throw new Error("Could not locate before-quit handler");
  const quitHandlers: Array<(event: { preventDefault(): void }) => void> = [];
  Object.assign(context, {
    macBookmarkStoppers: [], stopEngineConfigWatch: null,
    reconnectTimer: null, pairingTimer: null, socket: null,
    codexQuitInFlight: null,
    safeDisposeSocket: () => {},
    app: { on: (_event: string, handler: typeof quitHandlers[number]) => { quitHandlers.push(handler); },
      quit: () => { effects.push("quit"); } },
    clearTimeout
  });
  new Script(transpileModule(quitStatement.getText(mainSource), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
  }).outputText).runInNewContext(context);
  const update = () => manager.execute({ type: "host.engine.update", commandId: crypto.randomUUID(), cliEngine: "codex" });
  return { upgradeEntered, upgradeGate, effects, manager, context, lifecycle, update, quit: quitHandlers[0]! };
}

describe("Codex lifecycle maintenance protection", () => {
  it("serializes concurrent Codex bootstrap calls into one app-server", async () => {
    const f = fixture();
    let starts = 0;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    f.context.CodexAdapter = class {
      async start() {
        starts += 1;
        await startGate;
        return {};
      }
      stop() {}
    };

    const first = f.lifecycle.ensureCodex();
    const second = f.lifecycle.ensureCodex();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(starts).toBe(1);
    } finally {
      releaseStart();
      await Promise.all([first, second]);
    }
  });

  it("makes callers arriving during initialization wait until Codex is ready", async () => {
    const f = fixture();
    const entered = deferred();
    const gate = deferred();
    f.context.CodexAdapter = class {
      async start() { entered.resolve(); await gate.promise; return {}; }
      stop() {}
    };
    const first = f.lifecycle.ensureCodex();
    await entered.promise;
    let secondReady = false;
    const second = f.lifecycle.ensureCodex().then(() => { secondReady = true; });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(secondReady).toBe(false);
    } finally {
      gate.resolve();
      await Promise.all([first, second]);
    }
    expect(secondReady).toBe(true);
  });

  it("reclaims a failed initialization before allowing a fresh startup", async () => {
    const f = fixture();
    let starts = 0;
    let stops = 0;
    f.context.CodexAdapter = class {
      async start() {
        starts++;
        if (starts === 1) throw new Error("initialize rejected");
        return {};
      }
      stop() { stops++; }
    };
    await expect(f.lifecycle.ensureCodex()).rejects.toThrow("initialize rejected");
    expect(f.context.codex).toBeNull();
    expect(stops).toBe(1);
    await f.lifecycle.ensureCodex();
    expect(starts).toBe(2);
  });

  it("waits for the old app-server to exit before reloading it", async () => {
    const f = fixture();
    await f.lifecycle.ensureCodex();
    const entered = deferred();
    const gate = deferred();
    Object.assign(f.context.codex!, {
      stop: async () => { entered.resolve(); await gate.promise; }
    });
    f.effects.length = 0;
    const reloading = f.lifecycle.reloadCodexAppServer("test reload");
    await entered.promise;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(f.effects).not.toContain("start");
    } finally {
      gate.resolve();
      await reloading;
    }
    expect(f.effects.filter((item) => item === "start")).toHaveLength(1);
  });

  it("does not spawn Codex when shutdown began during PATH discovery", async () => {
    const f = fixture();
    const entered = deferred();
    const gate = deferred();
    f.context.applyLoginPathToProcess = async () => { entered.resolve(); await gate.promise; };
    const starting = f.lifecycle.ensureCodex();
    const result = starting.catch((error) => error);
    await entered.promise;
    f.context.quitting = true;
    gate.resolve();
    await result;
    expect(f.effects).not.toContain("start");
  });

  it("delays Electron quit until the Codex process tree has been stopped", async () => {
    const f = fixture();
    await f.lifecycle.ensureCodex();
    const entered = deferred();
    const gate = deferred();
    Object.assign(f.context.codex!, { stop: async () => { entered.resolve(); await gate.promise; } });
    let prevented = false;
    f.quit({ preventDefault: () => { prevented = true; } });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(prevented).toBe(true);
      expect(f.effects).not.toContain("quit");
    } finally {
      gate.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(f.effects.filter((effect) => effect === "quit")).toHaveLength(1);
  });

  it("keeps background bootstrap from starting while the desktop client is updating", async () => {
    const f = fixture();
    f.context.clientUpdateController.applying = true;
    await expect(f.lifecycle.ensureCodex()).rejects.toThrow(/安装更新/);
    expect(f.effects).toEqual([]);
    expect(f.context.clientOperations).toBe(0);
  });

  it.each(["ensure", "reload"] as const)("blocks a background %s while CLI files are being upgraded", async (action) => {
    const f = fixture();
    const updating = f.update();
    await f.upgradeEntered.promise;
    try {
      const background = action === "ensure"
        ? f.lifecycle.ensureCodex()
        : f.lifecycle.reloadCodexAppServer("background credential event");
      await expect(background).rejects.toThrow(/升级|维护/);
      expect(f.effects).toEqual([]);
    } finally {
      f.upgradeGate.resolve();
      await updating;
    }
  });

  it("reserves Codex before background bootstrap yields to PATH discovery", async () => {
    const f = fixture();
    const pathGate = deferred();
    f.context.applyLoginPathToProcess = () => pathGate.promise;
    const starting = f.lifecycle.ensureCodex();
    const upgrading = f.update();
    const upgradeResult = upgrading.then(() => undefined, (error) => error);
    // A broken implementation reaches upgrade; release its gate to expose that failure.
    f.upgradeGate.resolve();
    try {
      await expect(upgrading).rejects.toThrow(/运行|审批/);
    } finally {
      pathGate.resolve();
      await starting;
      await upgradeResult;
    }
    expect(f.effects).toContain("start");
    expect(f.manager.busyEngines()).not.toContain("codex");
  });

  it("defers an already scheduled credential reconcile without touching config during upgrade", async () => {
    const f = fixture();
    const updating = f.update();
    await f.upgradeEntered.promise;
    try {
      await f.lifecycle.reconcileCodexCredentialsIfStale("delayed credential event");
      expect(f.effects).toEqual([]);
      expect(f.context.pendingCodexAppServerReload).toBe("delayed credential event");
    } finally {
      f.upgradeGate.resolve();
      await updating;
    }
  });
});
