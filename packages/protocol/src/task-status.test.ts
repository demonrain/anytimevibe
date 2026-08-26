import { describe, expect, it } from "vitest";
import { isInProgressTaskStatus, isTaskStale, STALE_TASK_AFTER_SECONDS } from "./task-status";

/**
 * These encode the reported bug: a Codex task that was visibly running showed
 * 「状态待确认」. The cause was on the agent side (only token-usage notifications
 * refreshed `lastProgressAt`, so a long stream of assistant text / command output
 * / reasoning let the window expire). The rule below is what that timestamp feeds,
 * kept shared so the agent's refresh obligation and the web's threshold agree.
 */

const NOW = 1_700_000_000;
const LIVE = { activeTurnId: "turn-1", status: "active" } as const;

describe("isTaskStale — only fires on a genuinely quiet live turn", () => {
  it("flags a live turn whose last progress is older than the threshold", () => {
    const stale = isTaskStale(
      { ...LIVE, lastProgressAt: NOW - (STALE_TASK_AFTER_SECONDS + 1) },
      NOW
    );
    expect(stale).toBe(true);
  });

  it("does not flag a turn that reported progress within the threshold", () => {
    // The fix's effect: any streamed delta moves lastProgressAt into this window.
    expect(isTaskStale({ ...LIVE, lastProgressAt: NOW - 5 }, NOW)).toBe(false);
    expect(isTaskStale({ ...LIVE, lastProgressAt: NOW - (STALE_TASK_AFTER_SECONDS - 1) }, NOW)).toBe(false);
  });

  it("does not flag exactly at the boundary", () => {
    expect(isTaskStale({ ...LIVE, lastProgressAt: NOW - STALE_TASK_AFTER_SECONDS }, NOW)).toBe(false);
  });
});

describe("isTaskStale — states that are never stale", () => {
  it("ignores a task with no turn in flight", () => {
    expect(isTaskStale({ status: "active", lastProgressAt: NOW - 10_000 }, NOW)).toBe(false);
  });

  it("ignores a turn waiting on an open approval card", () => {
    // Waiting for the user is normal, not a stall.
    const waiting = { ...LIVE, lastProgressAt: NOW - 10_000, openApprovalCount: 1 };
    expect(isTaskStale(waiting, NOW)).toBe(false);
  });

  it("ignores a task whose status is not in progress", () => {
    expect(isTaskStale({ activeTurnId: "t", status: "completed", lastProgressAt: NOW - 10_000 }, NOW)).toBe(false);
  });

  it("treats a missing timestamp as unknown rather than ancient", () => {
    // Guards against warning on every task the moment it appears.
    expect(isTaskStale({ ...LIVE }, NOW)).toBe(false);
    expect(isTaskStale({ ...LIVE, lastProgressAt: 0 }, NOW)).toBe(false);
  });

  it("falls back to updatedAt when no progress stamp was sent", () => {
    expect(isTaskStale({ ...LIVE, updatedAt: NOW - 10_000 }, NOW)).toBe(true);
    expect(isTaskStale({ ...LIVE, updatedAt: NOW - 10 }, NOW)).toBe(false);
  });

  it("prefers lastProgressAt over a staler updatedAt", () => {
    // Snapshots carry an old updatedAt while the turn streams; progress wins.
    expect(isTaskStale({ ...LIVE, lastProgressAt: NOW - 5, updatedAt: NOW - 10_000 }, NOW)).toBe(false);
  });
});

describe("isInProgressTaskStatus", () => {
  it("accepts the running spellings the engines emit", () => {
    for (const status of ["active", "running", "in_progress", "in-progress", "processing", "ACTIVE"]) {
      expect(isInProgressTaskStatus(status)).toBe(true);
    }
  });

  it("rejects terminal and unknown statuses", () => {
    for (const status of ["completed", "failed", "idle", "stopped", "", undefined]) {
      expect(isInProgressTaskStatus(status)).toBe(false);
    }
  });

  it("unwraps a JSON status blob", () => {
    // Codex publishes turn status as a JSON string in some builds.
    expect(isInProgressTaskStatus('{"type":"active"}')).toBe(true);
    expect(isInProgressTaskStatus('{"type":"completed"}')).toBe(false);
  });
});
