import { describe, expect, it } from "vitest";
import {
  dedupeMultiCliTasks,
  listAgySubagentImportThreadIds,
  listJunkCursorImportThreadIds,
  listJunkGrokImportThreadIds,
  listStaleNativeImportThreadIds,
  productTaskOwnershipFields
} from "./import-sessions";
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

  it("does not evict AnytimeVibe-owned tasks during native import cleanup", async () => {
    const store = new TaskStore();
    await store.upsert({ ...task("managed-old", "completed", 1), managedByAnytimeVibe: true });
    await store.upsert(task("newer", "completed", 10));
    await store.upsert({ ...task("managed-cursor", "completed", 1), engine: "cursor", cwd: "C:/Temp", managedByAnytimeVibe: true });
    await store.upsert({ ...task("managed-grok", "completed", 1), engine: "grok", cwd: "C:/Temp", managedByAnytimeVibe: true });
    await store.upsert({ ...task("managed-agy", "completed", 1), engine: "antigravity", providerSessionId: "managed-agy", managedByAnytimeVibe: true });

    expect(listStaleNativeImportThreadIds(store, 0)).not.toContain("managed-old");
    expect(listJunkCursorImportThreadIds(store)).not.toContain("managed-cursor");
    expect(listJunkGrokImportThreadIds(store)).not.toContain("managed-grok");
    expect(listAgySubagentImportThreadIds(store, new Set(["managed-agy"]))).not.toContain("managed-agy");
  });

  it("prefers an AnytimeVibe-owned task over an unowned duplicate for the same CLI session", async () => {
    const store = new TaskStore();
    await store.upsert({ ...task("native-session", "completed", 2), engine: "claude", managedByAnytimeVibe: true });
    await store.upsert({
      ...task("web-clone", "completed", 3), engine: "claude", providerSessionId: "native-session"
    });

    await dedupeMultiCliTasks(store);

    expect(store.get("native-session")?.managedByAnytimeVibe).toBe(true);
    expect(store.get("web-clone")).toBeUndefined();
  });

  it("restores the explicit ownership marker when importing an older product task", () => {
    expect(productTaskOwnershipFields({ permissionMode: "full-access" })).toEqual({
      managedByAnytimeVibe: true,
      permissionMode: "full-access"
    });
    expect(productTaskOwnershipFields(undefined)).toEqual({});
  });
});
