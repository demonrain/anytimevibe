import type { ContextUsage } from "./index";

/**
 * Shared token / context-usage math for every coding CLI (codex, claude, cursor,
 * grok, agy) and for the web display. Agent and web MUST go through this module
 * so both sides agree on what "上下文已用" means.
 *
 * ## Field semantics (the contract every producer normalizes into)
 *
 * - `inputTokens`       — the FULL prompt size, including prompt-cache hits and
 *                         cache writes. This is what occupies the context window.
 * - `cachedInputTokens` — the portion of `inputTokens` that was served from cache.
 *                         A SUBSET of `inputTokens`; display-only, never summed.
 * - `outputTokens`      — the full completion, including reasoning/thinking.
 * - `reasoningTokens`   — the reasoning portion of `outputTokens`. A SUBSET;
 *                         display-only, never summed.
 * - `totalTokens`       — `inputTokens + outputTokens`, the consumed amount
 *                         shown by the clients.
 * - `remainingTokens`   — derived only for a valid provider-reported window.
 *
 * `totalTokens` and `remainingTokens` are DERIVED — never carried over from an
 * earlier sample, always recomputed. Treating them as stored values is what let
 * them freeze at a stale number.
 *
 * ## Why the cache fields need per-provider handling
 *
 * The two provider families use the same-looking keys with opposite meaning:
 *
 * - Anthropic (Claude Code): `input_tokens` is only the UNCACHED remainder.
 *   True prompt size = `input_tokens + cache_creation_input_tokens +
 *   cache_read_input_tokens`. Dropping the cache fields undercounts a cached
 *   200k-token conversation as a few hundred tokens.
 * - OpenAI (Codex): `input_tokens` ALREADY includes `cached_tokens`, so adding
 *   the cache field again would double-count it.
 *
 * The key name itself is the signal, so we classify by name. For the genuinely
 * ambiguous spellings we additionally check the subset invariant
 * (`cached <= input`): a subset cannot exceed its parent, so a violation proves
 * the field is additive regardless of what it is called.
 */

/** Container keys worth scanning for a usage block, in precedence order. */
const CONTAINER_KEYS = [
  "usage",
  "token_usage",
  "tokenUsage",
  "contextUsage",
  // Codex tokenUsage reports both the current turn and a session cumulative
  // block. The current-turn block must win for context-window calculations.
  "last_token_usage",
  "lastTokenUsage",
  "totalTokenUsage",
  "total_token_usage",
  "usage_metadata",
  "usageMetadata",
  "metrics",
  "total",
  "last",
  "message",
  "result",
  "response",
  "step_update",
  "prompt_tokens_details",
  "promptTokensDetails",
  "input_tokens_details",
  "inputTokensDetails",
  "output_tokens_details",
  "outputTokensDetails",
  "completion_tokens_details",
  "completionTokensDetails"
] as const;

const INPUT_KEYS = ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"] as const;
const OUTPUT_KEYS = ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"] as const;

/**
 * Anthropic spellings — these sit ALONGSIDE `input_tokens`, not inside it.
 * Presence of any of these marks the whole payload as Anthropic-family.
 */
const CACHE_READ_ADDITIVE_KEYS = ["cache_read_input_tokens", "cacheReadInputTokens"] as const;
const CACHE_CREATION_KEYS = [
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "cache_creation_tokens",
  "cacheCreationTokens"
] as const;

/** OpenAI-family spellings — already counted inside `input_tokens`. */
const CACHE_SUBSET_KEYS = [
  "cached_input_tokens",
  "cachedInputTokens",
  "cached_tokens",
  "cachedTokens",
  "prompt_cache_tokens",
  "promptCacheTokens",
  "cache_read_tokens",
  "cacheReadTokens"
] as const;

const REASONING_KEYS = [
  "reasoning_tokens",
  "reasoningTokens",
  "thinking_tokens",
  "thinkingTokens",
  "reasoning_output_tokens",
  "reasoningOutputTokens"
] as const;

const REPORTED_TOTAL_KEYS = [
  "total_tokens",
  "totalTokens",
  "total_token_count",
  "totalTokenCount",
  "total_token_usage"
] as const;

