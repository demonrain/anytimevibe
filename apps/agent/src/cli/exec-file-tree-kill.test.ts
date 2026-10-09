import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";

// Exercise the real timeout logic, replacing only OS process and signal boundaries.
const source = createSourceFile("exec-file-tree-kill.ts", readFileSync(
  path.resolve("apps/agent/src/cli/exec-file-tree-kill.ts"), "utf8"
), ScriptTarget.Latest, true);
const functions = source.statements.filter(isFunctionDeclaration).map((node) => node.getText(source));
const executorScript = new Script(`${transpileModule(functions.join("\n"), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
}).outputText}\nexecFileWithTreeKill;`);

afterEach(() => vi.useRealTimers());

function fixture(platform: "darwin" | "win32") {
  vi.useFakeTimers();
  const signals: Array<[number, string]> = [];
  const launches: Array<{ command: string; options: { detached?: boolean } }> = [];
  const childEvents = new EventEmitter();
  const child = Object.assign(childEvents, {
    pid: 4242, killed: false, exitCode: null as number | null, signalCode: null as string | null,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill(signal = "SIGTERM") {
      signals.push([4242, signal]);
      this.killed = true;
      this.signalCode = signal;
      childEvents.emit("close", null, signal);
      return true;
    }
  });
  const taskkill = new EventEmitter();
  const run = executorScript.runInNewContext({
    exports: {},
    process: {
      platform, env: {},
      kill(pid: number, signal: string) {
        signals.push([pid, signal]);
        if (signal === "SIGTERM") {
          // The root exits gracefully, but a descendant may still need SIGKILL.
          child.killed = true;
          child.signalCode = signal;
          child.emit("close", null, signal);
        }
        return true;
      }
    },
    spawn(command: string, _args: string[], options: { detached?: boolean }) {
      launches.push({ command, options });
      return command === "taskkill" ? taskkill : child;
    },
    windowsNeedsCmdShim: () => false,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout
  }) as (command: string, args: string[], options: { timeoutMs: number }) => Promise<unknown>;
  let settled = false;
  const result = run("installer", [], { timeoutMs: 1000 }).then(
    () => { settled = true; return null; },
    (error) => { settled = true; return error; }
  );
  return { signals, launches, child, taskkill, result, settled: () => settled };
}

describe("installer timeout termination", () => {
  it("starts a Unix installer in its own process group", async () => {
    const f = fixture("darwin");
    try {
      expect(f.launches[0]?.options.detached).toBe(true);
    } finally {
      await vi.runAllTimersAsync();
      await f.result;
    }
  });

  it("kills Unix descendants even after the parent accepted SIGTERM", async () => {
    const f = fixture("darwin");
    await vi.runAllTimersAsync();
    expect(f.signals).toEqual([[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
    expect(await f.result).toMatchObject({ killed: true });
  });

  it("keeps the installer promise pending until Unix group escalation completes", async () => {
    const f = fixture("darwin");
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.settled()).toBe(false);
    } finally {
      await vi.runAllTimersAsync();
      await f.result;
    }
    expect(f.settled()).toBe(true);
  });

  it("waits for Windows taskkill to finish before releasing the installer promise", async () => {
    const f = fixture("win32");
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.launches[1]?.command).toBe("taskkill");
      expect(f.settled()).toBe(false);
    } finally {
      f.taskkill.emit("close", 0);
      await vi.runAllTimersAsync();
      await f.result;
    }
    expect(f.settled()).toBe(true);
  });
});
