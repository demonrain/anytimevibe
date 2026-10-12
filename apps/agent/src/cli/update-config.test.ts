import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAgentUpdateConfig } from "./update-config";

afterEach(() => vi.unstubAllGlobals());

describe("agent update configuration", () => {
  it("authenticates only to the configured relay when fetching update transport", async () => {
    vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
      if (url !== "https://vibe.example/api/agent/config" || (options.headers as Record<string, string>).Authorization !== "Bearer agent-token") {
        return new Response("not authorized", { status: 401 });
      }
      return Response.json({ updateFeedUrl: "https://updates.example/api/agent/update/", npmRegistryUrl: "https://updates.example/api/agent/npm" });
    });
    await expect(fetchAgentUpdateConfig("https://vibe.example/", "agent-token"))
      .resolves.toMatchObject({ npmRegistryUrl: "https://updates.example/api/agent/npm" });
  });

  it("supports an old relay config without new transport fields", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ updateFeedUrl: null }));
    await expect(fetchAgentUpdateConfig("https://vibe.example"))
      .resolves.toEqual({ updateFeedUrl: null });
  });

  it("does not include upstream error bodies containing credentials in the error", async () => {
    vi.stubGlobal("fetch", async () => new Response("agent-token secret proxy-token", { status: 502 }));
    await expect(fetchAgentUpdateConfig("https://vibe.example", "agent-token"))
      .rejects.toThrow("HTTP 502");
  });
});
