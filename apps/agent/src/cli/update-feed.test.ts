import { describe, expect, it } from "vitest";
import { resolveUpdateFeedUrl } from "./update-feed";

describe("update feed routing", () => {
  it("routes GitHub release feeds through the relay", () => {
    expect(resolveUpdateFeedUrl(
      "https://github.com/demonrain/anytimevibe/releases/latest/download",
      "https://vibe.example.com/"
    )).toBe("https://vibe.example.com/api/agent/update/");
  });

  it("keeps a private or custom update CDN unchanged", () => {
    expect(resolveUpdateFeedUrl("https://updates.example.com/agent", "https://vibe.example.com")).toBe("https://updates.example.com/agent");
  });

  it("keeps the original feed when an old relay does not advertise transfer routes", () => {
    expect(resolveUpdateFeedUrl(
      "https://github.com/demonrain/anytimevibe/releases/latest/download",
      "https://old-vibe.example.com",
      false
    )).toBe("https://github.com/demonrain/anytimevibe/releases/latest/download");
  });
});
