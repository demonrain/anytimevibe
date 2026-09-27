import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CliEngine, CliEngineInfo } from "@anytimevibe/protocol";
import { CODEX_COMPAT_LABEL } from "../codex-adapter";
import {
  windowsExecutableRank,
  windowsLauncherCandidates
} from "../windows-command";
import { execFileWithTreeKill } from "./exec-file-tree-kill";
import { safePathExists, canProbePathWithoutPrompt } from "./macos-fs";

const execFileAsync = promisify(execFile);

const resolvedCommandCache = new Map<string, string | null>();

/** Clear binary resolution cache (call after install / recheck). */
export function clearEngineBinaryCache(): void {
  resolvedCommandCache.clear();
}

/**
 * Pick the best spawnable Windows path while preserving PATH order.
 * npm global installs often leave both `claude` (bash shim) and `claude.cmd`;
 * `where` may return the extensionless file first, which spawn() cannot run (ENOENT).
 *
 * Important: do NOT globally prefer every `.exe` over every `.cmd`. Doing so can pick a
 * later WinGet `claude.exe` over an earlier npm `claude.cmd` on PATH, which makes the
 * UI keep reporting an outdated Claude after `npm` / PATH upgrades.
 */
async function preferWindowsExecutable(hits: string[]): Promise<string | null> {
  const ordered = [...hits].sort((a, b) => {
    const aAlias = isWindowsAppExecutionAlias(a) ? 1 : 0;
    const bAlias = isWindowsAppExecutionAlias(b) ? 1 : 0;
    return aAlias - bAlias;
  });
  for (const hit of ordered) {
    const trimmed = hit?.trim();
    if (!trimmed) continue;
    const existing: string[] = [];
    for (const candidate of windowsLauncherCandidates(trimmed)) {
      if (existing.includes(candidate)) continue;
      if (await safePathExists(candidate)) existing.push(candidate);
    }
    if (!existing.length) continue;
    existing.sort((a, b) => windowsExecutableRank(a) - windowsExecutableRank(b));
    return existing[0] ?? null;
  }
  return null;
}

function versionTextFromExec(result: { stdout?: unknown; stderr?: unknown } | null | undefined): string | null {
  const text = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.replace(/\u0000/g, "").trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const branded = lines.find((line) => /claude code|\(claude code\)/i.test(line) && /\d+\.\d+/.test(line));
  if (branded) return branded;
  const versionLine = lines.find((line) => /\d+\.\d+\.\d+/.test(line) && !/node\.js|cannot find module/i.test(line));
  return versionLine || lines.find((line) => /\d+\.\d+/.test(line) && !/node\.js/i.test(line)) || null;
}

function isWindowsAppExecutionAlias(filePath: string): boolean {
  return /[/\\]microsoft[/\\]windowsapps[/\\]/i.test(filePath);
}

async function captureCommandText(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  try {
    const result = await execFileWithTreeKill(command, args, {
      timeoutMs,
      env,
      maxBuffer: 256_000
    });
    return versionTextFromExec(result);
  } catch (error) {
    // Timeout and non-zero exit still often include the version before the CLI hangs.
    return versionTextFromExec(error as { stdout?: string; stderr?: string });
  }
}

async function runVersion(command: string, args: string[]): Promise<string | null> {
  const env = {
    ...enrichedPathEnv(),
    CI: process.env.CI || "1"
  };
  const direct = await captureCommandText(command, args, 8_000, env);
  if (direct && /\d+\.\d+/.test(direct)) return direct;

  // PowerShell is what users run interactively (`claude --version`). A hidden cmd
  // spawn can miss .ps1 shims. Kill the whole tree on timeout so a TUI cannot
  // hold the boot screen open.
  if (process.platform === "win32") {
    const viaPs = await runVersionViaPowerShell(command, args);
    if (viaPs && /\d+\.\d+/.test(viaPs)) return viaPs;
  }
  return null;
}

