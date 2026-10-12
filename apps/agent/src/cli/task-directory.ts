import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskDirectoryListing } from "@anytimevibe/protocol";

const execFileAsync = promisify(execFile);

/** Resolve and validate a user-selected task directory before starting a CLI. */
export async function resolveTaskDirectory(
  input: string | undefined | null,
  authorize?: (absolute: string) => Promise<string>
): Promise<string> {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("Task working directory is required");
  if (!path.isAbsolute(raw)) throw new Error("Task working directory must be an absolute path");
  const absolute = authorize ? await authorize(path.resolve(raw)) : path.resolve(raw);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw new Error("Task working directory does not exist or cannot be accessed");
  }
  if (!stat.isDirectory()) throw new Error("Task working directory must be a directory");
  try {
    return await fs.realpath(absolute);
  } catch {
    return absolute;
  }
}

/** List remote folders only; never read a protected folder before the OS grants access. */
export async function listTaskDirectories(
  input: string,
  options: { canRead?: (absolute: string) => boolean } = {}
): Promise<TaskDirectoryListing> {
  if (!path.isAbsolute(input)) throw new Error("Task working directory must be an absolute path");
  const absolute = path.resolve(input);
  const parent = path.dirname(absolute);
  const base = { path: absolute, ...(parent !== absolute ? { parentPath: parent } : {}) };
  if (options.canRead && !options.canRead(absolute)) {
    return { ...base, directories: [], requiresAuthorization: true };
  }
  const canonical = await resolveTaskDirectory(absolute);
  if (options.canRead && !options.canRead(canonical)) {
    return { ...base, path: canonical, directories: [], requiresAuthorization: true };
  }
  const entries = await fs.readdir(canonical, { withFileTypes: true });
  const directories: TaskDirectoryListing["directories"] = [];
  for (const entry of entries) {
    const child = path.join(canonical, entry.name);
    if (entry.isDirectory()) directories.push({ name: entry.name, path: child });
    else if (entry.isSymbolicLink() && (!options.canRead || options.canRead(child))) {
      // Symlink targets may themselves require macOS consent.
      const target = await fs.realpath(child).catch(() => "");
      if (target && (!options.canRead || options.canRead(target))) {
        const stat = await fs.stat(target).catch(() => undefined);
        if (stat?.isDirectory()) directories.push({ name: entry.name, path: child });
      }
    }
  }
  directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const parentPath = path.dirname(canonical);
  return {
    path: canonical,
    ...(parentPath !== canonical ? { parentPath } : {}),
    directories: directories.slice(0, 500),
    ...(directories.length > 500 ? { truncated: true } : {})
  };
}

/** Starting points are navigation shortcuts, not an execution allowlist. */
export async function taskDirectoryRoots(recent: string[] = []): Promise<TaskDirectoryListing> {
  const roots = [os.homedir()];
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root"
      ], { windowsHide: true, timeout: 5000, maxBuffer: 32_000 });
      roots.push(...stdout.split(/\r?\n/).map((value) => value.trim()).filter((value) => /^[A-Za-z]:\\$/.test(value)));
    } catch {
      roots.push(path.parse(os.homedir()).root);
    }
  } else {
    roots.push("/");
  }
  const seen = new Set<string>();
  const directories = [...recent.slice(0, 20), ...roots].filter((value) => {
    if (!value || !path.isAbsolute(value)) return false;
    const key = process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((value) => ({ name: value === os.homedir() ? "~" : path.basename(value) || value, path: path.resolve(value) }));
  return { directories };
}
