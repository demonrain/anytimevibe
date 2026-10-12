import { afterEach, describe, expect, it } from "vitest";
import { promises as fs, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { CODEX_COMPAT_LABEL, CODEX_INSTALL_PACKAGE, isCodexCompatibleVersion } from "../codex-adapter";
import { normalizeWindowsCommandPath } from "../windows-command";
import { execFileWithTreeKill } from "./exec-file-tree-kill";
import { buildEngineUpgradeSteps } from "./engine-upgrade";
import { createEngineUpdateOutputRedactor } from "./update-network";
import { sanitizeEngineMaintenanceDetail } from "./engine-maintenance";

// Exercise the installation and discovery functions without launching Electron.
const source = createSourceFile("main.ts", readFileSync(path.resolve("apps/agent/src/main.ts"), "utf8"), ScriptTarget.Latest, true);
const names = [
  "installCodexOnWindows", "parseNodeMajorVersion", "codexVersionFromOutput", "detectEnvironment",
  "npmGlobalRoot", "npmGlobalPrefix", "resolveNpmGlobalCodexEntry", "npmGlobalCodexPackageComplete",
  "npmGlobalCodexPlatformReady", "ensureCodexWindowsLauncher", "discoverCodexOnWindows",
  "codexWindowsNpmShimEntry", "legacyCodexWindowsShimEntry", "withCodexWindowsNpmShimRepair"
];
const declarations = names.map((name) => {
  const declaration = source.statements.find((node) => isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Could not locate ${name}`);
  return declaration.getText(source);
});
const script = new Script(`${transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
}).outputText}\n({ ${names.join(", ")} });`);

function productionFunction(name: string): Script {
  const declaration = source.statements.find((node) => isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Could not locate ${name}`);
  return new Script(`${transpileModule(declaration.getText(source), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
  }).outputText}\n${name};`);
}

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

