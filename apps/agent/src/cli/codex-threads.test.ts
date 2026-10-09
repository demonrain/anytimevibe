import { describe, expect, it } from "vitest";
import { CodexThreadRegistry, codexSubagentInfo } from "./codex-threads";

describe("native Codex thread identity", () => {
  it.each([
    [{ id: "child", parentThreadId: "root", source: "unknown" }, "root"],
    [{ id: "child", parent_thread_id: "root", source: "unknown" }, "root"],
    [{ id: "child", source: { subAgent: { thread_spawn: { parent_thread_id: "root" } } } }, "root"],
    [{ id: "child", source: { subagent: { thread_spawn: { parent_thread_id: "root", depth: 1 } } } }, "root"],
    [{ id: "child", source: { subAgent: "review" } }, undefined],
    [{ id: "child", source: { subagent: "compact" } }, undefined]
  ])("recognizes native child metadata %j", (thread, parent) => {
    expect(codexSubagentInfo(thread)).toEqual(parent ? { parentThreadId: parent } : {});
  });

  it.each([
    { id: "normal", source: "cli", name: null, preview: "" },
    { id: "normal", source: "vscode", parentThreadId: null, forkedFromId: "root" },
    { id: "normal", source: "unknown" },
    { id: "normal", source: { custom: "subagent" }, agentNickname: "someone" }
  ])("keeps user sessions with metadata %j", (thread) => {
    expect(codexSubagentInfo(thread)).toBeUndefined();
  });

  it("remembers spawn ownership even if a concurrent thread/read returns older partial metadata", async () => {
    const registry = new CodexThreadRegistry();
    let finish!: (thread: Record<string, any>) => void;
    const read = new Promise<Record<string, any>>((resolve) => { finish = resolve; });
    const loading = registry.ensureThread("child", async () => read);
    registry.observeItem({ type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "root", receiverThreadIds: ["child"] }, "root");
    finish({ id: "child", source: "unknown" });
    await loading;
    expect(registry.isSubagent("child")).toBe(true);
    expect(await registry.ensureRootThreadId("child", async (id) => ({ id, source: "appServer" }))).toBe("root");
  });

  it("leaves ownership unresolved when a child's parent cannot be read", async () => {
    const registry = new CodexThreadRegistry();
    registry.observeThread({ id: "child", parentThreadId: "missing" });
    expect(await registry.ensureRootThreadId("child", async () => undefined)).toBeUndefined();
  });

  it("hydrates a source-only child before routing its approval", async () => {
    const registry = new CodexThreadRegistry();
    registry.observeThread({ id: "child", source: { subAgent: "review" } });
    const root = await registry.ensureRootThreadId("child", async (id) => id === "child"
      ? { id, source: { subAgent: "review" }, parentThreadId: "root" }
      : { id, source: "cli", parentThreadId: null });
    expect(root).toBe("root");
  });

  it("stops malformed parent cycles instead of assigning a child as a top-level owner", async () => {
    const registry = new CodexThreadRegistry();
    registry.observeThread({ id: "a", parentThreadId: "b" });
    registry.observeThread({ id: "b", parentThreadId: "a" });
    expect(await registry.ensureRootThreadId("a", async () => undefined)).toBeUndefined();
  });
});
