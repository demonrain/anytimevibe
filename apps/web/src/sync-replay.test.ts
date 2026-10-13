import { describe, expect, it } from "vitest";
import { buildSyncReplayUrl, startLiveSync } from "./sync-replay";

describe("sync replay bootstrap", () => {
  it("requests the recent event tail for a browser without a local cursor", () => {
    expect(buildSyncReplayUrl("host/with spaces", 0, true)).toBe(
      "/api/sync/host%2Fwith%20spaces?after=0&limit=200&tail=1"
    );
  });

  it("keeps cursor replay ordered after the bootstrap page", () => {
    expect(buildSyncReplayUrl("host-1", 321, false)).toBe(
      "/api/sync/host-1?after=321&limit=500"
    );
  });

  it("starts live delivery before awaiting durable history replay", async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];

    startLiveSync(
      () => calls.push("connect"),
      async () => { calls.push("replay"); },
      (error) => errors.push(error)
    );
    await Promise.resolve();

    expect(calls).toEqual(["connect", "replay"]);
    expect(errors).toEqual([]);
  });
});
