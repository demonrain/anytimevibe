import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CliEngine, CliEngineInfo } from "@anytimevibe/protocol";
import { windowsCmdArguments } from "../windows-command";

const execFileAsync = promisify(execFile);

const resolvedCommandCache = new Map<string, string | null>();

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? process.env.ComSpec ?? "cmd.exe" : command;
    const finalArgs = isWindows ? windowsCmdArguments(command, args) : args;
    const { stdout, stderr } = await execFileAsync(executable, finalArgs, {
      timeout: 12_000,
      windowsHide: true,
      windowsVerbatimArguments: isWindows,
      env: process.env,
      maxBuffer: 256_000
    });
    const text = `${stdout || ""}\n${stderr || ""}`.trim();
    const line = text.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
    return line || text || null;
  } catch {
    return null;
  }
}

/** Resolve an absolute executable path so Electron (often PATH-starved) can spawn CLIs. */
export async function resolveCommandPath(command: string): Promise<string | null> {
  if (resolvedCommandCache.has(command)) return resolvedCommandCache.get(command) ?? null;
  if (path.isAbsolute(command) && await pathExists(command)) {
    resolvedCommandCache.set(command, command);
    return command;
  }

  const isWindows = process.platform === "win32";
  try {
    if (isWindows) {
      const { stdout } = await execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `where ${command}`], {
        timeout: 8_000,
        windowsHide: true,
        env: process.env,
        maxBuffer: 256_000
      });
      const hit = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (hit && await pathExists(hit)) {
        resolvedCommandCache.set(command, hit);
        return hit;
      }
    } else {
      const { stdout } = await execFileAsync("which", [command], {
        timeout: 8_000,
        env: process.env,
        maxBuffer: 256_000
      });
      const hit = stdout.trim();
      if (hit && await pathExists(hit)) {
        resolvedCommandCache.set(command, hit);
        return hit;
      }
    }
  } catch {
    // fall through to known install locations
  }

  const home = os.homedir();
  const candidates = isWindows
    ? [
        path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", `${command}.exe`),
        path.join(home, ".local", "bin", `${command}.exe`),
        path.join(home, ".grok", "bin", "grok.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", `${command}.cmd`),
        path.join(process.env.APPDATA || "", "npm", `${command}.cmd`)
      ]
    : [
        path.join(home, ".local", "bin", command),
        path.join(home, ".grok", "bin", "grok"),
        "/usr/local/bin/" + command,
        "/opt/homebrew/bin/" + command
      ];

  for (const candidate of candidates) {
    if (candidate && await pathExists(candidate)) {
      resolvedCommandCache.set(command, candidate);
      return candidate;
    }
  }

  // WinGet packages folder for Claude Code
  if (isWindows && command.toLowerCase().includes("claude")) {
    try {
      const wingetRoot = path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Packages");
      const entries = await fs.readdir(wingetRoot).catch(() => [] as string[]);
      for (const entry of entries) {
        if (!/ClaudeCode|Anthropic/i.test(entry)) continue;
        const exe = path.join(wingetRoot, entry, "claude.exe");
        if (await pathExists(exe)) {
          resolvedCommandCache.set(command, exe);
          return exe;
        }
      }
    } catch {
      // ignore
    }
  }

  resolvedCommandCache.set(command, null);
  return null;
}

function parseClaudeVersion(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? raw.slice(0, 80);
}

function parseGrokVersion(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/grok\s+([^\s]+)/i) || raw.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? raw.slice(0, 80);
}

export async function detectAvailableEngines(options: {
  codexReady: boolean;
  codexVersion: string;
}): Promise<CliEngineInfo[]> {
  const claudePath = await resolveEngineBinary("claude");
  const grokPath = await resolveEngineBinary("grok");
  const claudeRaw = claudePath ? await runVersion(claudePath, ["--version"]) : null;
  const grokRaw = grokPath ? await runVersion(grokPath, ["--version"]) : null;
  const claudeVersion = parseClaudeVersion(claudeRaw);
  const grokVersion = parseGrokVersion(grokRaw);

  return [
    {
      engine: "codex",
      ready: options.codexReady,
      ...(options.codexVersion !== "unknown" ? { version: options.codexVersion } : {}),
      ...(!options.codexReady ? { detail: "Codex CLI 未就绪（需要 0.144.x）" } : {})
    },
    {
      engine: "claude",
      ready: Boolean(claudePath && claudeVersion),
      ...(claudeVersion ? { version: claudeVersion } : { detail: "未检测到 claude 命令，请安装并登录 Claude Code CLI" })
    },
    {
      engine: "grok",
      ready: Boolean(grokPath && grokVersion),
      ...(grokVersion ? { version: grokVersion } : { detail: "未检测到 grok 命令，请安装 Grok Build CLI" })
    }
  ];
}

export async function resolveEngineBinary(engine: Exclude<CliEngine, "codex">): Promise<string | null> {
  if (engine === "claude") {
    if (process.env.CLAUDE_COMMAND) return resolveCommandPath(process.env.CLAUDE_COMMAND);
    return (await resolveCommandPath("claude"))
      || (await resolveCommandPath("claude.exe"))
      || (await resolveCommandPath("claude.cmd"));
  }
  if (process.env.GROK_COMMAND) return resolveCommandPath(process.env.GROK_COMMAND);
  return (await resolveCommandPath("grok"))
    || (await resolveCommandPath("grok.exe"))
    || (await resolveCommandPath("grok.cmd"));
}

/** @deprecated use resolveEngineBinary */
export function resolveEngineCommand(engine: Exclude<CliEngine, "codex">): string {
  if (engine === "claude") {
    return process.env.CLAUDE_COMMAND || (process.platform === "win32" ? "claude.exe" : "claude");
  }
  return process.env.GROK_COMMAND || (process.platform === "win32" ? "grok.exe" : "grok");
}
