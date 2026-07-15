import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliEngine, CliEngineInfo } from "@anytimevibe/protocol";
import { windowsCmdArguments } from "../windows-command";

const execFileAsync = promisify(execFile);

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

function parseClaudeVersion(raw: string | null): string | undefined {
  if (!raw) return undefined;
  // e.g. "2.1.206 (Claude Code)"
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? raw.slice(0, 80);
}

function parseGrokVersion(raw: string | null): string | undefined {
  if (!raw) return undefined;
  // e.g. "grok 0.2.101 (5bc4b5dfad) [stable]"
  const match = raw.match(/grok\s+([^\s]+)/i) || raw.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? raw.slice(0, 80);
}

export async function detectAvailableEngines(options: {
  codexReady: boolean;
  codexVersion: string;
}): Promise<CliEngineInfo[]> {
  const claudeCandidates = process.platform === "win32"
    ? ["claude", "claude.cmd"]
    : ["claude"];
  const grokCandidates = process.platform === "win32"
    ? ["grok", "grok.exe", "grok.cmd"]
    : ["grok"];

  let claudeRaw: string | null = null;
  for (const cmd of claudeCandidates) {
    claudeRaw = await runVersion(cmd, ["--version"]);
    if (claudeRaw) break;
  }
  let grokRaw: string | null = null;
  for (const cmd of grokCandidates) {
    grokRaw = await runVersion(cmd, ["--version"]);
    if (grokRaw) break;
  }

  const claudeVersion = parseClaudeVersion(claudeRaw);
  const grokVersion = parseGrokVersion(grokRaw);

  const engines: CliEngineInfo[] = [
    {
      engine: "codex",
      ready: options.codexReady,
      ...(options.codexVersion !== "unknown" ? { version: options.codexVersion } : {}),
      ...(!options.codexReady ? { detail: "Codex CLI 未就绪（需要 0.144.x）" } : {})
    },
    {
      engine: "claude",
      ready: Boolean(claudeVersion),
      ...(claudeVersion ? { version: claudeVersion } : { detail: "未检测到 claude 命令，请安装 Claude Code CLI" })
    },
    {
      engine: "grok",
      ready: Boolean(grokVersion),
      ...(grokVersion ? { version: grokVersion } : { detail: "未检测到 grok 命令，请安装 Grok Build CLI" })
    }
  ];
  return engines;
}

export function resolveEngineCommand(engine: Exclude<CliEngine, "codex">): string {
  if (engine === "claude") {
    return process.env.CLAUDE_COMMAND
      || (process.platform === "win32" ? "claude.cmd" : "claude");
  }
  return process.env.GROK_COMMAND
    || (process.platform === "win32" ? "grok.exe" : "grok");
}
