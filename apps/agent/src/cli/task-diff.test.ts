import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { appendEngineDiffChunk, buildTurnDiff, captureTurnDiffBaseline, collectGitWorkspaceDiff } from "./task-diff";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true });
}

async function createRepository(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "anytimevibe-diff-"));
  temporaryDirectories.push(cwd);
  await git(cwd, "init", "--quiet");
  await git(cwd, "config", "user.email", "test@anytimevibe.local");
  await git(cwd, "config", "user.name", "AnytimeVibe Test");
  await fs.writeFile(path.join(cwd, "tracked.txt"), "before\n", "utf8");
  await git(cwd, "add", "tracked.txt");
  await git(cwd, "commit", "--quiet", "-m", "initial");
  return cwd;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((cwd) => fs.rm(cwd, { recursive: true, force: true })));
});

describe("task diff collection", () => {
  it("includes tracked edits and the contents of new text files", async () => {
    const cwd = await createRepository();
    await fs.writeFile(path.join(cwd, "tracked.txt"), "after\n", "utf8");
    await fs.writeFile(path.join(cwd, "new-file.ts"), "export const value = 1;\n", "utf8");

    const diff = await collectGitWorkspaceDiff(cwd);

    expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(diff).toContain("-before");
    expect(diff).toContain("+after");
    expect(diff).toContain("diff --git a/new-file.ts b/new-file.ts");
    expect(diff).toContain("+export const value = 1;");
  });

  it("keeps git as the authoritative patch and appends engine-only files", async () => {
    const cwd = await createRepository();
    await fs.writeFile(path.join(cwd, "tracked.txt"), "filesystem value\n", "utf8");
    const threadId = "diff-merge-test";
    appendEngineDiffChunk(threadId, "diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-before\n+engine value");
    appendEngineDiffChunk(threadId, "diff --git a/virtual.txt b/virtual.txt\n--- a/virtual.txt\n+++ b/virtual.txt\n@@ -1 +1 @@\n-old\n+new");

    const diff = await buildTurnDiff(threadId, cwd);

    expect(diff).toContain("+filesystem value");
    expect(diff).not.toContain("+engine value");
    expect(diff).toContain("diff --git a/virtual.txt b/virtual.txt");
  });

  it("excludes dirty files that were unchanged during the current turn", async () => {
    const cwd = await createRepository();
    await fs.writeFile(path.join(cwd, "preexisting.txt"), "base\n", "utf8");
    await git(cwd, "add", "preexisting.txt");
    await git(cwd, "commit", "--quiet", "-m", "add second file");
    await fs.writeFile(path.join(cwd, "preexisting.txt"), "dirty before turn\n", "utf8");
    const threadId = "diff-baseline-test";
    await captureTurnDiffBaseline(threadId, cwd);

    await fs.writeFile(path.join(cwd, "tracked.txt"), "changed in turn\n", "utf8");
    const diff = await buildTurnDiff(threadId, cwd);

    expect(diff).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(diff).not.toContain("preexisting.txt");
  });

  it("builds the current-turn patch from a preexisting dirty baseline", async () => {
    const cwd = await createRepository();
    await fs.writeFile(path.join(cwd, "tracked.txt"), "dirty before turn\n", "utf8");
    const threadId = "diff-baseline-change-test";
    await captureTurnDiffBaseline(threadId, cwd);

    await fs.writeFile(path.join(cwd, "tracked.txt"), "dirty before turn\nnew line in turn\n", "utf8");
    const diff = await buildTurnDiff(threadId, cwd);

    expect(diff).toContain("+new line in turn");
    expect(diff).not.toContain("-before");
  });
});
