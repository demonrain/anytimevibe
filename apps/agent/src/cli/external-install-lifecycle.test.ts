import { EventEmitter } from "node:events";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileWithTreeKill } from "./exec-file-tree-kill";

const source = createSourceFile("main.ts", readFileSync(path.join(__dirname, "../main.ts"), "utf8"), ScriptTarget.Latest, true);
const names = new Set(["openWindowsVisibleConsole", "openWindowsPowerShellScript", "launchWindowsVisibleScript",
  "launchMacTerminalScriptFile", "trackExternalClientOperation", "reserveClientOperation", "withClientOperation"]);
const declarations = source.statements.filter(isFunctionDeclaration).filter((node) => names.has(node.name?.text || ""));
const script = new Script(transpileModule(`${declarations.map((node) => node.getText(source)).join("\n")}\n({
  openWindowsVisibleConsole, openWindowsPowerShellScript, launchMacTerminalScriptFile, withClientOperation
});`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(platform: "win32" | "darwin" = "win32") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anytimevibe-external-install-"));
  const children: EventEmitter[] = [];
  const launches: { executable: string; args: string[]; cwd?: string | undefined }[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  const context = {
    process: { platform, env: { SystemRoot: "C:\\Windows" } }, fs, path, os: { homedir: () => directory },
    app: { getPath: () => directory }, crypto: { randomUUID: () => crypto.randomUUID() },
    clientOperations: 0, clientUpdateController: { applying: false }, launcherError: false,
    setTimeout: (fn: () => void) => setTimeout(fn, 0), clearInterval,
    setInterval: (fn: () => void) => { const timer = setInterval(fn, 20); intervals.push(timer); return timer; },
    shellQuote: (text: string) => `'${text.replace(/'/g, `'\\''`)}'`,
    logWarn: () => {}, proxyShellLines: async () => [],
    spawn: (executable: string, args: string[], options: { cwd?: string }) => {
      launches.push({ executable, args, cwd: options.cwd });
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      children.push(child);
      queueMicrotask(() => context.launcherError ? child.emit("error", new Error("launcher unavailable")) : child.emit("spawn"));
      return child;
    }
  };
  const functions = script.runInNewContext(context) as {
    openWindowsVisibleConsole(lines: string[]): Promise<void>;
    openWindowsPowerShellScript(body: string): Promise<void>;
    launchMacTerminalScriptFile(file: string): Promise<void>;
    withClientOperation<T>(operation: () => Promise<T>): Promise<T>;
  };
  cleanups.push(async () => {
    intervals.forEach(clearInterval);
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function complete() {
    const nested = await fs.readdir(directory, { recursive: true });
    const runner = nested.find((file) => /(?:runner\.cmd|runner\.command)$/.test(file));
    expect(runner, "the external runner must report command completion").toBeDefined();
    await fs.writeFile(path.join(directory, path.dirname(runner!), "complete"), "complete\n");
  }
  return { ...functions, directory, context, children, launches, complete };
}

describe("external installer lifetime protects client upgrades", () => {
  it("keeps the client reserved after the installation entry point has returned", async () => {
    const f = await fixture();
    await f.withClientOperation(() => f.openWindowsVisibleConsole(["echo installing"]));
    expect(f.context.clientOperations).toBe(1);
    await f.complete();
    await vi.waitFor(() => expect(f.context.clientOperations).toBe(0));
  });

  it("releases after installation completes even while the console is displaying pause", async () => {
    const f = await fixture();
    await f.openWindowsVisibleConsole(["echo installing"]);
    expect(f.context.clientOperations).toBe(1);
    await f.complete();
    await vi.waitFor(() => expect(f.context.clientOperations).toBe(0));
    f.children[0]!.emit("close", 0);
    expect(f.context.clientOperations).toBe(0);
  });

  it("releases the Windows reservation when the launcher cannot be started", async () => {
    const f = await fixture();
    f.context.launcherError = true;
    await expect(f.openWindowsVisibleConsole(["echo installing"])).rejects.toThrow("launcher unavailable");
    expect(f.context.clientOperations).toBe(0);
  });

  it("keeps the reservation when a Windows launcher disappears without proof its children finished", async () => {
    const f = await fixture();
    await f.openWindowsVisibleConsole(["echo installing"]);
    f.children[0]!.emit("close", 1);
    expect(f.context.clientOperations).toBe(1);
    await f.complete();
    await vi.waitFor(() => expect(f.context.clientOperations).toBe(0));
  });

  it("does not release a macOS installer when the open launcher exits successfully", async () => {
    const f = await fixture("darwin");
    const payload = path.join(f.directory, "payload.command");
    await fs.writeFile(payload, "#!/bin/bash\necho installing\n");
    await f.withClientOperation(() => f.launchMacTerminalScriptFile(payload));
    f.children[0]!.emit("close", 0);
    expect(f.context.clientOperations).toBe(1);
    await f.complete();
    await vi.waitFor(() => expect(f.context.clientOperations).toBe(0));
  });

  it("releases a macOS reservation when Terminal cannot be opened", async () => {
    const f = await fixture("darwin");
    await f.launchMacTerminalScriptFile(path.join(f.directory, "missing.command"));
    f.children[0]!.emit("close", 1);
    expect(f.context.clientOperations).toBe(0);
  });

  it("also reserves external PowerShell installers until their command has finished", async () => {
    const f = await fixture();
    await f.withClientOperation(() => f.openWindowsPowerShellScript("Write-Host installing"));
    expect(f.context.clientOperations).toBe(1);
    await f.complete();
    await vi.waitFor(() => expect(f.context.clientOperations).toBe(0));
  });

  it.skipIf(process.platform !== "win32")("runs a delayed payload and records completion in a directory with shell metacharacters", async () => {
    const f = await fixture();
    const specialDirectory = path.join(f.directory, "space %ANYTIMEVIBE_UNUSED_TEST_VAR% ! &");
    await fs.mkdir(specialDirectory);
    f.context.app.getPath = () => specialDirectory;
    await f.withClientOperation(() => f.openWindowsVisibleConsole([
      `"${process.execPath}" -e "const fs=require('fs');fs.writeFileSync('started','yes');const timer=setInterval(()=>{if(fs.existsSync('gate')){clearInterval(timer);fs.writeFileSync('payload-finished','yes')}},10)"`
    ]));
    const cwd = f.launches[0]!.cwd!;
    const running = execFileWithTreeKill(process.env.ComSpec || "cmd.exe", ["/d", "/c", "runner.cmd"], {
      timeoutMs: 10_000, cwd, env: process.env
    });
    await vi.waitFor(async () => expect(await fs.readFile(path.join(cwd, "started"), "utf8")).toBe("yes"), { timeout: 5_000, interval: 50 });
    expect(f.context.clientOperations).toBe(1);
    await fs.writeFile(path.join(cwd, "gate"), "go");
    await running;
    expect(await fs.readFile(path.join(cwd, "payload-finished"), "utf8")).toBe("yes");
    await vi.waitFor(() => expect(f.context.clientOperations).toBe(0));
  });
});
