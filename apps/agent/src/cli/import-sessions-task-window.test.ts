import { describe, expect, it } from "vitest";
import { listStaleNativeImportThreadIds } from "./import-sessions";
import { TaskStore } from "./task-store";

function task(threadId: string, status: string, updatedAt: number) {
  return {
    threadId,
    engine: "claude" as const,
    providerSessionId: threadId,
    cwd: "",
    title: threadId,
    status,
    createdAt: updatedAt,
    updatedAt,
    messages: []
  };
}

describe("native CLI import task window", () => {
  it("never evicts active native sessions from the recent window", async () => {
    const store = new TaskStore();
    await store.upsert(task("active-old", "active", 1));
    await store.upsert(task("progress-old", "in-progress", 0));
    await store.upsert(task("completed-new", "completed", 3));
    await store.upsert(task("completed-old", "completed", 2));

    expect(listStaleNativeImportThreadIds(store, 1)).toEqual(["completed-old"]);
  });
});
