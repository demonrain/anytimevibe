import type { CliEngine } from "@anytimevibe/protocol";
import { promises as fs } from "node:fs";
import path from "node:path";

export type EngineUpgradeInstallation =
  | { kind: "self" }
  | { kind: "pi-managed"; installRoot: string }
  | { kind: "npm"; command: string; prefix: string; repairScript?: string; nodeCommand?: string; registry?: string }
  | { kind: "brew"; command: string };
export type EngineUpgradeTarget = {
  engine: CliEngine;
  binary: string;
  platform: NodeJS.Platform;
  installation: EngineUpgradeInstallation;
  version?: string | undefined;
};
export type EngineUpgradeStep = { command: string; args: string[]; cwd?: string };

const NPM_PACKAGE_BY_ENGINE: Partial<Record<CliEngine, string>> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  pi: "@earendil-works/pi-coding-agent"
};

function safeVersion(version: string | undefined): string {
  const value = (version || "latest").trim();
  if (!/^(?:latest|\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.-]+)?)$/.test(value)) {
    throw new Error(`CLI 版本格式无效：${value}`);
  }
  return value;
}

function npmPackageSpec(engine: CliEngine, version: string | undefined): string {
  const packageName = NPM_PACKAGE_BY_ENGINE[engine];
  if (!packageName) throw new Error(`${engine} 没有受支持的 npm 升级包，请使用官方客户端升级方式。`);
  return `${packageName}@${safeVersion(version)}`;
}

export function buildEngineUpgradeSteps(target: EngineUpgradeTarget): EngineUpgradeStep[] {
  const { engine, binary, installation } = target;
  if (!binary.trim()) throw new Error("缺少编码引擎 CLI 路径");
  if (installation.kind === "pi-managed") {
    if (engine !== "pi") throw new Error(`${engine} does not support the Pi managed updater`);
    return [{ command: binary, args: ["update"] }];
  }
  if (installation.kind === "self") {
    if (engine === "claude" || engine === "cursor" || engine === "grok" || engine === "antigravity") {
      return [{ command: binary, args: ["update"] }];
    }
    throw new Error(`${engine} 的当前安装没有可验证的原生升级命令，请使用官方安装方式。`);
  }
  if (installation.kind === "brew") {
    if (engine !== "codex") throw new Error(`${engine} 不支持通过 Homebrew 升级。`);
    return [{ command: installation.command, args: ["upgrade", "--cask", "codex"] }];
  }
  const packageSpec = npmPackageSpec(engine, target.version);
  const prefixArgs = installation.prefix.trim()
    ? [`--prefix=${installation.prefix.trim()}`]
    : [];
  const steps: EngineUpgradeStep[] = [{
    command: installation.command,
    args: [
      "install", "-g", `--registry=${(installation.registry || "https://registry.npmjs.org").replace(/\/+$/, "")}/`, ...prefixArgs,
      ...(engine === "codex" && target.platform === "win32" ? ["--include=optional", "--bin-links=true"] : []),
      ...(engine === "pi" ? ["--ignore-scripts"] : []), packageSpec
    ]
  }];
  if (engine === "claude" && installation.repairScript && installation.nodeCommand) {
    steps.push({
      command: installation.nodeCommand,
      args: [installation.repairScript],
      cwd: path.dirname(installation.repairScript)
    });
  }
  return steps;
}

async function packageOwnedByBinary(prefix: string, engine: CliEngine, binary: string, launcherText: string): Promise<boolean> {
  const packageName = NPM_PACKAGE_BY_ENGINE[engine];
  if (!packageName) return false;
  for (const base of [prefix, path.join(prefix, "lib")]) {
    const packageDir = path.join(base, "node_modules", ...packageName.split("/"));
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8")) as { name?: unknown };
      if (parsed.name !== packageName) continue;
      const relative = path.relative(packageDir, binary);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) return true;
      const normalizedText = launcherText.replace(/\\/g, "/");
      const normalizedPackageDir = packageDir.replace(/\\/g, "/");
      if (normalizedText.toLowerCase().includes(normalizedPackageDir.toLowerCase())) return true;
      const adjacent = [prefix, path.join(prefix, "bin")].some((dir) => path.relative(dir, path.dirname(binary)) === "");
      if (adjacent && normalizedText.includes(packageName)) return true;
    } catch {
      // Try the other npm layout.
    }
  }
  return false;
}

/** Resolve Pi's official versioned managed layout, which provides `pi update`. */
export async function resolvePiManagedInstallRoot(binary: string): Promise<string | null> {
  const actual = await fs.realpath(binary).catch(() => binary);
  const binDir = path.dirname(actual);
  if (path.basename(actual).toLowerCase() !== "pi" || path.basename(binDir).toLowerCase() !== "bin") return null;

  const installRoot = path.resolve(path.dirname(binDir), "install");
  try {
    const marker = JSON.parse(await fs.readFile(path.join(installRoot, "managed-install.json"), "utf8")) as {
      kind?: unknown;
      schemaVersion?: unknown;
      layout?: unknown;
    };
    if (marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") return null;

    const version = (await fs.readFile(path.join(installRoot, "current-version"), "utf8")).trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return null;
    const releaseBinary = path.join(installRoot, "releases", version, "node_modules", ".bin", "pi");
    await fs.access(releaseBinary);
    return installRoot;
  } catch {
    return null;
  }
}

/** Identify the npm tree owning the binary; a standalone binary must return null. */
export async function resolveNpmEnginePrefix(binary: string, engine: CliEngine, defaultPrefix: string): Promise<string | null> {
  const actual = await fs.realpath(binary).catch(() => binary);
  const nodeModules = actual.replace(/\\/g, "/").indexOf("/node_modules/");
  const owningPrefix = nodeModules >= 0 ? actual.slice(0, nodeModules).replace(/[\\/]lib$/, "") : "";
  const candidates = [owningPrefix, defaultPrefix, path.dirname(actual), path.dirname(path.dirname(actual))]
    .map((value) => value.trim())
    .filter(Boolean);
  let launcherText = "";
  try {
    const stat = await fs.stat(binary);
    if (stat.size <= 64_000 && !/\.exe$/i.test(binary)) launcherText = await fs.readFile(binary, "utf8");
  } catch {
    // A missing or native binary cannot be proven to own an npm installation.
  }
  for (const prefix of [...new Set(candidates)]) {
    if (await packageOwnedByBinary(prefix, engine, actual, launcherText)) return prefix;
  }
  return null;
}
