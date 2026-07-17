import type { CliEngine } from "@anytimevibe/protocol";
import { ensureClaudeWorkspaceTrusted } from "./claude-trust";
import { ensureCodexWorkspaceTrusted } from "./codex-trust";

/**
 * Pre-accept interactive "trust this folder / directory" dialogs for engines
 * that otherwise block non-TTY remote turns or handoff terminals.
 *
 * - Claude: ~/.claude.json hasTrustDialogAccepted
 * - Codex:  ~/.codex/config.toml [projects."…"].trust_level = trusted
 * - Grok:   headless uses --always-approve; no known dir-trust dialog to pre-seed
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
    ensureWorkspaceTrusted("grok", cwd)
  ]);
}
