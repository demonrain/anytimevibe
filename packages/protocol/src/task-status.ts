/**
 * When a running task should be shown as「状态待确认」(status unconfirmed).
 *
 * The web cannot tell "engine is thinking" apart from "agent died mid-turn" — both
 * look like an open `activeTurnId` with nothing arriving. So it warns once the last
 * proof of life falls too far behind.
 *
 * ## The contract this puts on the agent
 *
 * The agent MUST refresh `lastProgressAt` on anything that proves the engine is
 * still working, and it must do so more often than `STALE_TASK_AFTER_SECONDS`.
 * Codex used to refresh it only on token-usage notifications, so a long assistant
 * message, a streaming command, or an extended reasoning block would trip this
 * warning on a task that was visibly still running.
 *
 * Being here rather than inline in the web keeps the threshold and the rule in one
 * place, so a change on either side cannot drift from the other.
 */

/** Seconds of silence on a live turn before the UI flags it. */
export const STALE_TASK_AFTER_SECONDS = 120;

export type StaleTaskInput = {
  /** Set while the agent has a turn in flight. No turn → never stale. */
  activeTurnId?: string | undefined;
  /** Task status string as published by the agent. */
  status?: string | undefined;
  /** Epoch SECONDS of the last proof of life. */
  lastProgressAt?: number | undefined;
  /** Epoch SECONDS fallback when the agent sent no progress stamp. */
  updatedAt?: number | undefined;
  /** Open approval cards mean the turn is waiting on the user, not stalled. */
  openApprovalCount?: number;
};

/**
 * Normalize a status to its type name.
 *
 * Some engines publish a JSON blob (`{"type":"active",…}`) rather than a bare
 * string, so unwrap that before comparing.
 */
function statusType(status: string | undefined): string {
  let value = String(status || "");
  try {
    const parsed = JSON.parse(value) as { type?: unknown };
    if (typeof parsed.type === "string") value = parsed.type;
  } catch {
    // Plain string statuses are the common case.
  }
  return value.toLowerCase().replace(/[\s_-]/g, "");
}

/** True when the status names a turn that is currently executing. */
export function isInProgressTaskStatus(status: string | undefined): boolean {
  return ["active", "running", "inprogress", "processing"].includes(statusType(status));
}

/**
 * True when a live turn has gone quiet long enough to warrant the warning.
 *
 * `nowSeconds` is injectable so callers (and tests) control the clock.
 */
export function isTaskStale(task: StaleTaskInput, nowSeconds: number = Date.now() / 1000): boolean {
  // No turn in flight: whatever the status says, there is nothing to go stale.
  if (!task.activeTurnId) return false;
  // Waiting on a human is a normal state, not a stall.
  if ((task.openApprovalCount ?? 0) > 0) return false;
  if (!isInProgressTaskStatus(task.status)) return false;
  const last = Number(task.lastProgressAt ?? task.updatedAt ?? 0);
  // A missing/zero stamp is unknown, not ancient — do not warn on it.
  if (!(last > 0)) return false;
  return nowSeconds - last > STALE_TASK_AFTER_SECONDS;
}