async function writeNpmPackage(prefix: string, version = "0.162.1", launcher = true): Promise<void> {
  const packageDir = path.join(prefix, "node_modules", "@openai", "codex");
  await fs.mkdir(path.join(packageDir, "bin"), { recursive: true });
  await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@openai/codex", version, bin: { codex: "bin/codex.js" } }));
  await fs.writeFile(path.join(packageDir, "bin", "codex.js"), `process.stdout.write('codex-cli ${version}\\n')`);
  if (launcher) {
    await fs.writeFile(path.join(prefix, "codex.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`);
  }
}

async function fixture(options: { failInstall?: boolean; launcher?: boolean } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "av-codex-install-"));
  tempDirs.push(temp);
  const defaultPrefix = path.join(temp, "Program Files", "nodejs");
  const appdata = path.join(temp, "User with spaces", "Roaming");
  const userPrefix = path.join(appdata, "npm");
  await fs.mkdir(path.join(temp, "home"), { recursive: true });
  await fs.mkdir(defaultPrefix, { recursive: true });
  await fs.mkdir(userPrefix, { recursive: true });
  const calls: string[][] = [];
  const states: Array<{ detail?: string; environment?: { codexCompatible: boolean } }> = [];
  const consoles: string[][] = [];
  let firstPathHit: string | null = null;
  const commandVersion = async (command: string): Promise<string | null> => {
    if (command === process.execPath) return process.version;
    try {
      const text = await fs.readFile(command, "utf8");
      const legacy = text.match(/SET "_CODEX_JS=([^"\r\n]+)"/i)?.[1];
      const entry = legacy || path.join(path.dirname(command), "node_modules", "@openai", "codex", "bin", "codex.js");
      const result = await execFileWithTreeKill(process.execPath, [entry, "--version"], { timeoutMs: 3000 });
      return result.stdout;
    } catch { return null; }
  };
  const context = {
    process: { platform: "win32", arch: "x64", env: { APPDATA: appdata, ProgramFiles: defaultPrefix } as NodeJS.ProcessEnv },
    fs, path, os: { homedir: () => path.join(temp, "home") }, normalizeWindowsCommandPath,
    CODEX_COMPAT_LABEL, CODEX_INSTALL_PACKAGE, isCodexCompatibleVersion,
    initialEnvironment: { platform: "windows" }, codexCommand: "codex.cmd", codexVersion: "unknown",
    extraWindowsPathDirs: [] as string[], cachedWindowsPath: null,
    // Network/package manager boundaries are simulated; package files and launchers are real.
    runNpmText: async (_npm: string, args: string[]) => {
      const prefix = args.find((arg) => arg.startsWith("--prefix="))?.slice(9) || defaultPrefix;
      return args[0] === "root" ? path.join(prefix, "node_modules") : prefix;
    },
    applyWindowsPathToProcess: async () => {}, applyLoginPathToProcess: async () => {},
    clearEngineBinaryCache: () => {},
    resolveWindowsPath: async () => [defaultPrefix, userPrefix].join(";"),
    findOnWindowsPath: async (command: string) => {
      if (command.startsWith("npm")) return path.join(defaultPrefix, "npm.cmd");
      if (command.startsWith("node")) return process.execPath;
      if (firstPathHit && command === "codex.cmd") return firstPathHit;
      if (command === "codex.cmd") {
        for (const prefix of [defaultPrefix, userPrefix]) {
          const hit = path.join(prefix, command);
          if (await exists(hit)) return hit;
        }
      }
      return null;
    },
    rememberNpmGlobalDirs: async () => {
      context.extraWindowsPathDirs = [...new Set([...context.extraWindowsPathDirs, defaultPrefix, userPrefix])];
      return context.extraWindowsPathDirs;
    },
    pathExists: exists, commandVersion,
    probeCodexVersionOutput: async (command: string) => {
      const raw = await commandVersion(command) || "Cannot find module";
      return { version: raw.match(/codex-cli\s+(\S+)/)?.[1] || null, raw };
    },
    runWindowsCommand: async (_npm: string, args: string[]) => {
      calls.push([...args]);
      const prefix = args.find((arg) => arg.startsWith("--prefix="))?.slice(9) || defaultPrefix;
      if (args[0] === "uninstall") {
        await fs.rm(path.join(prefix, "node_modules", "@openai", "codex"), { recursive: true, force: true });
        return;
      }
      if (options.failInstall) throw new Error("npm network unavailable");
      for (const name of ["codex", "codex.cmd", "codex.ps1"]) {
        const file = path.join(prefix, name);
        if (!(await exists(file))) continue;
        const text = await fs.readFile(file, "utf8");
        if (!/node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/.test(text) || /_CODEX_JS=/.test(text)) {
          throw new Error(`npm error code EEXIST\nnpm error path ${file}`);
        }
      }
      await writeNpmPackage(prefix, "0.162.1", options.launcher !== false);
    },
    updateState: (state: (typeof states)[number]) => states.push(state),
    openWindowsVisibleConsole: async (lines: string[]) => { consoles.push(lines); },
    app: { getPath: () => temp },
    logWarn: () => {}, logInfo: () => {},
    setTimeout: (fn: () => void) => setTimeout(fn, 0)
  };
  const functions = script.runInNewContext(context) as {
    installCodexOnWindows(): Promise<void>;
    discoverCodexOnWindows(): Promise<string | null>;
    resolveNpmGlobalCodexEntry(npm: string, prefix?: string): Promise<string | null>;
  };
  return { ...functions, context, calls, states, consoles, defaultPrefix, userPrefix, commandVersion,
    setFirstPathHit: (hit: string) => { firstPathHit = hit; } };
}

