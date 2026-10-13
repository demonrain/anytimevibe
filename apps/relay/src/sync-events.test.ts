import { describe, expect, it } from "vitest";
import { selectSyncEventPage } from "./sync-events";

const rows = [1, 2, 3, 4].map((sequence) => ({ sequence, envelope: `event-${sequence}` }));

describe("sync event windows", () => {
  it("returns the latest tail in ascending sequence order without another page", () => {
    const result = selectSyncEventPage(rows.slice().reverse(), 2, true);

    expect(result).toEqual({
      page: [rows[2], rows[3]],
      hasMore: false
    });
  });

  it("keeps cursor pages ascending and reports continuation", () => {
    const result = selectSyncEventPage(rows, 2, false);

    expect(result).toEqual({
      page: [rows[0], rows[1]],
      hasMore: true
    });
  });
});
