import { describe, expect, it } from "vitest";
import { codexPermissionParams, threadStartParams, threadToSnapshot } from "./codex-adapter";

describe("threadToSnapshot", () => {
  it("inherits approval and sandbox settings from local Codex config", () => {
    expect(threadStartParams("C:\\repo")).toEqual({ cwd: "C:\\repo" });
    expect(threadStartParams("C:\\repo")).not.toHaveProperty("approvalPolicy");
    expect(threadStartParams("C:\\repo")).not.toHaveProperty("sandbox");
  });
  it("maps explicit web permission modes to Codex settings", () => {
    expect(codexPermissionParams("full-access")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(threadStartParams("C:\\repo", "workspace-write")).toEqual({ cwd: "C:\\repo", approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(codexPermissionParams("read-only")).toEqual({ approvalPolicy: "on-request", sandbox: "read-only" });
  });
  it("extracts user and assistant messages", () => {
    const snapshot = threadToSnapshot({
      id: "thread-1",
      preview: "Build the feature",
      cwd: "C:\\repo",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
      turns: [{
        startedAt: 1,
        completedAt: 2,
        items: [
          { type: "userMessage", id: "u1", content: [{ type: "text", text: "hello" }] },
          { type: "agentMessage", id: "a1", text: "done" }
        ]
      }]
    });
    expect(snapshot.title).toBe("Build the feature");
    expect(snapshot.messages).toEqual([
      { id: "u1", role: "user", text: "hello", createdAt: 1 },
      { id: "a1", role: "assistant", text: "done", createdAt: 2 }
    ]);
  });

  it("includes the active turn in synchronization snapshots", () => {
    const snapshot = threadToSnapshot({
      id: "thread-active",
      status: "active",
      turns: [{ id: "turn-active", status: "inProgress", startedAt: 3, items: [] }]
    });
    expect(snapshot.activeTurnId).toBe("turn-active");
  });
});
