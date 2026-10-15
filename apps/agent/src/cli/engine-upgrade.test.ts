import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildEngineUpgradeSteps, resolveNpmEnginePrefix, resolvePiManagedInstallRoot } from "./engine-upgrade";
import { execFileWithTreeKill } from "./exec-file-tree-kill";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("coding CLI upgrade commands", () => {
  it("installs Codex's native platform dependency and command shims even when npmrc disables them", () => {
    expect(buildEngineUpgradeSteps({
      engine: "codex", platform: "win32", binary: "C:\\npm\\codex.cmd", version: "0.162.1",
      installation: { kind: "npm", command: "C:\\Node\\npm.cmd", prefix: "C:\\npm" }
    })).toEqual([{
      command: "C:\\Node\\npm.cmd",
      args: ["install", "-g", "--registry=https://registry.npmjs.org/", "--prefix=C:\\npm", "--include=optional", "--bin-links=true", "@openai/codex@0.162.1"]
    }]);
  });

  it("uses the official Pi package in the existing npm prefix", () => {
    expect(buildEngineUpgradeSteps({
      engine: "pi", platform: "win32", binary: "C:\\Tools\\npm\\pi.cmd",
      installation: { kind: "npm", command: "C:\\Node\\npm.cmd", prefix: "C:\\Tools\\npm" }, version: "0.62.0"
    })).toEqual([{
      command: "C:\\Node\\npm.cmd",
      args: ["install", "-g", "--registry=https://registry.npmjs.org/", "--prefix=C:\\Tools\\npm", "--ignore-scripts", "@earendil-works/pi-coding-agent@0.62.0"]
    }]);
  });

  it("recognizes Pi's managed release binary even when the launcher resolves into .bin", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "av-pi-managed-release-"));
    tempDirs.push(agentDir);
    const installRoot = path.join(agentDir, "install");
    const version = "1.0.2";
    const binary = path.join(installRoot, "releases", version, "node_modules", ".bin", "pi");
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(path.join(installRoot, "managed-install.json"), JSON.stringify({
      kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1"
    }));
    await fs.writeFile(path.join(installRoot, "current-version"), `${version}\n`);
    await fs.writeFile(binary, "#!/bin/sh\n");

    expect(await resolvePiManagedInstallRoot(binary)).toBe(installRoot);
  });

  it("uses Pi's native updater only for a verified official managed installation", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "av-pi-managed-"));
    tempDirs.push(agentDir);
    const installRoot = path.join(agentDir, "install");
    const version = "1.0.2";
    const binary = path.join(agentDir, "bin", "pi");
    const releaseBinary = path.join(installRoot, "releases", version, "node_modules", ".bin", "pi");
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.mkdir(path.dirname(releaseBinary), { recursive: true });
    await fs.writeFile(binary, "#!/bin/sh\n");
    await fs.writeFile(path.join(installRoot, "managed-install.json"), JSON.stringify({
      kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1",
      entrypoint: { type: "symlink", path: binary }
    }));
    await fs.writeFile(path.join(installRoot, "current-version"), `${version}\n`);
    await fs.writeFile(releaseBinary, "#!/bin/sh\n");

    expect(await resolvePiManagedInstallRoot(binary)).toBe(installRoot);
    expect(buildEngineUpgradeSteps({
      engine: "pi", platform: process.platform, binary, version,
      installation: { kind: "pi-managed", installRoot }
    })).toEqual([{ command: binary, args: ["update"] }]);
  });

  it("does not classify an unmarked Pi binary as an official managed installation", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "av-pi-unmarked-"));
    tempDirs.push(agentDir);
    const binary = path.join(agentDir, "bin", "pi");
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, "standalone pi binary");

    expect(await resolvePiManagedInstallRoot(binary)).toBeNull();
    expect(() => buildEngineUpgradeSteps({
      engine: "pi", platform: process.platform, binary, installation: { kind: "self" }
    })).toThrow(/升级命令|官方安装/);
  });

  it("uses the resolved Cursor binary rather than the colliding Grok agent on PATH", () => {
    expect(buildEngineUpgradeSteps({
      engine: "cursor", platform: "win32", binary: "C:\\Cursor\\agent.cmd", installation: { kind: "self" }
    })).toEqual([{ command: "C:\\Cursor\\agent.cmd", args: ["update"] }]);
  });

  it("uses native Claude self-update without installing a parallel npm copy", () => {
    expect(buildEngineUpgradeSteps({
      engine: "claude", platform: "win32", binary: "C:\\Users\\dev\\.local\\bin\\claude.exe", installation: { kind: "self" }
    })).toEqual([{ command: "C:\\Users\\dev\\.local\\bin\\claude.exe", args: ["update"] }]);
  });

  it("repairs the npm Claude native launcher only using its own package installer", () => {
    expect(buildEngineUpgradeSteps({
      engine: "claude", platform: "win32", binary: "C:\\npm\\claude.cmd",
      installation: { kind: "npm", command: "npm.cmd", prefix: "C:\\npm", repairScript: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\install.cjs", nodeCommand: "node.exe" }
    })).toEqual([
      { command: "npm.cmd", args: ["install", "-g", "--registry=https://registry.npmjs.org/", "--prefix=C:\\npm", "@anthropic-ai/claude-code@latest"] },
      { command: "node.exe", args: ["C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\install.cjs"], cwd: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code" }
    ]);
  });

  it("updates a Homebrew Codex cask in place", () => {
    expect(buildEngineUpgradeSteps({
      engine: "codex", platform: "darwin", binary: "/opt/homebrew/bin/codex", installation: { kind: "brew", command: "/opt/homebrew/bin/brew" }
    })).toEqual([{ command: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "codex"] }]);
  });

  it("does not invent self-update commands for standalone Codex or Pi installations", () => {
    for (const engine of ["codex", "pi"] as const) {
      expect(() => buildEngineUpgradeSteps({ engine, platform: "win32", binary: `${engine}.exe`, installation: { kind: "self" } })).toThrow(/安装|手动/);
    }
  });

  it("rejects malformed vendor versions before invoking Windows command shims", () => {
    expect(() => buildEngineUpgradeSteps({
      engine: "codex", platform: "win32", binary: "codex.cmd", version: "1.0.0 & injected",
      installation: { kind: "npm", command: "npm.cmd", prefix: "C:\\npm" }
    })).toThrow(/版本/);
  });

  it("recognizes the package actually owning a npm CLI launcher", async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), "av-engine-upgrade-"));
    tempDirs.push(prefix);
    const packageDir = path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    const binary = path.join(prefix, "pi.cmd");
    await fs.writeFile(binary, "@echo off\nnode \"%~dp0node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js\" %*");
    expect(await resolveNpmEnginePrefix(binary, "pi", prefix)).toBe(prefix);
    // An unrelated custom binary must not cause a parallel npm install to be upgraded.
    const custom = path.join(prefix, "custom", "pi.exe");
    await fs.mkdir(path.dirname(custom));
    await fs.writeFile(custom, "standalone-native-binary");
    expect(await resolveNpmEnginePrefix(custom, "pi", prefix)).toBeNull();
  });

  it("recognizes Pi's npm package behind a Windows command shim", async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), "av-pi-npm-shim-"));
    tempDirs.push(prefix);
    const packageDir = path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    const binary = path.join(prefix, "pi.cmd");
    await fs.writeFile(binary, "@echo off\nnode \"%~dp0node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js\" %*\n");

    expect(await resolveNpmEnginePrefix(binary, "pi", prefix)).toBe(prefix);
  });
});

