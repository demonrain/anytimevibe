import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * macOS TCC “Files and Folders” protected locations.
 * Touching these without prior user consent (Open dialog / Full Disk Access)
 * causes repeated “AnytimeVibe-Agent wants to access …” prompts.
 */
const MAC_TCC_SEGMENT_RE =
  /(^|\/)(Documents|Desktop|Downloads|Movies|Music|Pictures|Library\/Mobile Documents)(\/|$)/i;

/** Roots the user explicitly authorized in this process (Open dialog / security-scoped bookmark). */
const sessionGrantedRoots = new Set<string>();

function normalizeFsPath(target: string): string {
  let resolved = String(target || "").trim();
  if (!resolved) return "";
  try {
    resolved = path.resolve(resolved);
  } catch {
    // keep raw
  }
  return resolved.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

/** Record that the user granted access to this folder for the current process. */
export function grantMacFsAccessRoot(root: string): void {
  if (process.platform !== "darwin") return;
  const normalized = normalizeFsPath(root);
  if (normalized) sessionGrantedRoots.add(normalized);
}

export function clearMacFsAccessRoots(): void {
  sessionGrantedRoots.clear();
}

export function isMacFsAccessGranted(target: string): boolean {
  if (process.platform !== "darwin") return true;
  const resolved = normalizeFsPath(target);
  if (!resolved) return false;
  for (const root of sessionGrantedRoots) {
    if (resolved === root || resolved.startsWith(root + "/")) return true;
  }
  return false;
}

/** True when probing this path may trigger a macOS privacy dialog. */
export function isMacTccProtectedPath(target: string): boolean {
  if (process.platform !== "darwin") return false;
  const raw = String(target || "").trim();
  if (!raw) return false;
  let resolved = raw;
  try {
    resolved = path.resolve(raw);
  } catch {
    // keep raw
  }
  const normalized = resolved.replace(/\\/g, "/");
  const home = os.homedir().replace(/\\/g, "/");
  // Home-relative protected folders
  if (home && normalized.toLowerCase().startsWith(home.toLowerCase() + "/")) {
    const rest = normalized.slice(home.length);
    if (MAC_TCC_SEGMENT_RE.test(rest)) return true;
  }
  // Absolute /Users/…/Documents etc.
  if (MAC_TCC_SEGMENT_RE.test(normalized)) return true;
  return false;
}

/**
 * Paths we may freely inspect without user folder consent:
 * app config dirs, toolchains, system prefixes.
 */
export function isMacFsProbeSafePath(target: string): boolean {
  if (process.platform !== "darwin") return true;
  const raw = String(target || "").trim();
  if (!raw) return false;
  let resolved = raw;
  try {
    resolved = path.resolve(raw);
  } catch {
    return false;
  }
  const normalized = resolved.replace(/\\/g, "/");
  const home = os.homedir().replace(/\\/g, "/");
  const allowPrefixes = [
    "/opt/homebrew",
    "/usr/local",
    "/usr/bin",
    "/bin",
    "/Applications",
    home ? `${home}/.claude` : "",
    home ? `${home}/.cursor` : "",
    home ? `${home}/.grok` : "",
    home ? `${home}/.local` : "",
    home ? `${home}/.nvm` : "",
    home ? `${home}/.fnm` : "",
    home ? `${home}/.volta` : "",
    home ? `${home}/.asdf` : "",
    home ? `${home}/.codex` : "",
    home ? `${home}/.gemini` : "",
    home ? `${home}/.npm` : "",
    home ? `${home}/.cargo` : "",
    home ? `${home}/.config` : "",
    home ? `${home}/Library/Application Support/Codex` : "",
    home ? `${home}/Library/Application Support/Claude` : "",
    home ? `${home}/Library/Application Support/Cursor` : "",
    home ? `${home}/Library/Application Support/AnytimeVibe` : "",
    home ? `${home}/Library/Logs` : ""
  ].filter(Boolean);
  const lower = normalized.toLowerCase();
  for (const prefix of allowPrefixes) {
    const p = prefix.replace(/\\/g, "/").toLowerCase();
    if (lower === p || lower.startsWith(p + "/")) return true;
  }
  // Never treat TCC folders as safe even if somehow under home allow list miss
  if (isMacTccProtectedPath(normalized)) return false;
  return false;
}

/** Whether Node fs probe (stat/access/readdir) is allowed for this path. */
export function canProbePathWithoutPrompt(target: string, allowedRoots: string[] = []): boolean {
  if (process.platform !== "darwin") return true;
  if (isMacFsProbeSafePath(target)) return true;

  // TCC folders: only after an explicit Open-dialog / bookmark grant this session.
  // Do NOT treat saved workspace allowlist alone as consent — that re-triggers TCC every launch.
  if (isMacTccProtectedPath(target)) {
    return isMacFsAccessGranted(target);
  }

  // Other paths under home (e.g. ~/code) — probing can still prompt on newer macOS
  // when the folder is synced/iCloud; only allow if under an explicit workspace root
  // that was granted this session, or a non-TCC allowlisted root.
  const home = os.homedir().replace(/\\/g, "/").toLowerCase();
  let resolved = target;
  try {
    resolved = path.resolve(target);
  } catch {
    return false;
  }
  const lower = resolved.replace(/\\/g, "/").toLowerCase();
  if (home && lower.startsWith(home + "/")) {
    if (isMacFsAccessGranted(target)) return true;
    for (const root of allowedRoots) {
      const base = normalizeFsPath(root);
      if (!base) continue;
      // Still skip if the allowlisted root itself is TCC-protected without grant.
      if (isMacTccProtectedPath(root) && !isMacFsAccessGranted(root)) continue;
      if (lower === base || lower.startsWith(base + "/")) return true;
    }
    return false;
  }
  return true;
}

/** Whether a PATH segment is safe to include when probing binaries on macOS. */
export function filterMacLoginPathSegment(segment: string): boolean {
  if (process.platform !== "darwin") return Boolean(segment.trim());
  const trimmed = segment.trim();
  if (!trimmed) return false;
  if (isMacTccProtectedPath(trimmed)) return false;
  if (isMacFsProbeSafePath(trimmed)) return true;
  const home = os.homedir().replace(/\\/g, "/").toLowerCase();
  const lower = trimmed.replace(/\\/g, "/").toLowerCase();
  // Other $HOME paths may still trigger privacy prompts — keep them off synthetic PATH.
  if (home && lower.startsWith(home + "/")) return false;
  return true;
}

/** fs.access wrapper that skips macOS TCC-protected locations unless already granted. */
export async function safePathExists(
  target: string,
  allowedRoots: string[] = []
): Promise<boolean> {
  if (!canProbePathWithoutPrompt(target, allowedRoots)) return false;
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** fs.stat.isDirectory wrapper with the same macOS privacy guard as safePathExists. */
export async function safePathIsDirectory(
  target: string,
  allowedRoots: string[] = []
): Promise<boolean> {
  if (!canProbePathWithoutPrompt(target, allowedRoots)) return false;
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}
