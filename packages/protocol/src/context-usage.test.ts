import { describe, expect, it } from "vitest";
import {
  mergeContextUsage,
  normalizeContextUsage,
  resolveContextUsageTotals,
  withDerivedTotals
} from "./context-usage";

/**
 * Real payload shapes, kept verbatim so a provider changing its usage block
 * shows up here rather than as a silently wrong gauge.
 */

/** Claude Code `--output-format stream-json` assistant event (Anthropic usage block). */
const CLAUDE_ASSISTANT_EVENT = {
  type: "assistant",
  message: {
    role: "assistant",
    usage: {
      input_tokens: 4,
      cache_creation_input_tokens: 25_000,
      cache_read_input_tokens: 180_000,
      output_tokens: 500
    }
  }
} as const;

/** codex app-server turn usage (OpenAI semantics: cached is inside input). */
const CODEX_TURN_USAGE = {
  input_tokens: 12_000,
  cached_input_tokens: 8_000,
  output_tokens: 400,
  reasoning_output_tokens: 300,
  total_tokens: 12_400
} as const;

describe("normalizeContextUsage — Anthropic-family cache fields are additive", () => {
  it("counts cache reads and cache writes toward the prompt size", () => {
    const usage = normalizeContextUsage(CLAUDE_ASSISTANT_EVENT.message.usage);
    // 4 uncached + 25k written + 180k read
    expect(usage?.inputTokens).toBe(205_004);
    expect(usage?.outputTokens).toBe(500);
    // Display breakdown stays the cache-read figure only.
    expect(usage?.cachedInputTokens).toBe(180_000);
    expect(usage?.totalTokens).toBe(205_504);
  });

  it("finds the usage block nested inside the raw stream event", () => {
    const fromEvent = normalizeContextUsage(CLAUDE_ASSISTANT_EVENT);
    const fromBlock = normalizeContextUsage(CLAUDE_ASSISTANT_EVENT.message.usage);
    expect(fromEvent).toEqual(fromBlock);
  });

  it("reports a nearly-full window instead of ~0%", () => {
    const usage = normalizeContextUsage(CLAUDE_ASSISTANT_EVENT.message.usage, 200_000);
    const totals = resolveContextUsageTotals(usage!);
    expect(totals.usedPercent).toBe(100);
    expect(totals.remainingTokens).toBe(0);
  });

  it("treats an ambiguously-named cache field as additive when it exceeds input", () => {
    // `cache_read_tokens` is spelled like a subset field but cannot be one here.
    const usage = normalizeContextUsage({ input_tokens: 100, cache_read_tokens: 5_000 });
    expect(usage?.inputTokens).toBe(5_100);
  });
});

describe("normalizeContextUsage — OpenAI-family cache fields are a subset", () => {
  it("does not double-count cached input", () => {
    const usage = normalizeContextUsage(CODEX_TURN_USAGE);
    expect(usage?.inputTokens).toBe(12_000);
    expect(usage?.cachedInputTokens).toBe(8_000);
  });

  it("does not add reasoning tokens on top of output tokens", () => {
    const usage = normalizeContextUsage(CODEX_TURN_USAGE);
    expect(usage?.reasoningTokens).toBe(300);
    // 12000 + 400 — reasoning is already inside output_tokens.
    expect(usage?.totalTokens).toBe(12_400);
  });

  it("keeps a session-cumulative reported total when it exceeds input+output", () => {
    const usage = normalizeContextUsage({ input_tokens: 1_000, output_tokens: 100, total_tokens: 50_000 });
    expect(usage?.totalTokens).toBe(50_000);
  });
});

