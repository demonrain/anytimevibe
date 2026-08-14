import type { CliEngine } from "@anytimevibe/protocol";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureClaudeWorkspaceTrusted } from "./claude-trust";
import { ensureCodexWorkspaceTrusted } from "./codex-trust";

function antigravitySettingsPath(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

async function ensureAntigravityWorkspaceTrusted(cwd: string): Promise<void> {
  const resolved = path.resolve(cwd);
  const settingsPath = antigravitySettingsPath();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  const current = Array.isArray(settings.trustedWorkspaces)
    ? settings.trustedWorkspaces.map((item) => String(item))
    : [];
  const already = current.some((item) => {
    try {
      return path.resolve(item) === resolved;
    } catch {
      return item === resolved;
    }
  });
  if (already) return;
  settings.trustedWorkspaces = [...current, resolved];
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/**
 * Pre-accept interactive "trust this folder / directory" dialogs for engines
 * that otherwise block non-TTY remote turns or handoff terminals.
 *
 * - Claude: ~/.claude.json hasTrustDialogAccepted
 * - Codex:  ~/.codex/config.toml [projects."…"].trust_level = trusted
 * - Grok:   headless uses --always-approve; no known dir-trust dialog to pre-seed
 * - Antigravity: ~/.gemini/antigravity-cli/settings.json trustedWorkspaces
 */
/** @returns true when on-disk trust config changed (Codex may need app-server reload). */
export async function ensureWorkspaceTrusted(engine: CliEngine, cwd: string): Promise<boolean> {
  const resolved = (cwd || "").trim();
  if (!resolved) return false;
  try {
    if (engine === "claude") {
      await ensureClaudeWorkspaceTrusted(resolved);
      return false;
    }
    if (engine === "codex") {
      return await ensureCodexWorkspaceTrusted(resolved);
    }
    if (engine === "antigravity") {
      await ensureAntigravityWorkspaceTrusted(resolved);
      return false;
    }
    // Grok headless already passes --always-approve; interactive builds currently
    // do not gate on a directory-trust dialog the way Claude/Codex do.
    return false;
  } catch (error) {
    console.error(`[workspace-trust] ${engine} failed for`, resolved, error);
    return false;
  }
}

/** Trust a path for every engine we know how to pre-accept (used when adding workspaces). */
export async function ensureWorkspaceTrustedForAllEngines(cwd: string): Promise<void> {
  await Promise.all([
    ensureWorkspaceTrusted("codex", cwd),
    ensureWorkspaceTrusted("claude", cwd),
    ensureWorkspaceTrusted("grok", cwd),
    ensureWorkspaceTrusted("antigravity", cwd)
  ]);
}
