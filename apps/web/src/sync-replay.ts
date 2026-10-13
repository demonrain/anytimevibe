export const SYNC_REPLAY_PAGE_LIMIT = 500;
export const SYNC_REPLAY_BOOTSTRAP_LIMIT = 200;

/** Start live delivery before the potentially long durable replay. */
export function startLiveSync(
  connect: () => void,
  replay: () => Promise<void>,
  onError: (error: unknown) => void
): void {
  connect();
  void replay().catch(onError);
}

/** Build the durable event replay request without allowing history to block a new client. */
export function buildSyncReplayUrl(hostId: string, after: number, bootstrap: boolean): string {
  const params = new URLSearchParams({
    after: String(Math.max(0, Math.floor(after))),
    limit: String(bootstrap ? SYNC_REPLAY_BOOTSTRAP_LIMIT : SYNC_REPLAY_PAGE_LIMIT)
  });
  if (bootstrap) params.set("tail", "1");
  return `/api/sync/${encodeURIComponent(hostId)}?${params.toString()}`;
}
