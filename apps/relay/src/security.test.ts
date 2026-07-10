import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "./security";

describe("sealed relay secrets", () => {
  it("round-trips a temporary agent token", () => {
    const sealed = sealSecret("agent-token", "a-cookie-secret-that-is-long-enough");
    expect(sealed).not.toContain("agent-token");
    expect(openSecret(sealed, "a-cookie-secret-that-is-long-enough")).toBe("agent-token");
  });

  it("rejects the wrong encryption key", () => {
    const sealed = sealSecret("agent-token", "first-secret-that-is-long-enough");
    expect(() => openSecret(sealed, "second-secret-that-is-long-enough")).toThrow();
  });
});
