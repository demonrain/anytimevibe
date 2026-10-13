import { describe, expect, it } from "vitest";
import { resolveUpdateFeedUrl, resolveUpdateSources } from "./update-feed";

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

  it("prefers the original GitHub feed and keeps the relay as a fallback", () => {
    expect(resolveUpdateSources({
      updateDirectUrl: "https://github.com/demonrain/anytimevibe/releases/latest/download",
      updateFeedUrl: "https://updates.example.com/api/agent/update/"
    }, "https://vibe.example.com")).toEqual([
      { url: "https://github.com/demonrain/anytimevibe/releases/latest/download", mode: "auto", kind: "direct" },
      { url: "https://updates.example.com/api/agent/update", mode: "direct", kind: "relay" }
    ]);
  });

  it("supports legacy GitHub-only relay responses without duplicating the source", () => {
    expect(resolveUpdateSources({
      updateFeedUrl: "https://github.com/demonrain/anytimevibe/releases/latest/download"
    }, "https://vibe.example.com")).toEqual([
      { url: "https://github.com/demonrain/anytimevibe/releases/latest/download", mode: "auto", kind: "direct" },
      { url: "https://vibe.example.com/api/agent/update", mode: "direct", kind: "relay" }
    ]);
  });

  it("keeps a custom feed as the only source when no relay fallback exists", () => {
    expect(resolveUpdateSources({ updateFeedUrl: "https://updates.example.com/agent" }, "https://vibe.example.com"))
      .toEqual([{ url: "https://updates.example.com/agent", mode: "auto", kind: "direct" }]);
  });
});
