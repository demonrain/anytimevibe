import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CliEngine, CliEngineInfo } from "@anytimevibe/protocol";
import {
  windowsCmdArguments,
  windowsExecutableRank,
  windowsLauncherCandidates
} from "../windows-command";

const execFileAsync = promisify(execFile);

const resolvedCommandCache = new Map<string, string | null>();

/** Clear binary resolution cache (call after install / recheck). */
export function clearEngineBinaryCache(): void {
  resolvedCommandCache.clear();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the best spawnable Windows path.
 * npm global installs often leave both `claude` (bash shim) and `claude.cmd`;
 * `where` may return the extensionless file first, which spawn() cannot run (ENOENT).
 */
async function preferWindowsExecutable(hits: string[]): Promise<string | null> {
  const expanded: string[] = [];
  for (const hit of hits) {
    const trimmed = hit?.trim();
    if (!trimmed) continue;
    for (const candidate of windowsLauncherCandidates(trimmed)) {
      if (!expanded.includes(candidate)) expanded.push(candidate);
    }
  }
  const existing: string[] = [];
  for (const candidate of expanded) {
    if (await pathExists(candidate)) existing.push(candidate);
  }
  if (!existing.length) return null;
  existing.sort((a, b) => windowsExecutableRank(a) - windowsExecutableRank(b));
  return existing[0] ?? null;
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

function enrichedPathEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extras = process.platform === "win32"
    ? [
        path.join(home, ".grok", "bin"),
        path.join(home, ".local", "bin"),
        path.join(home, ".cursor", "bin"),
        path.join(process.env.LOCALAPPDATA || "", "cursor-agent"),
        path.join(process.env.LOCALAPPDATA || "", "Programs", "claude"),
        path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links"),
        path.join(process.env.APPDATA || "", "npm"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs")
      ]
    : [
        path.join(home, ".grok", "bin"),
        path.join(home, ".local", "bin"),
        path.join(home, ".cursor", "bin"),
        path.join(home, ".claude", "local"),
        "/opt/homebrew/bin",
        "/usr/local/bin"
      ];
  const sep = process.platform === "win32" ? ";" : ":";
  const current = process.env.PATH || process.env.Path || "";
  const merged = [...extras.filter(Boolean), current].join(sep);
  return { ...process.env, PATH: merged, Path: merged };
}

/** Resolve an absolute executable path so Electron (often PATH-starved) can spawn CLIs. */
export async function resolveCommandPath(command: string): Promise<string | null> {
  if (resolvedCommandCache.has(command)) return resolvedCommandCache.get(command) ?? null;

  const isWindows = process.platform === "win32";
  if (path.isAbsolute(command)) {
    if (isWindows) {
      const preferred = await preferWindowsExecutable([command]);
      if (preferred) {
        resolvedCommandCache.set(command, preferred);
        return preferred;
      }
    } else if (await pathExists(command)) {
      resolvedCommandCache.set(command, command);
      return command;
    }
  }

  const env = enrichedPathEnv();
  try {
    if (isWindows) {
      // where.exe lists every match; prefer .cmd/.exe over extensionless npm shims.
      const whereTargets = /\.(cmd|exe|bat|com)$/i.test(command)
        ? [command]
        : [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`];
      const hits: string[] = [];
      for (const target of whereTargets) {
        try {
          const { stdout } = await execFileAsync("where.exe", [target], {
            timeout: 8_000,
            windowsHide: true,
            env,
            maxBuffer: 256_000
          });
          for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
            if (!hits.includes(line)) hits.push(line);
          }
        } catch {
          // try next target
        }
      }
      const preferred = await preferWindowsExecutable(hits);
      if (preferred) {
        resolvedCommandCache.set(command, preferred);
        return preferred;
      }
    } else {
      const { stdout } = await execFileAsync("/bin/bash", ["-lc", `command -v ${command} || true`], {
        timeout: 8_000,
        env,
        maxBuffer: 256_000
      });
      const hit = stdout.trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean);
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
        // Prefer .cmd/.exe first — never pick extensionless npm bash shims before them.
        path.join(process.env.APPDATA || "", "npm", `${command}.cmd`),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", `${command}.cmd`),
        path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", `${command}.exe`),
        path.join(home, ".local", "bin", `${command}.exe`),
        path.join(home, ".local", "bin", `${command}.cmd`),
        path.join(home, ".grok", "bin", "grok.exe"),
        path.join(home, ".grok", "bin", `${command}.exe`),
        path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe"),
        path.join(home, ".local", "bin", command),
        path.join(home, ".grok", "bin", command)
      ]
    : [
        path.join(home, ".local", "bin", command),
        path.join(home, ".grok", "bin", "grok"),
        path.join(home, ".grok", "bin", command),
        path.join(home, ".claude", "local", "claude"),
        path.join(home, ".claude", "local", command),
        "/usr/local/bin/" + command,
        "/opt/homebrew/bin/" + command,
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude"
      ];

  if (isWindows) {
    const preferred = await preferWindowsExecutable(candidates.filter(Boolean));
    if (preferred) {
      resolvedCommandCache.set(command, preferred);
      return preferred;
    }
  } else {
    for (const candidate of candidates) {
      if (candidate && await pathExists(candidate)) {
        resolvedCommandCache.set(command, candidate);
        return candidate;
      }
    }
  }

  // WinGet packages folder for Claude Code
  if (isWindows && command.toLowerCase().includes("claude")) {
    try {
      const wingetRoot = path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Packages");
      const entries = await fs.readdir(wingetRoot).catch(() => [] as string[]);
      for (const entry of entries) {
        if (!/ClaudeCode|Anthropic/i.test(entry)) continue;
        // Package layout varies: claude.exe may be nested
        const direct = path.join(wingetRoot, entry, "claude.exe");
        if (await pathExists(direct)) {
          resolvedCommandCache.set(command, direct);
          return direct;
        }
        try {
          const nested = await fs.readdir(path.join(wingetRoot, entry));
          for (const name of nested) {
            const exe = path.join(wingetRoot, entry, name, "claude.exe");
            if (await pathExists(exe)) {
              resolvedCommandCache.set(command, exe);
              return exe;
            }
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  // Do not cache null permanently — install may happen between checks.
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

function parseCursorVersion(raw: string | null): string | undefined {
  if (!raw) return undefined;
  // Avoid treating Grok's `agent` binary as Cursor (common PATH name collision).
  if (/grok/i.test(raw) && !/cursor/i.test(raw)) return undefined;
  const match = raw.match(/(\d{4}\.\d{2}\.\d{2}[-\w]*)/i)
    || raw.match(/(\d+\.\d+\.\d+[-\w]*)/)
    || raw.match(/cursor[^\d]*([0-9][^\s]*)/i);
  return match?.[1] ?? (raw.length < 80 ? raw : raw.slice(0, 80));
}

/** True when this executable looks like Cursor Agent CLI (not Grok `agent`). */
async function looksLikeCursorAgent(command: string): Promise<boolean> {
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  // Never treat Grok Build's agent.exe as Cursor (common Windows PATH collision).
  if (normalized.includes("/.grok/") || normalized.includes("\\/.grok\\") || /\/\.grok\//.test(normalized)) {
    return false;
  }
  if (/[/\\]\.grok[/\\]/.test(command.replace(/\\/g, "/"))) return false;

  const help = await runVersion(command, ["--help"]);
  const version = await runVersion(command, ["--version"]);
  const text = `${help || ""}\n${version || ""}`;
  if (!text.trim()) return false;
  if (/grok\s+build|Grok Build TUI|Usage:\s*grok\b/i.test(text)) return false;
  // Cursor Agent CLI markers (https://cursor.com/docs/cli)
  if (/cursor\s*agent|--stream-partial-output|--list-models|--workspace\b|CURSOR_API_KEY/i.test(text)) {
    return true;
  }
  if (/--print|--output-format|stream-json|--force|--yolo/i.test(text) && !/grok/i.test(text)) {
    return true;
  }
  if (parseCursorVersion(version) && !/grok/i.test(text)) return true;
  return false;
}

export async function detectAvailableEngines(options: {
  codexReady: boolean;
  codexVersion: string;
}): Promise<CliEngineInfo[]> {
  clearEngineBinaryCache();
  const claudePath = await resolveEngineBinary("claude");
  const grokPath = await resolveEngineBinary("grok");
  const cursorPath = await resolveEngineBinary("cursor");
  const claudeRaw = claudePath ? await runVersion(claudePath, ["--version"]) : null;
  const grokRaw = grokPath ? await runVersion(grokPath, ["--version"]) : null;
  const cursorRaw = cursorPath ? await runVersion(cursorPath, ["--version"]) : null;
  const claudeVersion = parseClaudeVersion(claudeRaw);
  const grokVersion = parseGrokVersion(grokRaw);
  const cursorVersion = parseCursorVersion(cursorRaw);

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
      ...(claudeVersion ? { version: claudeVersion } : { detail: claudePath ? "claude 已找到但无法读取版本" : "未检测到 claude 命令，请安装并登录 Claude Code CLI" })
    },
    {
      engine: "grok",
      ready: Boolean(grokPath && grokVersion),
      ...(grokVersion ? { version: grokVersion } : { detail: grokPath ? "grok 已找到但无法读取版本" : "未检测到 grok 命令，请安装 Grok Build CLI" })
    },
    {
      engine: "cursor",
      ready: Boolean(cursorPath && (cursorVersion || cursorRaw)),
      ...(cursorVersion || cursorRaw
        ? { version: cursorVersion || String(cursorRaw).slice(0, 40) }
        : {
          detail: cursorPath
            ? "cursor agent 已找到但无法读取版本"
            : "未检测到 Cursor Agent CLI（agent / cursor-agent），请安装并登录"
        })
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
  if (engine === "cursor") {
    if (process.env.CURSOR_COMMAND) {
      const forced = await resolveCommandPath(process.env.CURSOR_COMMAND);
      if (forced && await looksLikeCursorAgent(forced)) return forced;
      if (forced) console.warn("[detect] CURSOR_COMMAND is not Cursor Agent CLI:", forced);
    }
    if (process.env.CURSOR_AGENT_COMMAND) {
      const forced = await resolveCommandPath(process.env.CURSOR_AGENT_COMMAND);
      if (forced && await looksLikeCursorAgent(forced)) return forced;
    }
    // Prefer unambiguous names first — bare `agent` collides with Grok on Windows
    // (C:\Users\…\.grok\bin\agent.exe is Grok Build TUI, not Cursor).
    const named = (await resolveCommandPath("cursor-agent"))
      || (await resolveCommandPath("cursor-agent.exe"))
      || (await resolveCommandPath("cursor-agent.cmd"));
    if (named && await looksLikeCursorAgent(named)) return named;
    if (named) {
      // Name matched but failed signature check — ignore.
    }
    const home = os.homedir();
    // Cursor install locations only (see https://cursor.com/cn/cli). Never scan .grok.
    const localCandidates = process.platform === "win32"
      ? [
          path.join(home, ".local", "bin", "agent.exe"),
          path.join(home, ".local", "bin", "cursor-agent.exe"),
          path.join(home, ".local", "bin", "agent.cmd"),
          path.join(home, ".local", "bin", "agent"),
          path.join(home, ".cursor", "bin", "agent.exe"),
          path.join(home, ".cursor", "bin", "cursor-agent.exe"),
          path.join(home, ".cursor", "bin", "agent"),
          path.join(process.env.LOCALAPPDATA || "", "cursor-agent", "agent.exe"),
          path.join(process.env.LOCALAPPDATA || "", "cursor-agent", "cursor-agent.exe")
        ]
      : [
          path.join(home, ".local", "bin", "agent"),
          path.join(home, ".local", "bin", "cursor-agent"),
          path.join(home, ".cursor", "bin", "agent"),
          path.join(home, ".cursor", "bin", "cursor-agent")
        ];
    for (const candidate of localCandidates) {
      if (!candidate || !(await pathExists(candidate))) continue;
      if (await looksLikeCursorAgent(candidate)) return candidate;
    }
    // Last resort: PATH `agent`, but only if it is not Grok Build.
    for (const name of process.platform === "win32" ? ["agent.exe", "agent.cmd", "agent"] : ["agent"]) {
      const hit = await resolveCommandPath(name);
      if (hit && await looksLikeCursorAgent(hit)) return hit;
    }
    return null;
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
  if (engine === "cursor") {
    return process.env.CURSOR_COMMAND
      || process.env.CURSOR_AGENT_COMMAND
      || (process.platform === "win32" ? "cursor-agent.exe" : "cursor-agent");
  }
  return process.env.GROK_COMMAND || (process.platform === "win32" ? "grok.exe" : "grok");
}