describe("normalizeContextUsage — value reading", () => {
  it("keeps a legitimate zero instead of dropping the field", () => {
    const usage = normalizeContextUsage({ plan_remaining: 0, plan_limit: 500, plan_label: "Pro" });
    // Quota exhausted must render as 0, not as "unknown".
    expect(usage?.planRemaining).toBe(0);
    expect(usage?.planLimit).toBe(500);
    expect(usage?.planLabel).toBe("Pro");
  });

  it("skips null instead of coercing it to 0 and aborting the search", () => {
    const usage = normalizeContextUsage({
      input_tokens: null,
      usage: { input_tokens: 1_234, output_tokens: 10 }
    });
    expect(usage?.inputTokens).toBe(1_234);
    expect(usage?.outputTokens).toBe(10);
  });

  it("ignores a non-positive context window", () => {
    const usage = normalizeContextUsage({ input_tokens: 10, context_window: 0 });
    expect(usage?.contextWindow).toBeUndefined();
    expect(usage?.remainingTokens).toBeUndefined();
  });

  it("prefers a window the payload reports over the caller's catalog default", () => {
    // The turn was served by a larger-window model than the catalog default says.
    const usage = normalizeContextUsage({ input_tokens: 10, context_window: 1_000_000 }, 200_000);
    expect(usage?.contextWindow).toBe(1_000_000);
  });

  it("falls back to the caller's window when the payload omits one", () => {
    // Claude Code's stream-json carries no window size — the catalog must fill it.
    const usage = normalizeContextUsage({ input_tokens: 10, output_tokens: 5 }, 200_000);
    expect(usage?.contextWindow).toBe(200_000);
  });

  it("falls back when the payload reports an unusable zero window", () => {
    const usage = normalizeContextUsage({ input_tokens: 10, context_window: 0 }, 200_000);
    expect(usage?.contextWindow).toBe(200_000);
  });

  it("returns undefined when nothing usable is present", () => {
    expect(normalizeContextUsage(undefined)).toBeUndefined();
    expect(normalizeContextUsage({ unrelated: "x" })).toBeUndefined();
    expect(normalizeContextUsage("not an object")).toBeUndefined();
  });
});

describe("mergeContextUsage", () => {
  it("recomputes the total when a later sample raises input", () => {
    const previous = normalizeContextUsage({ input_tokens: 100_000, output_tokens: 0 }, 200_000);
    const merged = mergeContextUsage(previous, { outputTokens: 500 });
    expect(merged.inputTokens).toBe(100_000);
    expect(merged.outputTokens).toBe(500);
    expect(merged.totalTokens).toBe(100_500);
    // Would have stayed frozen at 100_000 while totalTokens moved.
    expect(merged.remainingTokens).toBe(99_500);
  });

  it("keeps total and remaining consistent with the window", () => {
    const merged = mergeContextUsage(
      { contextWindow: 200_000, remainingTokens: 150_000, totalTokens: 50_000 },
      { inputTokens: 80_000, outputTokens: 1_000 }
    );
    expect(merged.totalTokens).toBe(81_000);
    expect(merged.remainingTokens).toBe(119_000);
    expect(merged.totalTokens! + merged.remainingTokens!).toBe(merged.contextWindow);
  });

  it("does not let a sparse sample erase the known window size", () => {
    const previous = normalizeContextUsage(CODEX_TURN_USAGE, 272_000);
    const merged = mergeContextUsage(previous, { outputTokens: 900 });
    expect(merged.contextWindow).toBe(272_000);
  });

  it("preserves a zero measured value from the newer sample", () => {
    const merged = mergeContextUsage({ planRemaining: 42, planLimit: 100 }, { planRemaining: 0 });
    expect(merged.planRemaining).toBe(0);
  });

  it("derives totals when there is no previous sample", () => {
    const merged = mergeContextUsage(undefined, { inputTokens: 10, outputTokens: 5, contextWindow: 100 });
    expect(merged.totalTokens).toBe(15);
    expect(merged.remainingTokens).toBe(85);
  });
});