const CONTEXT_WINDOW_KEYS = [
  "context_window",
  "contextWindow",
  "model_context_window",
  "modelContextWindow",
  "max_context_tokens",
  "maxContextTokens"
] as const;

const PLAN_REMAINING_KEYS = ["plan_remaining", "planRemaining", "rate_limit_remaining", "rateLimitRemaining"] as const;
const PLAN_LIMIT_KEYS = ["plan_limit", "planLimit", "rate_limit_limit", "rateLimitLimit"] as const;
const PLAN_LABEL_KEYS = ["plan_label", "planLabel", "rate_limit_label", "rateLimitLabel", "subscription"] as const;

/** Measured fields — merged per-field, last writer wins. Derived fields are excluded. */
const MEASURED_KEYS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "contextWindow",
  "contextWindowSource",
  "planRemaining",
  "planLimit",
  "planLabel"
] as const satisfies readonly (keyof ContextUsage)[];

export const PLAN_LABEL_MAX = 80;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Collect the root plus whitelisted nested containers, depth-limited. */
function collectSources(root: Record<string, unknown>): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [root];
  const walk = (record: Record<string, unknown>, depth: number): void => {
    if (depth > 2) return;
    for (const key of CONTAINER_KEYS) {
      const nested = asRecord(record[key]);
      if (nested && !sources.includes(nested)) {
        sources.push(nested);
        walk(nested, depth + 1);
      }
    }
  };
  walk(root, 1);
  return sources;
}

/** Locate Codex's current-turn usage block inside any scanned envelope. */
function findLastUsageSource(sources: Record<string, unknown>[]): Record<string, unknown> | undefined {
  for (const source of sources) {
    const snake = asRecord(source.last_token_usage);
    if (snake) return snake;
    const camel = asRecord(source.lastTokenUsage);
    if (camel) return camel;
  }
  return undefined;
}

/** Find nested Codex session-cumulative blocks, which are not context usage. */
function findCumulativeUsageSources(sources: Record<string, unknown>[]): Set<Record<string, unknown>> {
  const cumulative = new Set<Record<string, unknown>>();
  for (const source of sources) {
    const snake = asRecord(source.total_token_usage);
    if (snake) cumulative.add(snake);
    const camel = asRecord(source.totalTokenUsage);
    if (camel) cumulative.add(camel);
  }
  return cumulative;
}

/** Parse measured token fields from an explicit source list (shared by scope helpers). */
function normalizeMeasuredUsage(
  measurementSources: Record<string, unknown>[],
  windowSources: Record<string, unknown>[]
): ContextUsage | undefined {
  const reportedInput = readNumber(measurementSources, INPUT_KEYS);
  const outputTokens = readNumber(measurementSources, OUTPUT_KEYS);
  const cacheRead = readNumber(measurementSources, CACHE_READ_ADDITIVE_KEYS);
  const cacheCreation = readNumber(measurementSources, CACHE_CREATION_KEYS);
  const cacheSubset = readNumber(measurementSources, CACHE_SUBSET_KEYS);
  const reasoningTokens = readNumber(measurementSources, REASONING_KEYS);
  const reportedTotal = readNumber(measurementSources, REPORTED_TOTAL_KEYS);

  const anthropicStyle = cacheRead != null || cacheCreation != null;
  const subsetInvariantBroken =
    cacheSubset != null && reportedInput != null && cacheSubset > reportedInput;

  let inputTokens: number | undefined;
  if (anthropicStyle) {
    inputTokens = (reportedInput ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
  } else if (subsetInvariantBroken) {
    inputTokens = (reportedInput ?? 0) + (cacheSubset ?? 0);
  } else {
    inputTokens = reportedInput;
  }

  const cachedInputTokens = cacheRead ?? cacheSubset;
  const reportedWindow = readNumber(windowSources, CONTEXT_WINDOW_KEYS);
  const contextWindow = reportedWindow != null && reportedWindow > 0 ? reportedWindow : undefined;
  const planRemaining = readNumber(windowSources, PLAN_REMAINING_KEYS);
  const planLimitCandidate = readNumber(windowSources, PLAN_LIMIT_KEYS);
  const planLimit = planLimitCandidate != null && planLimitCandidate > 0 ? planLimitCandidate : undefined;
  const planLabel = readString(windowSources, PLAN_LABEL_KEYS);

  const hasAnything =
    inputTokens != null
    || outputTokens != null
    || cachedInputTokens != null
    || reasoningTokens != null
    || reportedTotal != null
    || contextWindow != null
    || planRemaining != null
    || planLimit != null
    || planLabel != null;
  if (!hasAnything) return undefined;

  return withDerivedTotals({
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(cachedInputTokens != null ? { cachedInputTokens } : {}),
    ...(reasoningTokens != null ? { reasoningTokens } : {}),
    ...(reportedTotal != null ? { totalTokens: reportedTotal } : {}),
    ...(contextWindow != null ? { contextWindow } : {}),
    ...(contextWindow != null ? { contextWindowSource: "provider" as const } : {}),
    ...(planRemaining != null ? { planRemaining } : {}),
    ...(planLimit != null ? { planLimit } : {}),
    ...(planLabel != null ? { planLabel } : {})
  });
}

/**
 * First finite non-negative number found under any of `keys`.
 *
 * Returns `undefined` when absent so a legitimate `0` survives, and skips
 * `null` / `""` instead of coercing them (`Number(null) === 0` used to
 * short-circuit the whole search and mask a real value in a nested container).
 */
function readNumber(sources: Record<string, unknown>[], keys: readonly string[]): number | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const raw = source[key];
      if (typeof raw !== "number" && typeof raw !== "string") continue;
      if (raw === "") continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value >= 0) return value;
    }
  }
  return undefined;
}

