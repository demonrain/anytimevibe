import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTaskDirectory } from "./task-directory";

// Run the actual main-process functions with only the Electron/OS boundary substituted.
const source = createSourceFile("main.ts", readFileSync(path.resolve("apps/agent/src/main.ts"), "utf8"), ScriptTarget.Latest, true);
const names = ["pickTaskDirectory", "ensureMacFolderAccess", "activateMacWorkspaceBookmarks", "rememberMacDirectoryAccess"];
const declarations = source.statements.filter((node) => isFunctionDeclaration(node) && names.includes(node.name?.text || ""));
const script = new Script(`${transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
}).outputText}\n({ pickTaskDirectory, ensureMacFolderAccess, activateMacWorkspaceBookmarks });`);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((cwd) => fs.rm(cwd, { recursive: true, force: true })));
});

async function fixture() {
  const selected = await fs.mkdtemp(path.join(os.tmpdir(), "av-mac-access-"));
  temporaryDirectories.push(selected);
  let activated = false;
  const events: Array<{ path?: string; commandId: string }> = [];
  const config = { workspaces: [], workspaceBookmarks: {}, directoryBookmarks: {} as Record<string, string> };
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, "stat").mockImplementation((async (file: string, ...args: unknown[]) => {
    if (file === selected && !activated) throw new Error("EACCES: bookmark is not active");
    return stat(file, ...args as []);
  }) as typeof fs.stat);
  const context = {
    process: { platform: "darwin" }, path, crypto, config,
    app: { startAccessingSecurityScopedResource: () => { activated = true; return () => { activated = false; }; } },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected], bookmarks: ["folder-bookmark"] }) },
    macBookmarkStoppers: [] as Array<() => void>,
    resolveTaskDirectory, grantMacFsAccessRoot: () => {},
    workspaceAllowRoots: () => [], isMacTccProtectedPath: () => true,
    canProbePathWithoutPrompt: () => activated,
    saveConfig: async () => {}, logWarn: () => {}, logInfo: () => {},
    publish: async (event: typeof events[number]) => { events.push(event); }
  };
  const functions = script.runInNewContext(context) as {
    pickTaskDirectory(commandId: string, requested?: string): Promise<void>;
    ensureMacFolderAccess(cwd: string, reason: string): Promise<string>;
    activateMacWorkspaceBookmarks(): void;
  };
  return { ...functions, selected, config, events };
}

describe("macOS task folder authorization", () => {
  it("activates the chosen bookmark before validating the directory", async () => {
    const f = await fixture();
    await f.pickTaskDirectory(crypto.randomUUID());
    expect(f.events[0]?.path).toBe(f.selected);
    expect(f.config.directoryBookmarks[f.selected]).toBe("folder-bookmark");
  });

  it("authorizes a new task folder even without a legacy workspace entry", async () => {
    const f = await fixture();
    await expect(resolveTaskDirectory(f.selected, (cwd) => f.ensureMacFolderAccess(cwd, "Task access")))
      .resolves.toBe(f.selected);
  });

  it("restores task folder bookmarks after restarting the client", async () => {
    const f = await fixture();
    f.config.directoryBookmarks[f.selected] = "folder-bookmark";
    f.activateMacWorkspaceBookmarks();
    await expect(resolveTaskDirectory(f.selected)).resolves.toBe(f.selected);
  });
});
