import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listTaskDirectories, resolveTaskDirectory } from "./task-directory";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((cwd) => fs.rm(cwd, { recursive: true, force: true })));
});

describe("task directory resolution", () => {
  it("returns a canonical absolute directory for an existing folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anytimevibe-task-dir-"));
    temporaryDirectories.push(root);
    await expect(resolveTaskDirectory(root)).resolves.toBe(await fs.realpath(root));
  });

  it("rejects missing paths and regular files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anytimevibe-task-dir-"));
    temporaryDirectories.push(root);
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "content", "utf8");
    await expect(resolveTaskDirectory(path.join(root, "missing"))).rejects.toThrow(/directory/i);
    await expect(resolveTaskDirectory(file)).rejects.toThrow(/directory/i);
  });

  it("waits for directory access before probing the selected path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anytimevibe-task-dir-"));
    temporaryDirectories.push(root);
    const selected = path.join(root, "protected");
    // Models a folder becoming available only after the OS grants access.
    await expect(resolveTaskDirectory(selected, async (absolute) => {
      await fs.mkdir(absolute);
      return absolute;
    })).resolves.toBe(selected);
  });

  it("does not silently fall back to the process directory for empty input", async () => {
    await expect(resolveTaskDirectory(" ")).rejects.toThrow(/required/i);
  });

  it("lists only directories with their full paths and the parent path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anytimevibe-task-dir-"));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, "project"));
    await fs.writeFile(path.join(root, "secret.txt"), "not a directory");
    const result = await listTaskDirectories(root);
    expect(result.path).toBe(root);
    expect(result.parentPath).toBe(path.dirname(root));
    expect(result.directories).toEqual([{ name: "project", path: path.join(root, "project") }]);
  });

  it("returns an authorization hint without reading a protected directory", async () => {
    const result = await listTaskDirectories(path.join(os.tmpdir(), "unavailable-protected-folder"), {
      canRead: () => false
    });
    expect(result.requiresAuthorization).toBe(true);
    expect(result.directories).toEqual([]);
  });

  it("rejects relative paths from remote directory requests", async () => {
    await expect(listTaskDirectories("../project")).rejects.toThrow(/absolute/i);
  });
});
