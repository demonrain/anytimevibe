import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Claude Code interactive sessions prompt "Do you trust this folder?".
 * Declining leaves the project untrusted and later headless/web runs can fail.
 * Mark the workspace trusted in ~/.claude.json before handoff or headless runs.
 */
export async function ensureClaudeWorkspaceTrusted(cwd: string): Promise<void> {
  const resolved = path.resolve(cwd || process.cwd());
  const configPath = path.join(os.homedir(), ".claude.json");
  let raw: Record<string, any> = {};
  try {
    raw = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, any>;
  } catch {
    raw = {};
  }
  if (!raw.projects || typeof raw.projects !== "object") raw.projects = {};
  const projects = raw.projects as Record<string, any>;

  const keys = new Set<string>([
    resolved,
    resolved.replace(/\\/g, "/"),
    // Windows drive variants
    resolved.replace(/\//g, "\\")
  ]);

  let changed = false;
  for (const key of keys) {
    const existing = projects[key] && typeof projects[key] === "object" ? projects[key] : {};
    if (existing.hasTrustDialogAccepted === true) continue;
    projects[key] = {
      ...existing,
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: existing.hasClaudeMdExternalIncludesApproved ?? false,
      hasClaudeMdExternalIncludesWarningShown: existing.hasClaudeMdExternalIncludesWarningShown ?? false
    };
    changed = true;
  }

  if (!changed) return;
  try {
    await fs.writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error("[claude-trust] failed to write", configPath, error);
  }
}
