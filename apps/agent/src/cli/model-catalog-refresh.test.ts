import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const io = vi.hoisted(() => ({ home: "", codexRows: [] as Array<Record<string, unknown>>, fail: false }));
vi.mock("node:os", async (original) => {
  const real = await original<typeof import("node:os")>();
  return { ...real, default: { ...real, homedir: () => io.home } };
});
vi.mock("./detect", () => ({ resolveEngineBinary: async (engine: string) => `${engine}.cmd` }));
vi.mock("../local-proxy", () => ({ collectLocalProxyEnv: async () => ({}), cloudProxyChildEnv: async () => ({}) }));
vi.mock("./exec-file-tree-kill", () => ({
  execFileWithTreeKill: async (command: string, args: string[]) => {
    if (io.fail) throw new Error("CLI catalog unavailable");
    if (args[0] === "--version") return { stdout: "codex-cli 0.158.0", stderr: "" };
    if (/codex/.test(command)) return { stdout: JSON.stringify({ models: io.codexRows }), stderr: "" };
    throw new Error("CLI catalog unavailable");
  }
}));
vi.mock("./engine-quota", () => ({ runCliText: async () => ({ text: "", ok: false }) }));

import { clearCodexDebugModelsCache, discoverEngineCapabilities } from "./model-catalog";

beforeEach(async () => {
  io.home = await fs.mkdtemp(path.join(os.tmpdir(), "av-model-refresh-"));
  vi.stubEnv("CODEX_HOME", path.join(io.home, ".codex"));
  vi.stubEnv("CODEX_COMMAND", "codex.cmd");
  vi.stubEnv("GROK_HOME", path.join(io.home, ".grok"));
  io.codexRows = [{ slug: "gpt-old", display_name: "Old" }];
  io.fail = false;
  clearCodexDebugModelsCache();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (io.home) await fs.rm(io.home, { recursive: true, force: true });
});

describe("model catalog synchronization", () => {
  it("bypasses Codex catalog cache after an upgrade and reports native provenance", async () => {
    const first = await discoverEngineCapabilities({ engine: "codex", force: true });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ engine: "codex", modelCatalogSource: "cli", models: [{ id: "gpt-old" }] });
    io.codexRows = [{ slug: "gpt-new", display_name: "New" }];
    const refreshed = await discoverEngineCapabilities({ engine: "codex", force: true });
    expect(refreshed[0]?.models.map((row) => row.id)).toEqual(["gpt-new"]);
    expect(refreshed[0]?.modelCatalogCheckedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("identifies Codex disk cache as cache, not a successful live query", async () => {
    io.fail = true;
    const dir = path.join(io.home, ".codex");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "models_cache.json"), JSON.stringify({ models: [{ slug: "cached-model" }] }));
    const result = await discoverEngineCapabilities({ engine: "codex", force: true });
    expect(result[0]).toMatchObject({ modelCatalogSource: "cache", models: [{ id: "cached-model" }] });
  });

  it("does not label Claude aliases as a freshly synchronized provider catalog", async () => {
    const result = await discoverEngineCapabilities({ engine: "claude", force: true });
    expect(result[0]).toMatchObject({ engine: "claude", modelCatalogSource: "fallback" });
    expect(result[0]?.models.map((row) => row.id)).toEqual(["opus", "sonnet", "haiku"]);
  });

  it("labels unreachable native Cursor and Antigravity lists as fallback candidates", async () => {
    io.fail = true;
    for (const engine of ["cursor", "antigravity"] as const) {
      const result = await discoverEngineCapabilities({ engine, force: true });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ engine, modelCatalogSource: "fallback" });
    }
  });
});
