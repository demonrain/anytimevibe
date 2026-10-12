import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = createSourceFile("main.ts", readFileSync(path.resolve("apps/agent/src/main.ts"), "utf8"), ScriptTarget.Latest, true);
const declarations = source.statements.filter((node) => isFunctionDeclaration(node)
  && ["resolveAbsoluteCwd", "preferTaskCwd", "normalizeTaskCwd", "taskGitBranch"].includes(node.name?.text || ""));
const script = new Script(`${transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ScriptTarget.ES2022 }
}).outputText}\n({ preferTaskCwd, normalizeTaskCwd, taskGitBranch });`);
function fixture(canRead = true) {
  const realpath = vi.fn(async (cwd: string) => cwd);
  const readGitBranch = vi.fn(async () => "main");
  const functions = script.runInNewContext({
    path, fs: { realpath }, readGitBranch,
    process: { platform: "darwin" }, gitBranchCache: new Map(),
    canProbePathWithoutPrompt: () => canRead, workspaceAllowRoots: () => []
  }) as {
    preferTaskCwd(...paths: Array<string | undefined>): string;
    normalizeTaskCwd(cwd: string): Promise<string>;
    taskGitBranch(cwd: string): Promise<string | undefined>;
  };
  return { ...functions, realpath, readGitBranch };
}

describe("native task working directory", () => {
  it("keeps the authoritative current directory instead of choosing by string length", () => {
    const { preferTaskCwd } = fixture();
    const current = path.resolve("project");
    expect(preferTaskCwd(current, path.join(current, "previously-selected-deep-subdir"))).toBe(current);
    expect(preferTaskCwd(current, path.resolve("very-long-unrelated-project-directory"))).toBe(current);
  });

  it("does not probe a protected directory while displaying imported task metadata", async () => {
    const f = fixture(false);
    const cwd = path.resolve("protected-project");
    await expect(f.normalizeTaskCwd(cwd)).resolves.toBe(cwd);
    await expect(f.taskGitBranch(cwd)).resolves.toBeUndefined();
    expect(f.realpath).not.toHaveBeenCalled();
    expect(f.readGitBranch).not.toHaveBeenCalled();
  });

  it("reads the actual directory and branch after access is available", async () => {
    const f = fixture();
    const cwd = path.resolve("project");
    await expect(f.normalizeTaskCwd(cwd)).resolves.toBe(cwd);
    await expect(f.taskGitBranch(cwd)).resolves.toBe("main");
    expect(f.realpath).toHaveBeenCalledWith(cwd);
    expect(f.readGitBranch).toHaveBeenCalledWith(cwd);
  });
});