async function runVersionViaPowerShell(command: string, args: string[]): Promise<string | null> {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const ps = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const literal = command.replace(/'/g, "''");
  const argText = args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(" ");
  const script = `$ErrorActionPreference='Continue'; & '${literal}' ${argText} | Out-String -Width 240`;
  return captureCommandText(ps, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    script
  ], 8_000, { ...enrichedPathEnv(), CI: process.env.CI || "1" });
}

/** Windows file-version resource, used when --version output cannot be captured. */
async function readWindowsProductVersion(filePath: string): Promise<string | null> {
  if (process.platform !== "win32" || !/\.exe$/i.test(filePath)) return null;
  if (!(await safePathExists(filePath))) return null;
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const ps = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const literal = filePath.replace(/'/g, "''");
  const script = `(Get-Item -LiteralPath '${literal}').VersionInfo.ProductVersion`;
  try {
    const result = await execFileAsync(ps, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      script
    ], {
      timeout: 8_000,
      windowsHide: true,
      maxBuffer: 64_000
    });
    const text = `${result.stdout || ""}`.trim();
    if (!text || /^0+(\.0+)+$/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/** Native / npm Claude installs keep the real version in a sibling package.json. */
async function readClaudePackageVersion(command: string): Promise<string | null> {
  const dir = path.dirname(command);
  const candidates = [
    path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "package.json"),
    path.join(dir, "..", "node_modules", "@anthropic-ai", "claude-code", "package.json"),
    path.join(dir, "package.json")
  ];
  for (const file of candidates) {
    try {
      const json = JSON.parse(await fs.readFile(file, "utf8")) as { name?: string; version?: string };
      if (json?.name === "@anthropic-ai/claude-code" && json.version) return json.version;
    } catch {
      // try next
    }
  }
  return null;
}

/** Fuller CLI text for fingerprinting (help can be multi-line). */
async function runCommandText(command: string, args: string[], maxChars = 8_000): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileWithTreeKill(command, args, {
      timeoutMs: 8_000,
      env: enrichedPathEnv(),
      maxBuffer: 512_000
    });
    const text = `${stdout || ""}\n${stderr || ""}`.trim();
    if (!text) return null;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  } catch (error) {
    const dumped = error as { stdout?: string; stderr?: string };
    const text = `${dumped.stdout || ""}\n${dumped.stderr || ""}`.trim();
    if (!text) return null;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }
}

function enrichedPathEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  // Cursor Agent paths MUST come before .grok/bin — both ship an `agent` binary on Windows.
  const extras = process.platform === "win32"
    ? [
        path.join(process.env.LOCALAPPDATA || "", "cursor-agent"),
        path.join(process.env.LOCALAPPDATA || "", "agy", "bin"),
        path.join(home, ".cursor", "bin"),
        path.join(home, ".local", "bin"),
        path.join(process.env.LOCALAPPDATA || "", "Programs", "claude"),
        path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links"),
        path.join(process.env.APPDATA || "", "npm"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"),
        // Grok last among coding CLIs so bare `agent` does not shadow Cursor.
        path.join(home, ".grok", "bin")
      ]
    : [
        path.join(home, ".cursor", "bin"),
        path.join(home, ".local", "bin"),
        path.join(home, ".claude", "local"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        path.join(home, ".grok", "bin")
      ];
  const sep = process.platform === "win32" ? ";" : ":";
  const current = process.env.PATH || process.env.Path || "";
  const merged = [...extras.filter(Boolean), current].join(sep);
  return { ...process.env, PATH: merged, Path: merged };
}

function isGrokInstallPath(command: string): boolean {
  const n = command.replace(/\\/g, "/").toLowerCase();
  return n.includes("/.grok/") || /\/grok\/bin\//i.test(n);
}

function isCursorInstallPath(command: string): boolean {
  const n = command.replace(/\\/g, "/").toLowerCase();
  const base = path.basename(n);
  if (n.includes("/cursor-agent/") || n.includes("/.cursor/")) return true;
  if ((base === "agent" || base === "agent.exe" || base === "agent.cmd" || base.startsWith("cursor-agent"))
    && (n.includes("/.local/bin/") || n.includes("/appdata/local/cursor-agent/"))) {
    return true;
  }
  return false;
}

/** All Windows `where` hits for a command (ranked), without collapsing to a single cache entry. */
async function listWindowsCommandHits(command: string): Promise<string[]> {
  const env = enrichedPathEnv();
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
      // try next
    }
  }
  const expanded: string[] = [];
  for (const hit of hits) {
    for (const candidate of windowsLauncherCandidates(hit)) {
      if (!expanded.includes(candidate) && await safePathExists(candidate)) expanded.push(candidate);
    }
  }
  expanded.sort((a, b) => {
    // App execution aliases (WindowsApps\\*.exe) often succeed in an interactive
    // PowerShell prompt but return empty / fail when spawned from the Electron GUI.
    const aAlias = isWindowsAppExecutionAlias(a) ? 1 : 0;
    const bAlias = isWindowsAppExecutionAlias(b) ? 1 : 0;
    if (aAlias !== bAlias) return aAlias - bAlias;
    // Prefer Cursor install locations over Grok when both expose `agent`.
    const aCursor = isCursorInstallPath(a) ? 0 : 1;
    const bCursor = isCursorInstallPath(b) ? 0 : 1;
    if (aCursor !== bCursor) return aCursor - bCursor;
    const aGrok = isGrokInstallPath(a) ? 1 : 0;
    const bGrok = isGrokInstallPath(b) ? 1 : 0;
    if (aGrok !== bGrok) return aGrok - bGrok;
    return windowsExecutableRank(a) - windowsExecutableRank(b);
  });
  return expanded;
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
    } else if (await safePathExists(command)) {
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
      if (hit && await safePathExists(hit)) {
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
        path.join(process.env.LOCALAPPDATA || "", "agy", "bin", `${command}.exe`),
        path.join(process.env.LOCALAPPDATA || "", "agy", "bin", `${command}.cmd`),
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
      if (candidate && await safePathExists(candidate)) {
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
        if (await safePathExists(direct)) {
          resolvedCommandCache.set(command, direct);
          return direct;
        }
        try {
          const nested = await fs.readdir(path.join(wingetRoot, entry));
          for (const name of nested) {
            const exe = path.join(wingetRoot, entry, name, "claude.exe");
            if (await safePathExists(exe)) {
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
  const text = raw.trim();
  // Ignore Cursor-style calendar versions accidentally scraped from the wrong binary.
  if (/^\d{4}\.\d{2}\.\d{2}/.test(text) && !/claude/i.test(text)) return undefined;
  // Accept "2.1.268 (Claude Code)" and file versions like "2.1.268.0".
  const match = text.match(/(\d+\.\d+\.\d+)(?:\.\d+)?/)
    || text.match(/(\d+\.\d+(?:[-\w.]*)?)/)
    || text.match(/claude[^\d]*([0-9][^\s]*)/i);
  return match?.[1];
}

function parseGrokVersion(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (/cursor\s*agent/i.test(text) && !/grok/i.test(text)) return undefined;
  if (/^\d{4}\.\d{2}\.\d{2}/.test(text) && !/grok/i.test(text)) return undefined;
  const match = text.match(/grok\s+([^\s]+)/i)
    || text.match(/(\d+\.\d+\.\d+(?:[-\w.]*)?)/)
    || text.match(/(\d+\.\d+(?:[-\w.]*)?)/);
  return match?.[1] ?? text.slice(0, 80);
}

function parseAntigravityVersion(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (/cursor\s*agent|claude\s*code|^grok\s+/i.test(text) && !/antigravity|\bagy\b/i.test(text)) {
    return undefined;
  }
  const match = text.match(/(\d+\.\d+\.\d+(?:[-\w.]*)?)/)
    || text.match(/(\d+\.\d+(?:[-\w.]*)?)/)
    || text.match(/(?:agy|antigravity)[^\d]*([0-9][^\s]*)/i);
  return match?.[1] ?? text.slice(0, 80);
}

function parseCursorVersion(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  // Avoid treating Grok's `agent` binary as Cursor (common PATH name collision).
  if (/grok/i.test(text) && !/cursor/i.test(text)) return undefined;
  if (/claude\s*code|\(Claude Code\)/i.test(text) && !/cursor/i.test(text)) return undefined;
  // Calendar (YYYY.MM.DD), semver, or branded fallback — never require a fixed scheme.
  const match = text.match(/(\d{4}\.\d{2}\.\d{2}[-\w]*)/i)
    || text.match(/(\d+\.\d+\.\d+[-\w]*)/)
    || text.match(/(\d+\.\d+[-\w]*)/)
    || text.match(/cursor[^\d]*([0-9][^\s]*)/i);
  return match?.[1] ?? (text.length < 80 ? text : text.slice(0, 80));
}

/** Reject binaries that clearly belong to another coding engine. */
function isAntigravityInstallPath(command: string): boolean {
  const n = command.replace(/\\/g, "/").toLowerCase();
  const base = path.basename(n);
  if (n.includes("/agy/bin/") || n.includes("/antigravity-cli/") || n.includes("/.gemini/")) return true;
  return base === "agy" || base === "agy.exe" || base === "agy.cmd" || base === "agy.bat";
}

function isPiInstallPath(command: string): boolean {
  const n = command.replace(/\\/g, "/").toLowerCase();
  return n.includes("/pi-coding-agent/") || n.includes("/@earendil-works/pi") || n.includes("/.pi/");
}

function parsePiVersion(text: string | null | undefined): string | undefined {
  if (!text?.trim()) return undefined;
  const match = text.match(/\b(\d+\.\d+\.\d+(?:[-\w.]*)?)\b/);
  return match?.[1] ?? (text.length < 80 ? text.trim() : text.trim().slice(0, 80));
}

async function looksLikePiCli(command: string): Promise<boolean> {
  if (isGrokInstallPath(command) || looksLikeClaudePath(command) || isAntigravityInstallPath(command)) return false;
  if (isCursorInstallPath(command)) return false;
  const base = path.basename(command.replace(/\\/g, "/")).toLowerCase();
  if (base !== "pi" && base !== "pi.cmd" && base !== "pi.exe" && base !== "pi.ps1") {
    if (!isPiInstallPath(command)) return false;
  }
  const help = await runCommandText(command, ["--help"]);
  const version = await runVersion(command, ["--version"]);
  const text = `${help || ""}\n${version || ""}`;
  if (!text.trim()) return false;
  return /--mode\s+rpc|pi-coding-agent|earendil-works\/pi|Usage:\s*pi\b/i.test(text);
}

function isCrossEngineBinary(engine: "claude" | "grok" | "cursor" | "antigravity" | "pi", command: string): boolean {
  const n = command.replace(/\\/g, "/").toLowerCase();
  const base = path.basename(n);
  if (engine === "claude") {
    if (n.includes("/.grok/") || n.includes("/.cursor/") || base.includes("cursor-agent")) return true;
    if (base === "agent" || base === "agent.exe" || base === "grok" || base === "grok.exe") return true;
    if (isAntigravityInstallPath(command)) return true;
  }
  if (engine === "grok") {
    if (n.includes("/.cursor/") || n.includes("/cursor-agent/") || base.includes("cursor-agent") || base.includes("claude")) return true;
    if (isAntigravityInstallPath(command)) return true;
  }
  if (engine === "cursor") {
    if (isGrokInstallPath(command) || base === "grok" || base === "grok.exe") return true;
    if (base.includes("claude") || n.includes("claudecode") || n.includes("/.claude/")) return true;
    if (isAntigravityInstallPath(command)) return true;
  }
  if (engine === "antigravity") {
    if (isGrokInstallPath(command) || isCursorInstallPath(command) || looksLikeClaudePath(command)) return true;
    if (base === "agent" || base === "agent.exe" || base.includes("cursor-agent") || base.includes("claude") || base === "grok" || base === "grok.exe") {
      return true;
    }
  }
  if (engine === "pi") {
    if (isGrokInstallPath(command) || isCursorInstallPath(command) || looksLikeClaudePath(command)) return true;
    if (isAntigravityInstallPath(command)) return true;
    if (base === "agent" || base === "agent.exe" || base === "claude" || base === "grok") return true;
  }
  return false;
}

function looksLikeClaudePath(command: string): boolean {
  const n = command.replace(/\\/g, "/").toLowerCase();
  const base = path.basename(n);
  if (base === "claude" || base === "claude.exe" || base === "claude.cmd" || base === "claude.bat") return true;
  if (n.includes("claudecode") || n.includes("anthropic.claudecode") || n.includes("/.claude/")) return true;
  if (n.includes("/programs/claude/")) return true;
  return false;
}

/** True when this executable looks like Cursor Agent CLI (not Grok `agent` / Claude Code). */
async function looksLikeCursorAgent(command: string): Promise<boolean> {
  // Hard path excludes — never trust Grok's identically named agent.exe.
  if (isGrokInstallPath(command)) return false;
  if (looksLikeClaudePath(command)) return false;
  if (isAntigravityInstallPath(command)) return false;
  if (isCrossEngineBinary("cursor", command)) return false;

  const help = await runCommandText(command, ["--help"]);
  const version = await runVersion(command, ["--version"]);
  const text = `${help || ""}\n${version || ""}`;
  if (!text.trim()) return false;
  if (/grok\s+build|Grok Build TUI|Usage:\s*grok\b|^grok\s+\d/i.test(text)) return false;
  // Claude Code also exposes --print; fingerprint must not treat it as Cursor.
  if (/claude\s*code|Usage:\s*claude\b|\(Claude Code\)/i.test(text)) return false;

  // Strong Cursor Agent CLI markers (https://cursor.com/docs/cli)
  if (/cursor\s*agent|--stream-partial-output|--list-models|CURSOR_API_KEY/i.test(text)) {
    return true;
  }
  // Cursor publishes calendar versions (YYYY.MM.DD…); plain semver alone is NOT enough.
  if (/\b\d{4}\.\d{2}\.\d{2}(?:[-\w]*)?\b/.test(version || "") && !/claude|grok/i.test(text)) {
    return true;
  }
  // Only accept weaker flag matches when the binary lives in a known Cursor install dir.
  // (Grok's help text mentions --output-format; bare PATH `agent.exe` must not match.)
  if (
    isCursorInstallPath(command)
    && /--print|--output-format|stream-json|--force|--yolo/i.test(text)
    && !/claude|grok/i.test(text)
  ) {
    return true;
  }
  return false;
}

/** Pick the first Cursor-looking binary from an ordered candidate list. */
async function firstCursorBinary(candidates: Array<string | null | undefined>): Promise<string | null> {
  const seen = new Set<string>();
  for (const raw of candidates) {
    const candidate = raw?.trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isGrokInstallPath(candidate) || isCrossEngineBinary("cursor", candidate)) continue;
    if (!(await safePathExists(candidate)) && !path.isAbsolute(candidate)) {
      // Allow resolveCommandPath results that already exist; skip missing locals.
      continue;
    }
    if (path.isAbsolute(candidate) && !(await safePathExists(candidate))) continue;
    if (await looksLikeCursorAgent(candidate)) return candidate;
  }
  return null;
}

export async function detectAvailableEngines(options: {
  codexReady: boolean;
  codexVersion: string;
}): Promise<CliEngineInfo[]> {
  clearEngineBinaryCache();
  let claudePath = await resolveEngineBinary("claude");
  let grokPath = await resolveEngineBinary("grok");
  let cursorPath = await resolveEngineBinary("cursor");
  let antigravityPath = await resolveEngineBinary("antigravity");
  let piPath = await resolveEngineBinary("pi");
  // Claude path/name is authoritative — do not run Cursor fingerprinting on it.
  if (claudePath && isCrossEngineBinary("claude", claudePath)) {
    claudePath = null;
  } else if (claudePath && !looksLikeClaudePath(claudePath) && await looksLikeCursorAgent(claudePath)) {
    claudePath = null;
  }
  if (grokPath && (isCrossEngineBinary("grok", grokPath) || await looksLikeCursorAgent(grokPath))) {
    grokPath = null;
  }
  if (cursorPath && isCrossEngineBinary("cursor", cursorPath)) {
    cursorPath = null;
  }
  if (cursorPath && !(await looksLikeCursorAgent(cursorPath))) {
    cursorPath = null;
  }
  if (antigravityPath && isCrossEngineBinary("antigravity", antigravityPath)) {
    antigravityPath = null;
  }
  if (piPath && isCrossEngineBinary("pi", piPath)) {
    piPath = null;
  } else if (piPath && !(await looksLikePiCli(piPath))) {
    piPath = null;
  }

  const claudeRaw = claudePath ? await runVersion(claudePath, ["--version"]) : null;
  const grokRaw = grokPath ? await runVersion(grokPath, ["--version"]) : null;
  const cursorRaw = cursorPath ? await runVersion(cursorPath, ["--version"]) : null;
  const antigravityRaw = antigravityPath ? await runVersion(antigravityPath, ["--version"]) : null;
  const piRaw = piPath ? await runVersion(piPath, ["--version"]) : null;
  let claudeVersion = parseClaudeVersion(claudeRaw);
  if (claudePath && !claudeVersion) {
    claudeVersion = parseClaudeVersion(await readClaudePackageVersion(claudePath))
      || parseClaudeVersion(await readWindowsProductVersion(claudePath));
  }
  const grokVersion = parseGrokVersion(grokRaw);
  const cursorVersion = parseCursorVersion(cursorRaw);
  const antigravityVersion = parseAntigravityVersion(antigravityRaw);
  const piVersion = parsePiVersion(piRaw);

  return [
    {
      engine: "codex",
      ready: options.codexReady,
      ...(options.codexVersion !== "unknown" ? { version: options.codexVersion } : {}),
      ...(!options.codexReady ? { detail: `Codex CLI 未就绪（需要 ${CODEX_COMPAT_LABEL}）` } : {})
    },
    {
      engine: "claude",
      // Binary presence is enough — never gate readiness on a brittle version-string schema.
      ready: Boolean(claudePath),
      ...(claudeVersion
        ? { version: claudeVersion }
        : {
          detail: claudePath
            ? (claudeRaw ? `claude 已找到（版本原文：${String(claudeRaw).slice(0, 60)}）` : "claude 已找到但无法读取版本")
            : "未检测到 claude 命令，请安装并登录 Claude Code CLI"
        })
    },
    {
      engine: "grok",
      ready: Boolean(grokPath),
      ...(grokVersion
        ? { version: grokVersion }
        : {
          detail: grokPath
            ? (grokRaw ? `grok 已找到（版本原文：${String(grokRaw).slice(0, 60)}）` : "grok 已找到但无法读取版本")
            : "未检测到 grok 命令，请安装 Grok Build CLI"
        })
    },
    {
      engine: "cursor",
      ready: Boolean(cursorPath),
      ...(cursorVersion
        ? { version: cursorVersion }
        : {
          detail: cursorPath
            ? (cursorRaw ? `cursor agent 已找到（版本原文：${String(cursorRaw).slice(0, 60)}）` : "cursor agent 已找到但无法读取版本")
            : "未检测到 Cursor Agent CLI（agent / cursor-agent），请安装并登录"
        })
    },
    {
      engine: "antigravity",
      ready: Boolean(antigravityPath),
      ...(antigravityVersion
        ? { version: antigravityVersion }
        : {
          detail: antigravityPath
            ? (antigravityRaw ? `agy 已找到（版本原文：${String(antigravityRaw).slice(0, 60)}）` : "agy 已找到但无法读取版本")
            : "未检测到 Antigravity CLI（agy），请安装并登录"
        })
    },
    {
      engine: "pi",
      ready: Boolean(piPath),
      ...(piVersion
        ? { version: piVersion }
        : {
          detail: piPath
            ? (piRaw ? `pi 已找到（版本原文：${String(piRaw).slice(0, 60)}）` : "pi 已找到但无法读取版本")
            : "未检测到 Pi CLI。安装：npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
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
      if (forced && !isGrokInstallPath(forced) && await looksLikeCursorAgent(forced)) return forced;
      if (forced) console.warn("[detect] CURSOR_COMMAND is not Cursor Agent CLI:", forced);
    }
    if (process.env.CURSOR_AGENT_COMMAND) {
      const forced = await resolveCommandPath(process.env.CURSOR_AGENT_COMMAND);
      if (forced && !isGrokInstallPath(forced) && await looksLikeCursorAgent(forced)) return forced;
    }
    // Prefer unambiguous names first — bare `agent` collides with Grok on Windows
    // (C:\Users\…\.grok\bin\agent.exe is Grok Build TUI, not Cursor).
    const namedHits = process.platform === "win32"
      ? [
          ...(await listWindowsCommandHits("cursor-agent")),
          ...(await listWindowsCommandHits("cursor-agent.exe")),
          ...(await listWindowsCommandHits("cursor-agent.cmd"))
        ]
      : [
          await resolveCommandPath("cursor-agent")
        ];
    const named = await firstCursorBinary(namedHits);
    if (named) return named;

    const home = os.homedir();
    // Cursor install locations only (see https://cursor.com/cn/cli). Never scan .grok.
    const localCandidates = process.platform === "win32"
      ? [
          path.join(process.env.LOCALAPPDATA || "", "cursor-agent", "cursor-agent.cmd"),
          path.join(process.env.LOCALAPPDATA || "", "cursor-agent", "cursor-agent.exe"),
          path.join(process.env.LOCALAPPDATA || "", "cursor-agent", "agent.cmd"),
          path.join(process.env.LOCALAPPDATA || "", "cursor-agent", "agent.exe"),
          path.join(home, ".cursor", "bin", "cursor-agent.exe"),
          path.join(home, ".cursor", "bin", "agent.exe"),
          path.join(home, ".cursor", "bin", "agent.cmd"),
          path.join(home, ".cursor", "bin", "agent"),
          path.join(home, ".local", "bin", "cursor-agent.exe"),
          path.join(home, ".local", "bin", "agent.exe"),
          path.join(home, ".local", "bin", "agent.cmd"),
          path.join(home, ".local", "bin", "agent")
        ]
      : [
          path.join(home, ".local", "bin", "cursor-agent"),
          path.join(home, ".cursor", "bin", "cursor-agent"),
          path.join(home, ".local", "bin", "agent"),
          path.join(home, ".cursor", "bin", "agent")
        ];
    const local = await firstCursorBinary(localCandidates);
    if (local) return local;

    // Last resort: every PATH `agent` hit, skipping Grok's agent.exe explicitly.
    // IMPORTANT: do not use resolveCommandPath("agent") — it prefers .exe and caches Grok first.
    if (process.platform === "win32") {
      for (const name of ["agent.cmd", "agent.exe", "agent"]) {
        const hit = await firstCursorBinary(await listWindowsCommandHits(name));
        if (hit) return hit;
      }
    } else {
      const hit = await resolveCommandPath("agent");
      if (hit && !isGrokInstallPath(hit) && await looksLikeCursorAgent(hit)) return hit;
    }
    return null;
  }
  if (engine === "antigravity") {
    const forced = process.env.AGY_COMMAND || process.env.ANTIGRAVITY_COMMAND;
    if (forced) {
      const hit = await resolveCommandPath(forced);
      if (hit && !isCrossEngineBinary("antigravity", hit)) return hit;
    }
    const home = os.homedir();
    return (await resolveCommandPath("agy"))
      || (await resolveCommandPath("agy.exe"))
      || (await resolveCommandPath("agy.cmd"))
      || (await resolveCommandPath(path.join(process.env.LOCALAPPDATA || "", "agy", "bin", process.platform === "win32" ? "agy.exe" : "agy")))
      || (await resolveCommandPath(path.join(home, ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy")));
  }
  if (engine === "pi") {
    if (process.env.PI_COMMAND) {
      const hit = await resolveCommandPath(process.env.PI_COMMAND);
      if (hit && !isCrossEngineBinary("pi", hit)) return hit;
    }
    const home = os.homedir();
    return (await resolveCommandPath("pi"))
      || (await resolveCommandPath("pi.cmd"))
      || (await resolveCommandPath("pi.exe"))
      || (await resolveCommandPath(path.join(home, ".local", "bin", process.platform === "win32" ? "pi.cmd" : "pi")))
      || (await resolveCommandPath(path.join(process.env.APPDATA || "", "npm", process.platform === "win32" ? "pi.cmd" : "pi")));
  }
  if (engine === "grok") {
    if (process.env.GROK_COMMAND) return resolveCommandPath(process.env.GROK_COMMAND);
    return (await resolveCommandPath("grok"))
      || (await resolveCommandPath("grok.exe"))
      || (await resolveCommandPath("grok.cmd"))
      || (await resolveCommandPath(path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok")));
  }
  return null;
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
  if (engine === "antigravity") {
    return process.env.AGY_COMMAND
      || process.env.ANTIGRAVITY_COMMAND
      || (process.platform === "win32" ? "agy.exe" : "agy");
  }
  if (engine === "pi") {
    return process.env.PI_COMMAND || (process.platform === "win32" ? "pi.cmd" : "pi");
  }
  return process.env.GROK_COMMAND || (process.platform === "win32" ? "grok.exe" : "grok");
}

export type CursorSpawnTarget = {
  /** Executable to spawn (node.exe / node / cursor-agent). */
  command: string;
  /** Args before CLI flags (e.g. path to index.js when using node). */
  prefixArgs: string[];
};

/**
 * Prefer spawning Cursor via `node index.js` instead of cmd→powershell→node.
 * The nested Windows launcher often leaves MCP child handles open so `-p` never exits.
 */
export async function resolveCursorSpawnTarget(): Promise<CursorSpawnTarget | null> {
  const binary = await resolveEngineBinary("cursor");
  if (!binary) return null;
  if (isGrokInstallPath(binary) || isCrossEngineBinary("cursor", binary)) {
    console.warn("[detect] refusing Grok/cross-engine binary for Cursor spawn:", binary);
    return null;
  }

  const tryVersionDir = async (versionDir: string): Promise<CursorSpawnTarget | null> => {
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    const nodePath = path.join(versionDir, nodeName);
    const indexPath = path.join(versionDir, "index.js");
    if ((await safePathExists(nodePath)) && (await safePathExists(indexPath))) {
      return { command: nodePath, prefixArgs: [indexPath] };
    }
    return null;
  };

  const normalized = binary.replace(/\\/g, "/");
  const dir = path.dirname(binary);

  // .../versions/<ver>/cursor-agent(.cmd) → use that version dir
  if (/\/versions\/[^/]+$/i.test(dir.replace(/\\/g, "/")) || /[/\\]versions[/\\][^/\\]+$/i.test(dir)) {
    const hit = await tryVersionDir(dir);
    if (hit) return hit;
  }

  // .../cursor-agent/cursor-agent.cmd → pick newest versions/*
  const versionsRoot = path.join(dir, "versions");
  if (!canProbePathWithoutPrompt(versionsRoot)) {
    return { command: binary, prefixArgs: [] };
  }
  try {
    const entries = await fs.readdir(versionsRoot, { withFileTypes: true });
    const versionDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^\d{4}\.\d{1,2}\.\d{1,2}/.test(name))
      .sort((a, b) => b.localeCompare(a));
    for (const name of versionDirs) {
      const hit = await tryVersionDir(path.join(versionsRoot, name));
      if (hit) return hit;
    }
  } catch {
    // ignore
  }

  // Already a direct node binary? Unlikely but keep shim path.
  if (/node(\.exe)?$/i.test(normalized) || /index\.js$/i.test(normalized)) {
    return { command: binary, prefixArgs: [] };
  }

  return { command: binary, prefixArgs: [] };
}
