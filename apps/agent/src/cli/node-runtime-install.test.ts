import { describe, expect, it } from "vitest";
import { nodeRuntimeArchiveName, nodeRuntimeAsset, parseNodeRuntimeChecksum } from "./node-runtime-install";

describe("Node.js runtime install metadata", () => {
  it("selects the latest Node 22 LTS asset for the current platform", () => {
    const asset = nodeRuntimeAsset([
      { version: "v23.0.0", lts: false },
      { version: "v22.14.0", lts: "Jod" }
    ], "win32", "x64");
    expect(asset.fileName).toBe("node-v22.14.0-win-x64.zip");
    expect(asset.url).toContain("https://nodejs.org/dist/v22.14.0/");
  });

  it("requires the official SHA-256 entry and fixed major version", () => {
    const fileName = nodeRuntimeArchiveName("22.14.0", "darwin", "arm64");
    const checksum = "a".repeat(64);
    expect(parseNodeRuntimeChecksum(`${checksum}  ${fileName}\n`, fileName)).toBe(checksum);
    expect(() => nodeRuntimeArchiveName("23.0.0", "darwin", "arm64")).toThrow(/LTS|Invalid/);
    expect(() => parseNodeRuntimeChecksum("bad  other.zip\n", fileName)).toThrow(/checksum/i);
  });
});
