import { describe, expect, it } from "vitest";
import { codexProjectPathKeys, ensureProjectTrustSection } from "./codex-trust";

describe("codex-trust", () => {
  it("adds a projects trust section when missing", () => {
    const { text, changed } = ensureProjectTrustSection("", "C:\\Users\\admin\\Documents\\Codex\\demo");
    expect(changed).toBe(true);
    expect(text).toContain('[projects."C:\\\\Users\\\\admin\\\\Documents\\\\Codex\\\\demo"]');
    expect(text).toContain('trust_level = "trusted"');
  });

  it("is a no-op when already trusted", () => {
    const existing = `
[projects."h:\\\\git\\\\demo"]
trust_level = "trusted"
`;
    const { text, changed } = ensureProjectTrustSection(existing, "h:\\git\\demo");
    expect(changed).toBe(false);
    expect(text).toBe(existing);
  });

  it("upgrades an untrusted project entry", () => {
    const existing = `[projects."h:\\\\git\\\\demo"]\ntrust_level = "untrusted"\n\n[other]\nx = 1\n`;
    const { text, changed } = ensureProjectTrustSection(existing, "h:\\git\\demo");
    expect(changed).toBe(true);
    expect(text).toContain('trust_level = "trusted"');
    expect(text).not.toContain('trust_level = "untrusted"');
    expect(text).toContain("[other]");
  });

  it("generates windows path key variants", () => {
    if (process.platform !== "win32") return;
    const keys = codexProjectPathKeys("C:\\Users\\admin\\Documents\\Codex\\new-chat");
    expect(keys.some((k) => k.toLowerCase().startsWith("c:"))).toBe(true);
    expect(keys.some((k) => k.includes("/"))).toBe(true);
  });
});
