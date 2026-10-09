import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";
import type { CliEngineInfo, ClientCommand } from "@anytimevibe/protocol";
import { EngineMaintenance } from "./engine-maintenance";

// Execute the real queue drain without starting main.ts's Electron application.
// Only disk/network/native-task boundaries are supplied by the fixture below.
const mainSource = createSourceFile(
  "main.ts", readFileSync(path.resolve("apps/agent/src/main.ts"), "utf8"), ScriptTarget.Latest, true
);
const drainDeclaration = mainSource.statements.find((node) =>
  isFunctionDeclaration(node) && node.name?.text === "drainTurnQueue"
);
if (!drainDeclaration) throw new Error("Could not locate the production queue drain");
const drainScript = new Script(`${transpileModule(drainDeclaration.getText(mainSource), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
}).outputText}\ndrainTurnQueue;`);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(blockAt: "persist" | "publish") {
  const gate = deferred();
  const threadId = "queued-thread";
  const commandId = crypto.randomUUID();
  const queues = new Map([[threadId, [{ commandId, prompt: "Keep this queued request" }]]]);
  const started: string[] = [];
  let engines: CliEngineInfo[] = [{ engine: "pi", ready: true, version: "1.0.0", latestVersion: "1.1.0" }];
  const maintenance = new EngineMaintenance({
    busyEngines: () => queues.size ? ["pi"] : [],
    installedEngine: (engine) => engines.find((item) => item.engine === engine),
    detect: async () => engines,
    prepareUpdate: async () => {},
    upgrade: async () => { engines = [{ engine: "pi", ready: true, version: "1.1.0", latestVersion: "1.1.0" }]; },
    reload: async () => {},
    syncModels: async () => {},
    notify: async () => {}
  });
  const drain = drainScript.runInNewContext({
    isThreadTurnBusy: () => false,
    pendingCodexSteeringByThread: new Map(),
    resolveActivityEngine: () => "pi",
    engineMaintenanceInstance: maintenance,
    getEngineMaintenance: () => maintenance,
    isThreadDeleted: () => false,
    turnQueueByThread: queues,
    persistTurnQueue: () => blockAt === "persist" ? gate.promise : Promise.resolve(),
    publishTurnQueueUpdated: () => blockAt === "publish" ? gate.promise : Promise.resolve(),
    queuedCommandIds: new Set([commandId]),
    logInfo: () => {},
    handleCommandImpl: async (command: Extract<ClientCommand, { type: "turn.start" }>) => {
      const release = maintenance.reserveRun("pi");
      try { started.push(command.prompt); } finally { release(); }
    },
    publishCommandStatus: async () => {}
  }) as (threadId: string) => Promise<void>;
  return { gate, threadId, queues, started, maintenance, drain };
}

describe("queue drain maintenance protection", () => {
  it.each(["persist", "publish"] as const)("rejects an upgrade while a dequeued request awaits %s", async (blockAt) => {
    const f = fixture(blockAt);
    const draining = f.drain(f.threadId);
    // Attach the rejection handler before advancing either asynchronous flow.
    const settled = draining.then(() => undefined, (error) => error);
    if (blockAt === "publish") await Promise.resolve();
    try {
      await expect(f.maintenance.execute({
        type: "host.engine.update", commandId: crypto.randomUUID(), cliEngine: "pi"
      })).rejects.toThrow(/运行|审批/);
    } finally {
      f.gate.resolve();
      await settled;
    }
    expect(await settled).toBeUndefined();
    expect(f.started).toEqual(["Keep this queued request"]);
    expect(f.queues.size).toBe(0);
    expect(f.maintenance.busyEngines()).not.toContain("pi");
    // Releasing the drain reservation must allow later maintenance.
    await f.maintenance.execute({
      type: "host.engine.update", commandId: crypto.randomUUID(), cliEngine: "pi"
    });
    expect(f.maintenance.operation?.phase).toBe("completed");
  });
});