describe("Windows Codex one-click installation", () => {
  it("validates the requested user prefix when npm's default prefix has no Codex", async () => {
    const f = await fixture();
    await f.installCodexOnWindows();
    expect(f.calls.filter((args) => args[0] === "install")).toEqual([[
      "install", "-g", "--registry=https://registry.npmjs.org/", `--prefix=${f.userPrefix}`,
      "--include=optional", "--bin-links=true", "@openai/codex@latest"
    ]]);
    expect(f.context.codexCommand).toBe(path.join(f.userPrefix, "codex.cmd"));
    expect(f.states.at(-1)?.environment?.codexCompatible).toBe(true);
  });

  it("preserves another npm tree instead of uninstalling its Codex before user-prefix installation", async () => {
    const f = await fixture();
    await writeNpmPackage(f.defaultPrefix, "0.144.0");
    await f.installCodexOnWindows();
    expect(await f.commandVersion(path.join(f.defaultPrefix, "codex.cmd"))).toContain("0.144.0");
    expect(f.context.codexCommand).toBe(path.join(f.userPrefix, "codex.cmd"));
  });

  it("keeps the npm-generated cmd shim usable by the next npm install", async () => {
    const f = await fixture();
    await f.installCodexOnWindows();
    const first = await fs.readFile(path.join(f.userPrefix, "codex.cmd"), "utf8");
    await f.installCodexOnWindows();
    expect(await fs.readFile(path.join(f.userPrefix, "codex.cmd"), "utf8")).toBe(first);
    expect(first).toContain("%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js");
    expect(first).not.toContain("_CODEX_JS");
  });

  it("does not overwrite an unrelated codex.cmd on installation", async () => {
    const f = await fixture();
    const command = path.join(f.userPrefix, "codex.cmd");
    await fs.writeFile(command, "@echo off\r\necho my custom command\r\n");
    await expect(f.installCodexOnWindows()).rejects.toThrow(/codex\.cmd.*(不属于|无法确认)|不属于.*codex\.cmd/);
    expect(await fs.readFile(command, "utf8")).toContain("my custom command");
    expect(f.calls).toEqual([]);
  });

  it("preserves the previous working launcher when npm installation fails", async () => {
    const f = await fixture({ failInstall: true });
    await writeNpmPackage(f.userPrefix, "0.144.0");
    const command = path.join(f.userPrefix, "codex.cmd");
    const entry = path.join(f.userPrefix, "node_modules", "@openai", "codex", "bin", "codex.js");
    const legacy = `@ECHO off\r\nSETLOCAL\r\nSET "_CODEX_JS=${entry}"\r\nIF NOT EXIST "%_CODEX_JS%" (\r\n  echo Codex package missing: %_CODEX_JS% 1>&2\r\n  exit /b 1\r\n)\r\n"${process.execPath}" "%_CODEX_JS%" %*\r\n`;
    await fs.writeFile(command, legacy);
    await expect(f.installCodexOnWindows()).rejects.toThrow("npm network unavailable");
    expect(await fs.readFile(command, "utf8")).toBe(legacy);
    expect(await f.commandVersion(command)).toContain("0.144.0");
  });

  it("checks PowerShell shim collisions before changing the installed package", async () => {
    const f = await fixture();
    await writeNpmPackage(f.userPrefix, "0.144.0");
    const command = path.join(f.userPrefix, "codex.ps1");
    await fs.writeFile(command, "Write-Host 'my custom script'");
    await expect(f.installCodexOnWindows()).rejects.toThrow(/codex\.ps1.*(不属于|无法确认)|不属于.*codex\.ps1/);
    expect(await f.commandVersion(path.join(f.userPrefix, "codex.cmd"))).toContain("0.144.0");
    expect(f.calls).toEqual([]);
  });

  it("does not report success or open login when npm finishes without a working CLI", async () => {
    const f = await fixture({ launcher: false });
    await expect(f.installCodexOnWindows()).rejects.toThrow(/未检测到可用/);
    expect(f.consoles).toEqual([]);
  });
});

