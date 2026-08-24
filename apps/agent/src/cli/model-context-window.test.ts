import { describe, expect, it } from "vitest";
import { resolveModelContextWindow } from "./model-catalog";

/**
 * The context gauge needs a denominator. Claude Code / Cursor / Antigravity
 * publish no window in their usage payloads or their catalogs, so these values
 * come from the built-in family table; codex and grok normally come from the
 * live catalog and only fall back here.
 *
 * An unknown family must stay `undefined` — the UI renders "—" for that, which
 * is honest, whereas a wrong number renders a confidently wrong percentage.
 */

describe("resolveModelContextWindow — known families", () => {
  it("gives Claude Code a 200k window so the gauge can render", () => {
    expect(resolveModelContextWindow("claude", "claude-opus-4-8")).toBe(200_000);
    expect(resolveModelContextWindow("claude", "claude-fable-5")).toBe(200_000);
  });

  it("resolves Claude alias ids the CLI accepts", () => {
    expect(resolveModelContextWindow("claude", "opus")).toBe(200_000);
    expect(resolveModelContextWindow("claude", "sonnet")).toBe(200_000);
    expect(resolveModelContextWindow("claude", "haiku")).toBe(200_000);
  });

  it("resolves the GPT-5 / codex family", () => {
    expect(resolveModelContextWindow("codex", "gpt-5.6-sol")).toBe(272_000);
    expect(resolveModelContextWindow("codex", "gpt-5-codex")).toBe(272_000);
  });

  it("resolves long-context Gemini for Antigravity", () => {
    expect(resolveModelContextWindow("antigravity", "gemini-3.1-pro")).toBe(1_048_576);
  });

  it("honors Anthropic's [1m] long-context marker over the 200k default", () => {
    // Reporting 200k here would show ~5x the real usage percentage.
    expect(resolveModelContextWindow("claude", "claude-sonnet-4-5[1m]")).toBe(1_000_000);
    expect(resolveModelContextWindow("claude", "sonnet[1m]")).toBe(1_000_000);
  });
});

describe("resolveModelContextWindow — engine-specific model spellings", () => {
  it("strips Cursor slug suffixes before matching the family", () => {
    // Cursor spawns `claude-opus-5-thinking-high`, not the bare family id.
    expect(resolveModelContextWindow("cursor", "claude-opus-5-thinking-high")).toBe(200_000);
    expect(resolveModelContextWindow("cursor", "gpt-5.6-sol-medium-fast")).toBe(272_000);
  });

  it("accepts the legacy Cursor bracket form", () => {
    expect(resolveModelContextWindow("cursor", "claude-opus-5[fast=true,effort=high]")).toBe(200_000);
  });

  it("strips Antigravity effort suffixes", () => {
    expect(resolveModelContextWindow("antigravity", "gemini-3.7-flash-high")).toBe(1_048_576);
    expect(resolveModelContextWindow("antigravity", "gpt-oss-120b-medium")).toBe(131_072);
  });
});

describe("resolveModelContextWindow — refuses to guess", () => {
  it("returns undefined for an unknown family rather than inventing a window", () => {
    expect(resolveModelContextWindow("cursor", "composer-2.5")).toBeUndefined();
    expect(resolveModelContextWindow("codex", "some-unreleased-model")).toBeUndefined();
  });

  it("returns undefined when no model is known and the catalog is empty", () => {
    // Cursor's `auto` hides the real model — no honest denominator exists.
    expect(resolveModelContextWindow("cursor", "auto")).toBeUndefined();
  });

  it("does not match a family name appearing mid-id", () => {
    // Guards the alias patterns against matching e.g. a vendor prefix.
    expect(resolveModelContextWindow("claude", "vendor-opus-clone")).toBeUndefined();
  });
});
