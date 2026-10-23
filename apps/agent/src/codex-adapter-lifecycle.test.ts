import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as realSetTimeout, clearTimeout as realClearTimeout } from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killProcessTree } from "./cli/exec-file-tree-kill";

// Keep process creation real; never read a developer's provider credentials.
vi.mock("./cli/codex-gateway", () => ({
  resolveCodexOpenaiBaseUrlForEnv: async () => null,
  resolveCodexRelayKeyMaterial: async () => null,
  assignCodexApiKeyEnv: () => {}
}));

import { CodexAdapter } from "./codex-adapter";

const directories: string[] = [];
const adapters: CodexAdapter[] = [];
const fixtures: ChildProcess[] = [];

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function fixture(rejectInitialize = false, ignoreInitialize = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "av-codex-lifecycle-"));
  directories.push(directory);
  const script = path.join(directory, "server.cjs");
  await fs.writeFile(script, `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const worker = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], {windowsHide:true, stdio:['ignore','pipe','ignore']});
const pids = {server:process.pid, worker:worker.pid};
fs.writeFileSync(${JSON.stringify(path.join(directory, "pids.json"))}, JSON.stringify(pids));
const ready = new Promise(resolve => worker.stdout.once('data', resolve));
createInterface({input:process.stdin}).on('line', async line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  await ready;
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({method:'fixture/initializing'})+'\\n');
    if (${ignoreInitialize}) return;
  }
  if (message.method === 'initialize' && ${rejectInitialize}) {
    process.stdout.write(JSON.stringify({id:message.id,error:{message:'fixture initialize rejected'}})+'\\n');
  } else {
    process.stdout.write(JSON.stringify({id:message.id,result:pids})+'\\n');
  }
});
`);
  const command = path.join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
  await fs.writeFile(command, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  const exits: string[] = [];
  let notifyExited!: () => void;
  const exited = new Promise<void>((resolve) => { notifyExited = resolve; });
  let notifyInitializing!: () => void;
  const initializing = new Promise<void>((resolve) => { notifyInitializing = resolve; });
  const adapter = new CodexAdapter(command, (message) => {
    if (message.method === "fixture/initializing") notifyInitializing();
  }, (detail) => { exits.push(detail); notifyExited(); });
  adapters.push(adapter);
  return { adapter, directory, exits, initializing, exited };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const adapter of adapters.splice(0)) await adapter.stop();
  for (const child of fixtures.splice(0)) await killProcessTree(child);
  for (const directory of directories.splice(0)) {
    // Only PIDs written by our controlled fixture; never select real Codex by name.
    try {
      const pids = JSON.parse(await fs.readFile(path.join(directory, "pids.json"), "utf8"));
      for (const pid of [pids.worker, pids.server]) {
        if (alive(pid)) try { process.kill(pid); } catch { /* exited */ }
      }
    } catch { /* fixture did not start */ }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("CodexAdapter process lifecycle", () => {
  it("reclaims the launcher and worker over repeated start/stop cycles without touching unrelated processes", async () => {
    const f = await fixture();
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      windowsHide: true, detached: process.platform !== "win32", stdio: "ignore"
    });
    fixtures.push(unrelated);
    await new Promise<void>((resolve, reject) => { unrelated.once("spawn", resolve); unrelated.once("error", reject); });
    for (let cycle = 0; cycle < 2; cycle++) {
      await f.adapter.start();
      const pids = await f.adapter.request<{ server: number; worker: number }>("fixture/pids");
      expect(alive(pids.server)).toBe(true);
      expect(alive(pids.worker)).toBe(true);
      await f.adapter.stop({ intentional: true });
      expect(alive(pids.server)).toBe(false);
      expect(alive(pids.worker)).toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
    }
    expect(f.exits).toEqual([]);
  }, 15_000);

  it("cleans the process tree when the initialize RPC is rejected", async () => {
    const f = await fixture(true);
    await expect(f.adapter.start()).rejects.toThrow("fixture initialize rejected");
    const pids = JSON.parse(await fs.readFile(path.join(f.directory, "pids.json"), "utf8"));
    expect(alive(pids.server)).toBe(false);
    expect(alive(pids.worker)).toBe(false);
  });

  it("reclaims the real process tree before reporting an app-server pipe failure", async () => {
    const f = await fixture();
    await f.adapter.start();
    const pids = await f.adapter.request<{ server: number; worker: number }>("fixture/pids");
    // Simulate only the OS pipe error; launch and termination stay real.
    const child = (f.adapter as unknown as { process: ChildProcess }).process;
    child.stdin!.emit("error", new Error("fixture broken pipe"));
    await f.exited;
    expect(alive(pids.server)).toBe(false);
    expect(alive(pids.worker)).toBe(false);
    expect(f.exits).toEqual(["fixture broken pipe"]);
  });

  it("rejects pending initialization on spawn failure instead of hanging forever", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "av-codex-missing-"));
    directories.push(directory);
    let notifyExit!: () => void;
    const exited = new Promise<void>((resolve) => { notifyExit = resolve; });
    const adapter = new CodexAdapter(path.join(directory, "missing.exe"), () => {}, notifyExit);
    adapters.push(adapter);
    let failed = false;
    const starting = adapter.start().catch(() => { failed = true; });
    try {
      await exited;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(failed).toBe(true);
    } finally {
      await adapter.stop();
      await starting;
    }
  });

  it("times out an unresponsive initialization and reclaims its process tree", async () => {
    const f = await fixture(false, true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = f.adapter.start().then(() => null, (error: Error) => error);
    let deadline: ReturnType<typeof realSetTimeout> | undefined;
    try {
      await f.initializing;
      // Include the Unix process-group termination grace period.
      await vi.advanceTimersByTimeAsync(32_000);
      const outcome = await Promise.race([result, new Promise<string>((resolve) => {
        deadline = realSetTimeout(() => resolve("still waiting"), 2500);
      })]);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/initializ.*timed out/i);
      const pids = JSON.parse(await fs.readFile(path.join(f.directory, "pids.json"), "utf8"));
      expect(alive(pids.server)).toBe(false);
      expect(alive(pids.worker)).toBe(false);
    } finally {
      if (deadline) realClearTimeout(deadline);
      vi.useRealTimers();
      await f.adapter.stop();
      await result;
    }
  });
});
