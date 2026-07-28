import os from "node:os";
import path from "node:path";

/**
 * macOS TCC “Files and Folders” protected locations.
 * Touching these without prior user consent (Open dialog / Full Disk Access)
 * causes repeated “AnytimeVibe-Agent wants to access …” prompts.
 */
const MAC_TCC_SEGMENT_RE =
  /(^|\/)(Documents|Desktop|Downloads|Movies|Music|Pictures|Library\/Mobile Documents)(\/|$)/i;

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
  if (isMacTccProtectedPath(target)) {
    const resolved = (() => {
      try {
        return path.resolve(target);
      } catch {
        return target;
      }
    })().replace(/\\/g, "/").toLowerCase();
    for (const root of allowedRoots) {
      const base = (() => {
        try {
          return path.resolve(root);
        } catch {
          return root;
        }
      })().replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
      if (!base) continue;
      if (resolved === base || resolved.startsWith(base + "/")) return true;
    }
    return false;
  }
  // Other paths under home (e.g. ~/code) — probing can still prompt on newer macOS
  // when the folder is synced/iCloud; only allow if under an explicit workspace root.
  const home = os.homedir().replace(/\\/g, "/").toLowerCase();
  let resolved = target;
  try {
    resolved = path.resolve(target);
  } catch {
    return false;
  }
  const lower = resolved.replace(/\\/g, "/").toLowerCase();
  if (home && lower.startsWith(home + "/")) {
    for (const root of allowedRoots) {
      const base = (() => {
        try {
          return path.resolve(root);
        } catch {
          return root;
        }
      })().replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
      if (!base) continue;
      if (lower === base || lower.startsWith(base + "/")) return true;
    }
    return false;
  }
  return true;
}
