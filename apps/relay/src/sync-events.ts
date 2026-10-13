export type SyncEventRow<T> = { sequence: number; envelope: T };

export function selectSyncEventPage<T>(
  rows: SyncEventRow<T>[],
  limit: number,
  tail: boolean
): { page: SyncEventRow<T>[]; hasMore: boolean } {
  if (tail) return { page: rows.slice(0, limit).reverse(), hasMore: false };
  const hasMore = rows.length > limit;
  return { page: hasMore ? rows.slice(0, limit) : rows, hasMore };
}