function readString(sources: Record<string, unknown>[], keys: readonly string[]): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const raw = source[key];
      if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, PLAN_LABEL_MAX);
    }
  }
  return undefined;
}

/** Derived context numbers. `totalTokens` is null when nothing was reported. */
export type ContextUsageTotals = {
  totalTokens: number | null;
  contextWindow: number | null;
  remainingTokens: number | null;
  /** 0-100, or null when the window is unknown or the sample is invalid. */
  usedPercent: number | null;
};

/**
 * Resolve the derived numbers from any `ContextUsage`.
 *
 * `totalTokens` takes the larger of `inputTokens + outputTokens` and any total
 * the producer reported. This is the consumed amount shown in the UI. Context
 * occupancy is only valid when that amount fits inside the provider-reported
 * window; an impossible sample is left unpercentaged instead of being clipped
 * to a misleading 100%.
 */
export function resolveContextUsageTotals(usage: ContextUsage): ContextUsageTotals {
  const summed = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const reported = usage.totalTokens ?? 0;
  const total = Math.max(summed, reported);
  const hasTotal = usage.inputTokens != null || usage.outputTokens != null || usage.totalTokens != null;
  const totalTokens = hasTotal ? total : null;
  const contextWindow = usage.contextWindow != null && usage.contextWindow > 0 ? usage.contextWindow : null;
  const contextSampleValid = contextWindow != null && total <= contextWindow;
  const remainingTokens = contextSampleValid ? contextWindow! - total : null;
  const usedPercent = contextSampleValid
    ? Math.round((total / contextWindow!) * 100)
    : null;
  return { totalTokens, contextWindow, remainingTokens, usedPercent };
}

/**
 * Copy one measured field, preferring the newer sample. Generic over the key so
 * the value type stays correlated with it (no cast needed).
 */
function carryMeasured<K extends (typeof MEASURED_KEYS)[number]>(
  target: ContextUsage,
  key: K,
  next: ContextUsage,
  previous?: ContextUsage
): void {
  const value = next[key] ?? previous?.[key];
  if (value != null) target[key] = value;
}

/** Rebuild `totalTokens` / `remainingTokens` from the measured fields. */
export function withDerivedTotals(usage: ContextUsage): ContextUsage {
  // Read the derived numbers off the input first — a reported total counts as
  // input here — then emit only measured fields plus the freshly derived ones,
  // so a stale derived value can never survive a round trip.
  const { totalTokens, remainingTokens } = resolveContextUsageTotals(usage);
  const next: ContextUsage = {};
  for (const key of MEASURED_KEYS) carryMeasured(next, key, usage);
  if (totalTokens != null) next.totalTokens = totalTokens;
  if (remainingTokens != null) next.remainingTokens = remainingTokens;
  return next;
}

