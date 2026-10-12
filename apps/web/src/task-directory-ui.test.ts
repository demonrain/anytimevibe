import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anytimevibe/protocol";
import { reduceEvent } from "./App";

const eventBase = { eventId: "22222222-2222-4222-8222-222222222222", occurredAt: "2026-10-12T00:00:00.000Z" };
function runtimeFixture() {
  return { online: true, workspaces: [], tasks: {
    task: { threadId: "task", title: "Task", cwd: "C:/very-long-old-project", gitBranch: "old-branch",
      status: "completed", updatedAt: 1, diff: "", messages: [], approvals: [] }
  } } as Parameters<typeof reduceEvent>[0];
}

describe("task directory and branch updates", () => {
  it("uses the current native directory even when the old one is longer", () => {
    const next = reduceEvent(runtimeFixture(), {
      ...eventBase, type: "thread.snapshot", threadId: "task", title: "Task", cwd: "D:/repo",
      status: "completed", createdAt: 1, updatedAt: 2, messages: [], gitBranch: "main"
    });
    expect(next.tasks.task?.cwd).toBe("D:/repo");
    expect(next.tasks.task?.gitBranch).toBe("main");
  });

  it("clears a branch when the directory is no longer a Git repository", () => {
    const next = reduceEvent(runtimeFixture(), {
      ...eventBase, type: "thread.snapshot", threadId: "task", title: "Task", cwd: "D:/ordinary",
      status: "completed", createdAt: 1, updatedAt: 2, messages: [], gitBranch: null
    });
    expect(next.tasks.task?.gitBranch).toBeUndefined();
  });

  it("receives encrypted directory listings without creating task rows", () => {
    const event = { ...eventBase, type: "host.directory.listed", commandId: eventBase.eventId,
      path: "C:/project", directories: [{ name: "src", path: "C:/project/src" }] } as AgentEvent;
    const next = reduceEvent(runtimeFixture(), event);
    expect(next.directoryListing).toMatchObject({ commandId: eventBase.eventId, path: "C:/project" });
    expect(Object.keys(next.tasks)).toEqual(["task"]);
  });
});
