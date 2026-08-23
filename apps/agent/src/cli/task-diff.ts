import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_DIFF_CHARS = 400_000;

/** In-turn patches reported by the engine (Codex fileChange, etc.). */
const engineDiffChunks = new Map<string, string[]>();
const gitDiffBaselines = new Map<string, string>();

export function clearEngineDiffChunks(threadId: string): void {
  engineDiffChunks.delete(threadId);
}

/** Capture the dirty workspace before a turn so unchanged pre-existing edits are excluded. */
export async function captureTurnDiffBaseline(threadId: string, cwd: string | undefined): Promise<void> {
  const root = cwd?.trim();
  if (!root) {
    gitDiffBaselines.set(threadId, "");
    return;
  }
  gitDiffBaselines.set(threadId, await collectGitWorkspaceDiff(root).catch(() => ""));
}

export function appendEngineDiffChunk(threadId: string, chunk: string): void {
  const text = chunk.trimEnd();
  if (!text) return;
  const list = engineDiffChunks.get(threadId) ?? [];
  if (list.includes(text)) return;
  list.push(text);
  // Bound memory for long turns.
  while (list.join("\n\n").length > MAX_DIFF_CHARS && list.length > 1) list.shift();
  engineDiffChunks.set(threadId, list);
}

/**
 * Pull unified-diff text out of Codex app-server fileChange items
 * (and similarly shaped objects from other adapters).
 */
export function extractFileChangeDiff(item: Record<string, any>): string {
  if (!item || typeof item !== "object") return "";
  const top = String(item.diff ?? item.patch ?? item.unifiedDiff ?? "").trim();
  if (top) return top;

  const changes: any[] = Array.isArray(item.changes)
    ? item.changes
    : Array.isArray(item.files)
      ? item.files
      : [];
  const parts: string[] = [];
  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    const filePath = String(change.path ?? change.filePath ?? change.filename ?? change.file ?? "").trim();
    const patch = String(change.diff ?? change.patch ?? change.unifiedDiff ?? change.content ?? "").trim();
    const kind = String(change.kind ?? change.type ?? change.status ?? "update").trim();
    if (patch) {
      if (patch.startsWith("diff ") || patch.startsWith("--- ") || patch.startsWith("+++ ")) {
        parts.push(patch);
      } else if (filePath) {
        parts.push(`--- a/${filePath}\n+++ b/${filePath}\n${patch}`);
      } else {
        parts.push(patch);
      }
      continue;
    }
    if (filePath) {
      parts.push(`diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ // ${kind} @@`);
    }
  }
  const tool = item.tool_call ?? item.toolCall ?? item.tool_info ?? item.toolInfo ?? item;
  const input = tool.input ?? tool.args ?? tool.arguments ?? tool.params ?? tool;
  if (input && typeof input === "object") {
    const filePath = String(input.file_path ?? input.filePath ?? input.path ?? input.filename ?? "").trim();
    const patch = String(input.patch ?? input.diff ?? input.unified_diff ?? input.unifiedDiff ?? "").trim();
    if (patch) {
      if (patch.startsWith("diff ") || patch.startsWith("--- ") || patch.startsWith("+++ ")) parts.push(patch);
      else if (filePath) parts.push(`--- a/${filePath}\n+++ b/${filePath}\n${patch}`);
    } else if (filePath) {
      const before = input.old_string ?? input.oldString ?? input.before ?? input.original;
      const after = input.new_string ?? input.newString ?? input.after ?? input.content;
      if (typeof before === "string" && typeof after === "string" && before !== after) {
        const removed = before.split(/\r?\n/).map((line: string) => `-${line}`).join("\n");
        const added = after.split(/\r?\n/).map((line: string) => `+${line}`).join("\n");
        parts.push(`diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1 +1 @@\n${removed}\n${added}`);
      } else if (typeof after === "string" && after) {
        const added = after.split(/\r?\n/).map((line: string) => `+${line}`).join("\n");
        parts.push(`diff --git a/${filePath} b/${filePath}\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1 @@\n${added}`);
      }
    }
  }
  return parts.join("\n\n").trim();
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", "-C", cwd, ...args], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8" }
    });
    return String(stdout ?? "");
  } catch {
    return "";
  }
}

/**
 * Authoritative view of workspace changes after a turn: git status + unstaged + staged.
 * Returns empty string when cwd is not a git work tree or git is unavailable.
 */
