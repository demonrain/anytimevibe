import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api request headers", () => {
  it("does not send JSON content-type for bodyless requests", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => {
      captured = init;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));

    await api("/api/auth/logout", { method: "POST" });
    expect(new Headers(captured?.headers).has("content-type")).toBe(false);
  });

  it("adds JSON content-type when a request body exists", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => {
      captured = init;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));

    await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "user" }) });
    expect(new Headers(captured?.headers).get("content-type")).toBe("application/json");
  });
});
