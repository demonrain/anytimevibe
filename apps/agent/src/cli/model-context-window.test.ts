import { describe, expect, it } from "vitest";
import { resolveModelContextWindow } from "./model-catalog";

/**
 * Model catalog values are useful only when the CLI publishes them. There are
 * no family defaults because those can produce a confidently wrong gauge.
 *
 * An unknown family must stay `undefined` — the UI renders "—" for that, which
 * is honest, whereas a wrong number renders a confidently wrong percentage.
 */

describe("resolveModelContextWindow", () => {
  it("does not guess a window from a model family", () => {
    expect(resolveModelContextWindow("claude", "claude-opus-4-8")).toBeUndefined();
    expect(resolveModelContextWindow("codex", "gpt-5.6-sol")).toBeUndefined();
    expect(resolveModelContextWindow("antigravity", "gemini-3.1-pro")).toBeUndefined();
  });
});

describe("resolveModelContextWindow — engine-specific model spellings", () => {
  it("strips Cursor slug suffixes before matching the family", () => {
    // Cursor spawns `claude-opus-5-thinking-high`, not the bare family id.
    expect(resolveModelContextWindow("cursor", "claude-opus-5-thinking-high")).toBeUndefined();
    expect(resolveModelContextWindow("cursor", "gpt-5.6-sol-medium-fast")).toBeUndefined();
  });

  it("accepts the legacy Cursor bracket form", () => {
    expect(resolveModelContextWindow("cursor", "claude-opus-5[fast=true,effort=high]")).toBeUndefined();
  });

  it("strips Antigravity effort suffixes", () => {
    expect(resolveModelContextWindow("antigravity", "gemini-3.7-flash-high")).toBeUndefined();
    expect(resolveModelContextWindow("antigravity", "gpt-oss-120b-medium")).toBeUndefined();
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