describe("upgrade process execution", () => {
  it("reports streamed process output and honors the requested working directory", async () => {
    const chunks: string[] = [];
    const result = await execFileWithTreeKill(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
      timeoutMs: 3000, cwd: os.tmpdir(), onOutput: (text: string) => chunks.push(text)
    } as Parameters<typeof execFileWithTreeKill>[2]);
    expect(result.stdout.toLowerCase()).toBe(os.tmpdir().toLowerCase());
    expect(chunks.join("")).toBe(result.stdout);
  });

  it("rejects command failure instead of reporting success on process close", async () => {
    await expect(execFileWithTreeKill(process.execPath, ["-e", "process.stderr.write('upgrade failed');process.exit(17)"], {
      timeoutMs: 3000
    })).rejects.toMatchObject({ code: 17, stderr: "upgrade failed" });
  });

  it("rejects a process terminated by a signal instead of treating a null exit code as success", async () => {
    const failure = await execFileWithTreeKill(process.execPath, [
      "-e", "process.kill(process.pid, 'SIGTERM')"
    ], { timeoutMs: 3000 }).then(() => null, (error) => error as { code?: number | null; signal?: string | null });
    expect(failure).not.toBeNull();
    expect(process.platform === "win32" ? failure?.code : failure?.signal)
      .toBe(process.platform === "win32" ? 1 : "SIGTERM");
  });
});
