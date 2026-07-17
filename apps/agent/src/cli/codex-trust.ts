import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Codex interactive sessions prompt "Do you trust the contents of this directory?"
 * for new project roots. Under app-server (remote tasks) that prompt has no TTY,
 * so the turn appears stuck at "等待引擎输出".
 *
 * Persist trust in ~/.codex/config.toml before thread/start | resume | handoff:
 *
 *   [projects."c:\\Users\\…\\project"]
 *   trust_level = "trusted"
 */
/** @returns true when config.toml was modified (caller may need to reload app-server). */
export async function ensureCodexWorkspaceTrusted(cwd: string): Promise<boolean> {
  const resolved = path.resolve(cwd || process.cwd());
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");

  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    text = "";
  }

  let changed = false;
  let next = text;
  for (const key of codexProjectPathKeys(resolved)) {
    const result = ensureProjectTrustSection(next, key);
    next = result.text;
    if (result.changed) changed = true;
  }
  if (!changed) return false;

  try {
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(configPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
    return true;
  } catch (error) {
    console.error("[codex-trust] failed to write", configPath, error);
    return false;
  }
}

/** Path spellings Codex may use as [projects."…"] keys. */
export function codexProjectPathKeys(cwd: string): string[] {
  const resolved = path.resolve(cwd || process.cwd());
  const keys = new Set<string>();
  const add = (value: string) => {
    if (!value) return;
    keys.add(value);
    keys.add(value.replace(/\\/g, "/"));
    if (process.platform === "win32" && /^[A-Za-z]:/.test(value)) {
      const lower = value[0]!.toLowerCase() + value.slice(1);
      const upper = value[0]!.toUpperCase() + value.slice(1);
      keys.add(lower);
      keys.add(upper);
      keys.add(lower.replace(/\\/g, "/"));
      keys.add(upper.replace(/\\/g, "/"));
    }
  };
  add(resolved);
  // Also trust without trailing separator variants.
  add(resolved.replace(/[\\/]+$/, ""));
  return [...keys];
}

function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function projectHeader(pathKey: string): string {
  return `[projects."${escapeTomlBasicString(pathKey)}"]`;
}

/**
 * Ensure a [projects."path"] section exists with trust_level = "trusted".
 * Minimal TOML edit — does not reformat the whole file.
 */
export function ensureProjectTrustSection(text: string, pathKey: string): { text: string; changed: boolean } {
  const header = projectHeader(pathKey);
  const idx = text.indexOf(header);
  if (idx === -1) {
    const block = `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${header}\ntrust_level = "trusted"\n`;
    return { text: block, changed: true };
  }

  const bodyStart = idx + header.length;
  const nextSection = text.indexOf("\n[", bodyStart);
  const bodyEnd = nextSection === -1 ? text.length : nextSection;
  const body = text.slice(bodyStart, bodyEnd);

  if (/^\s*trust_level\s*=\s*"trusted"\s*$/m.test(body)) {
    return { text, changed: false };
  }

  let newBody: string;
  if (/^\s*trust_level\s*=/m.test(body)) {
    newBody = body.replace(/^\s*trust_level\s*=.*$/m, 'trust_level = "trusted"');
  } else {
    // Insert trust line immediately after the header.
    const rest = body.replace(/^\r?\n/, "");
    newBody = `\ntrust_level = "trusted"\n${rest}`;
  }

  return {
    text: text.slice(0, bodyStart) + newBody + text.slice(bodyEnd),
    changed: true
  };
}
