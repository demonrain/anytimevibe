import { describe, expect, it } from "vitest";
import { threadToSnapshot } from "./codex-adapter";

describe("threadToSnapshot", () => {
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
});