describe("resolveContextUsageTotals", () => {
  it("clamps used percent into 0-100", () => {
    const over = resolveContextUsageTotals({ inputTokens: 300_000, contextWindow: 200_000 });
    expect(over.usedPercent).toBe(100);
    expect(over.remainingTokens).toBe(0);
  });

  it("reports nulls when the window is unknown", () => {
    const totals = resolveContextUsageTotals({ inputTokens: 500 });
    expect(totals.totalTokens).toBe(500);
    expect(totals.contextWindow).toBeNull();
    expect(totals.remainingTokens).toBeNull();
    expect(totals.usedPercent).toBeNull();
  });

  it("distinguishes an all-zero sample from an empty one", () => {
    expect(resolveContextUsageTotals({ inputTokens: 0, outputTokens: 0 }).totalTokens).toBe(0);
    expect(resolveContextUsageTotals({}).totalTokens).toBeNull();
  });
});

describe("withDerivedTotals", () => {
  it("drops a stale total that the measured fields no longer support", () => {
    const cleaned = withDerivedTotals({ contextWindow: 100, remainingTokens: 90, totalTokens: 10 });
    // No measured input/output, and the reported total still counts as reported.
    expect(cleaned.totalTokens).toBe(10);
    expect(cleaned.remainingTokens).toBe(90);
  });

  it("is idempotent", () => {
    const once = withDerivedTotals({ inputTokens: 7, outputTokens: 3, contextWindow: 50 });
    expect(withDerivedTotals(once)).toEqual(once);
  });
});

/**
 * Event-stream shapes, which is where both real bugs showed up: the gauge read
 * ~0% on a nearly-full Claude window, and a sparse follow-up sample blanked it.
 */
describe("accumulating over an event stream", () => {
  it("tracks a growing Claude Code conversation instead of flatlining", () => {
    const window = 200_000;
    // Turn 1: small prompt, nothing cached yet.
    let usage = normalizeContextUsage(
      { input_tokens: 8_200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 420 },
      window
    )!;
    expect(resolveContextUsageTotals(usage).usedPercent).toBe(4);

    // Turn 8: most of the prompt is now cache reads — the old math saw ~600 tokens.
    usage = mergeContextUsage(
      usage,
      normalizeContextUsage(
        { input_tokens: 12, cache_creation_input_tokens: 3_500, cache_read_input_tokens: 148_000, output_tokens: 600 },
        window
      )!
    );
    const totals = resolveContextUsageTotals(usage);
    expect(totals.totalTokens).toBe(152_112);
    expect(totals.usedPercent).toBe(76);
    // The warm/hot thresholds the UI keys off can actually fire now.
    expect(totals.usedPercent!).toBeGreaterThanOrEqual(60);
  });

  it("survives a sparse follow-up sample without blanking the gauge", () => {
    const window = 200_000;
    const first = normalizeContextUsage(
      { input_tokens: 4, cache_creation_input_tokens: 25_000, cache_read_input_tokens: 90_000, output_tokens: 500 },
      window
    )!;
    // A `result` event that only carries an output count and no window.
    const merged = mergeContextUsage(first, normalizeContextUsage({ output_tokens: 1_200 })!);
    const totals = resolveContextUsageTotals(merged);
    expect(totals.contextWindow).toBe(window);
    expect(totals.usedPercent).not.toBeNull();
    expect(totals.totalTokens).toBe(116_204);
  });

  it("keeps codex totals stable across repeated turn usage payloads", () => {
    const window = 272_000;
    let usage = normalizeContextUsage(CODEX_TURN_USAGE, window)!;
    expect(resolveContextUsageTotals(usage).totalTokens).toBe(12_400);
    // Next turn reports a larger cumulative total.
    usage = mergeContextUsage(
      usage,
      normalizeContextUsage(
        { input_tokens: 30_000, cached_input_tokens: 24_000, output_tokens: 900, total_tokens: 44_300 },
        window
      )!
    );
    const totals = resolveContextUsageTotals(usage);
    // Cached input is not added on top of input_tokens.
    expect(usage.inputTokens).toBe(30_000);
    expect(totals.totalTokens).toBe(44_300);
    expect(totals.remainingTokens).toBe(227_700);
  });
});