export async function collectGitWorkspaceDiff(cwd: string): Promise<string> {
  const root = (cwd || "").trim();
  if (!root) return "";

  const inside = (await runGit(root, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (inside !== "true") return "";

  const status = (await runGit(root, ["status", "--short", "--untracked-files=all"])).trimEnd();
  const unstaged = (await runGit(root, ["diff", "--no-color", "--find-renames"])).trimEnd();
  const staged = (await runGit(root, ["diff", "--cached", "--no-color", "--find-renames"])).trimEnd();

  // Git's normal diff omits untracked files. Read small text files so a newly
  // created file has an actionable patch instead of only a filename header.
  const untracked = (await runGit(root, ["ls-files", "--others", "--exclude-standard"]))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const sections: string[] = [];
  if (status.trim()) {
    sections.push(`# git status\n${status.trim()}`);
  }
  if (staged) {
    sections.push(`# staged\n${staged}`);
  }
  if (unstaged) {
    sections.push(unstaged);
  }
  if (untracked.length) {
    const headers: string[] = [];
    for (const file of untracked) {
      const safe = file.replace(/\\/g, "/");
      try {
        const content = await fs.readFile(path.join(root, file));
        if (content.length > 200_000 || content.includes(0)) {
          headers.push(`diff --git a/${safe} b/${safe}\nnew file mode 100644\nBinary files /dev/null and b/${safe} differ`);
          continue;
        }
        const text = content.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const body = text ? text.split("\n").map((line) => `+${line}`).join("\n") : "+";
        headers.push(`diff --git a/${safe} b/${safe}\nnew file mode 100644\n--- /dev/null\n+++ b/${safe}\n@@ -0,0 +1,${text ? text.split("\n").length : 1} @@\n${body}`);
      } catch {
        headers.push(`diff --git a/${safe} b/${safe}\nnew file mode 100644\n--- /dev/null\n+++ b/${safe}\n@@ // untracked @@`);
      }
    }
    sections.push(headers.join("\n"));
  }

  return sections.join("\n\n").trim().slice(0, MAX_DIFF_CHARS);
}

/**
 * Merge engine-reported patches with a final git workspace diff.
 * Prefer git when available (true filesystem state after the turn).
 */
export async function buildTurnDiff(threadId: string, cwd: string | undefined): Promise<string> {
  const engineParts = engineDiffChunks.get(threadId) ?? [];
  engineDiffChunks.delete(threadId);
  const engineDiff = engineParts.join("\n\n").trim();
  const baseline = gitDiffBaselines.get(threadId) ?? "";
  gitDiffBaselines.delete(threadId);

  let gitDiff = "";
  if (cwd?.trim()) {
    try {
      gitDiff = await collectGitWorkspaceDiff(cwd.trim());
    } catch {
      gitDiff = "";
    }
  }

  if (gitDiff && engineDiff) {
    const gitPaths = new Set(summarizeDiffPaths(gitDiff, 1000));
    const engineOnly = engineParts.filter((part) => {
      const paths = summarizeDiffPaths(part, 1000);
      return paths.length === 0 || paths.some((file) => !gitPaths.has(file));
    });
    const seen = new Set<string>();
    const blocks = [gitDiff, ...engineOnly]
      .flatMap((value) => value.split(/(?=^diff --git )/m))
      .map((value) => value.trim())
      .filter((value) => value && !seen.has(value) && seen.add(value));
    return blocks.join("\n\n").slice(0, MAX_DIFF_CHARS);
  }

  if (gitDiff && baseline) {
    const baselineBlocks = new Set(
      baseline.split(/(?=^diff --git )/m).filter((block) => block.startsWith("diff --git ")).map((block) => block.trim())
    );
    gitDiff = gitDiff
      .split(/(?=^diff --git )/m)
      .filter((block) => block.startsWith("diff --git ") && !baselineBlocks.has(block.trim()))
      .map((block) => block.trim())
      .join("\n\n");
  }
  return (gitDiff || engineDiff).slice(0, MAX_DIFF_CHARS);
}

/** List of paths mentioned in a unified diff / status blob (for UI summaries). */
export function summarizeDiffPaths(diff: string, limit = 40): string[] {
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const git = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (git?.[2]) {
      paths.add(git[2]);
      continue;
    }
    const plus = line.match(/^\+\+\+ b\/(.+)$/);
    if (plus?.[1] && plus[1] !== "/dev/null") {
      paths.add(plus[1]);
      continue;
    }
    const status = line.match(/^(?:# git status\n)?[ MADRCU?]{1,2}\s+(.+)$/);
    if (status?.[1] && !line.startsWith("#")) {
      // ignore — status block handled separately
    }
    const short = line.match(/^[ MADRCU?]{1,2}\s+(.+)$/);
    if (short?.[1] && !line.startsWith("diff ") && !line.startsWith("---") && !line.startsWith("+++")) {
      // only if looks like status line (two chars + space)
      if (/^[ MADRCU?]{1,2}\s/.test(line)) paths.add(short[1].replace(/^.* -> /, "").trim());
    }
  }
  // Also parse status section lines
  let inStatus = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.trim() === "# git status") {
      inStatus = true;
      continue;
    }
    if (inStatus && line.startsWith("# ")) {
      inStatus = false;
      continue;
    }
    if (inStatus) {
      const m = line.match(/^[ MADRCU?]{1,2}\s+(.+)$/);
      if (m?.[1]) paths.add(m[1].replace(/^.* -> /, "").trim());
      else if (line.trim() === "") inStatus = false;
    }
  }
  return [...paths].filter(Boolean).slice(0, limit);
}