/**
 * Parse a raw CLI usage payload into the normalized `ContextUsage` contract.
 *
 * A context window is accepted only when the CLI payload reports it. Model
 * catalog guesses are intentionally not accepted here because they can make
 * a session look full when the provider is using a different window.
 */
export function normalizeContextUsage(
  raw: unknown,
  /** @deprecated retained for callers compiled against older protocol versions; ignored. */
  _fallbackContextWindow?: number
): ContextUsage | undefined {
  const root = asRecord(raw);
  if (!root) return undefined;
  const sources = collectSources(root);
  // Codex exposes both last_token_usage (current turn) and total_token_usage
  // (session cumulative). Context-window math must use only the former when it
  // is available; otherwise a long session appears permanently full. If the
  // current block is absent, ignore the cumulative block entirely and let the
  // UI say that context usage cannot be calculated.
  const lastUsageSource = findLastUsageSource(sources);
  const cumulativeSources = findCumulativeUsageSources(sources);
  const measurementSources = lastUsageSource
    ? [lastUsageSource]
    : cumulativeSources.size
      ? sources.filter((source) => !cumulativeSources.has(source))
      : sources;

  return normalizeMeasuredUsage(measurementSources, sources);
}

/**
 * Current-turn token consumption only. Returns undefined when the payload is
 * cumulative-only (Codex `total_token_usage` without `last_token_usage`).
 */
export function normalizeTurnContextUsage(raw: unknown): ContextUsage | undefined {
  const root = asRecord(raw);
  if (!root) return undefined;
  const sources = collectSources(root);
  const lastUsageSource = findLastUsageSource(sources);
  if (lastUsageSource) {
    return normalizeMeasuredUsage([lastUsageSource], sources);
  }
  const cumulativeSources = findCumulativeUsageSources(sources);
  if (cumulativeSources.size > 0) {
    const nonCumulative = sources.filter((source) => !cumulativeSources.has(source));
    const hasTurnMeasured = readNumber(nonCumulative, INPUT_KEYS) != null
      || readNumber(nonCumulative, OUTPUT_KEYS) != null
      || readNumber(nonCumulative, REPORTED_TOTAL_KEYS) != null;
    if (!hasTurnMeasured) return undefined;
  }
  const usage = normalizeContextUsage(raw);
  if (!usage) return undefined;
  return resolveContextUsageTotals(usage).totalTokens != null ? usage : undefined;
}

/**
 * Provider session cumulative consumption (Codex `total_token_usage` when present).
 */
export function normalizeSessionContextUsage(raw: unknown): ContextUsage | undefined {
  const root = asRecord(raw);
  if (!root) return undefined;
  const sources = collectSources(root);
  const cumulativeSources = findCumulativeUsageSources(sources);
  if (cumulativeSources.size === 0) return undefined;
  const cumulative = [...cumulativeSources][0]!;
  return normalizeMeasuredUsage([cumulative], sources);
}

/**
 * Fold a newer sample into an accumulated one.
 *
 * Measured fields are last-writer-wins so a sparse sample (e.g. an event that
 * only carries output tokens) does not erase the window size or input count
 * learned earlier. Derived fields are recomputed from the merged result rather
 * than inherited — inheriting them is what used to leave `remainingTokens`
 * disagreeing with `totalTokens`.
 */
export function mergeContextUsage(
  previous: ContextUsage | undefined,
  next: ContextUsage
): ContextUsage {
  if (!previous) return withDerivedTotals(next);
  const merged: ContextUsage = {};
  for (const key of MEASURED_KEYS) carryMeasured(merged, key, next, previous);
  // Only the incoming sample's own reported total is authoritative; a previous
  // total is already represented through the merged input/output above.
  if (next.totalTokens != null) merged.totalTokens = next.totalTokens;
  return withDerivedTotals(merged);
}