describe("Windows Codex command discovery", () => {
  it("skips an orphan shim before a working CLI in another npm prefix", async () => {
    const f = await fixture();
    const orphan = path.join(f.defaultPrefix, "codex.cmd");
    await fs.writeFile(orphan, '@echo off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    f.setFirstPathHit(orphan);
    await writeNpmPackage(f.userPrefix);
    f.context.extraWindowsPathDirs = [f.defaultPrefix, f.userPrefix];
    expect(await f.discoverCodexOnWindows()).toBe(path.join(f.userPrefix, "codex.cmd"));
  });
});

describe("Windows Codex upgrades", () => {
  it("repairs the legacy client shim before the web/desktop maintenance installer executes", async () => {
    const f = await fixture();
    await writeNpmPackage(f.userPrefix, "0.144.0");
    const command = path.join(f.userPrefix, "codex.cmd");
    const entry = path.join(f.userPrefix, "node_modules", "@openai", "codex", "bin", "codex.js");
    await fs.writeFile(command, `@ECHO off\r\nSETLOCAL\r\nSET "_CODEX_JS=${entry}"\r\nIF NOT EXIST "%_CODEX_JS%" (\r\n  echo Codex package missing: %_CODEX_JS% 1>&2\r\n  exit /b 1\r\n)\r\n"${process.execPath}" "%_CODEX_JS%" %*\r\n`);
    const context = Object.assign(f.context, {
      engineMaintenanceInstance: null,
      EngineMaintenance: class { constructor(readonly dependencies: unknown) {} },
      busyCodingEngines: () => [],
      resolveEngineUpgradeTarget: async () => ({
        engine: "codex", platform: "win32", binary: command,
        installation: { kind: "npm", command: "npm.cmd", prefix: f.userPrefix }
      }),
      buildEngineUpgradeSteps,
      collectLocalProxyEnv: async () => ({}), mergeProxyIntoEnv: () => ({}),
      refreshAgentUpdateNetwork: async () => {},
      buildEngineMaintenanceNetworkEnv: (env: NodeJS.ProcessEnv) => env,
      createEngineUpdateOutputRedactor,
      sanitizeEngineMaintenanceDetail,
      redactEngineUpdateOutput: (text: string) => text,
      execFileWithTreeKill: async (npm: string, args: string[]) => { await f.context.runWindowsCommand(npm, args); }
    });
    const factory = productionFunction("getEngineMaintenance").runInNewContext(context) as () => {
      dependencies: { upgrade(engine: string, version: string | undefined, onOutput: (chunk: string) => void): Promise<void> }
    };
    await factory().dependencies.upgrade("codex", undefined, () => {});
    expect(await f.commandVersion(command)).toContain("0.162.1");
    const backup = (await fs.readdir(f.userPrefix)).find((name) => name.startsWith(".anytimevibe-codex-backup-"));
    expect(backup).toBeTruthy();
    expect(await fs.readFile(path.join(f.userPrefix, backup!, "codex.cmd"), "utf8")).toContain("_CODEX_JS");
  });
});

// Opt-in smoke test: real official npm package and native CLI, only inside a
// temporary prefix. Never changes the machine's existing global installations.
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
describe("official Windows npm installation smoke test", () => {
  it.skipIf(process.platform !== "win32" || !existsSync(npmCli) || process.env.AV_CODEX_INSTALL_SMOKE !== "1")(
    "installs from scratch, migrates the old launcher and can reinstall without EEXIST", async () => {
      const f = await fixture();
      const npm = path.join(path.dirname(process.execPath), "npm.cmd");
      const originalFind = f.context.findOnWindowsPath;
      f.context.findOnWindowsPath = async (name: string) => name.startsWith("npm") ? npm : originalFind(name);
      f.context.process.env = {
        ...process.env, ...f.context.process.env, CODEX_COMMAND: "",
        npm_config_cache: path.join(f.userPrefix, "cache"), npm_config_omit: "optional", npm_config_bin_links: "false"
      };
      Object.assign(f.context, { execFileWithTreeKill });
      f.context.runWindowsCommand = productionFunction("runWindowsCommand").runInNewContext(f.context);
      const command = path.join(f.userPrefix, "codex.cmd");
      const entry = path.join(f.userPrefix, "node_modules", "@openai", "codex", "bin", "codex.js");
      await f.installCodexOnWindows();
      const firstVersion = await execFileWithTreeKill(command, ["--version"], { timeoutMs: 20000, env: process.env });
      expect(firstVersion.stdout).toMatch(/^codex-cli \d+\.\d+\.\d+/);
      expect(isCodexCompatibleVersion(firstVersion.stdout.trim().split(" ")[1])).toBe(true);
      await fs.writeFile(command, `@ECHO off\r\nSETLOCAL\r\nSET "_CODEX_JS=${entry}"\r\nIF NOT EXIST "%_CODEX_JS%" (\r\n  echo Codex package missing: %_CODEX_JS% 1>&2\r\n  exit /b 1\r\n)\r\n"${process.execPath}" "%_CODEX_JS%" %*\r\n`);
      await f.installCodexOnWindows();
      await f.installCodexOnWindows();
      const secondVersion = await execFileWithTreeKill(command, ["--version"], { timeoutMs: 20000, env: process.env });
      expect(secondVersion.stdout).toBe(firstVersion.stdout);
      expect(await fs.readFile(command, "utf8")).not.toContain("_CODEX_JS");
    }, 180000
  );
});
