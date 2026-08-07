import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliEngine, EngineModelOption, ReasoningEffort } from "@anytimevibe/protocol";

export type { EngineModelOption };

export type EngineCapability = {
  engine: CliEngine;
  models: EngineModelOption[];
  reasoningEfforts: ReasoningEffort[];
  /** Current default on this machine (from local CLI config). */
  currentModel?: string;
  currentReasoningEffort?: ReasoningEffort;
};

function parseTomlString(content: string, key: string): string | undefined {
  // model = "foo" or model_reasoning_effort = "xhigh"
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "mi");
  const match = content.match(re);
  return match?.[1]?.trim() || undefined;
}

function normalizeEffort(value: string | undefined): ReasoningEffort | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase().trim();
  if (v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max") return v;
  return undefined;
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function discoverCodexCapability(): Promise<EngineCapability> {
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const models: EngineModelOption[] = [];
  const seen = new Set<string>();
  let currentModel: string | undefined;
  let currentReasoningEffort: ReasoningEffort | undefined;
  let reasoningEfforts: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

  const configText = await readText(path.join(codexHome, "config.toml"));
  if (configText) {
    currentModel = parseTomlString(configText, "model");
    currentReasoningEffort = normalizeEffort(parseTomlString(configText, "model_reasoning_effort"));
  }

  const catalogRaw = await readText(path.join(codexHome, "cc-switch-model-catalog.json"));
  if (catalogRaw) {
    try {
      const catalog = JSON.parse(catalogRaw) as { models?: Array<Record<string, any>> };
      for (const row of catalog.models || []) {
        const id = String(row.slug || row.id || row.model || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const label = String(row.display_name || row.name || id).trim();
        const contextWindow = Number(row.context_window || row.max_context_window || 0) || undefined;
        models.push({ id, label, ...(contextWindow ? { contextWindow } : {}) });
        const levels = row.supported_reasoning_levels;
        if (Array.isArray(levels) && levels.length) {
          const mapped = levels
            .map((item) => normalizeEffort(String(item?.level || item?.id || item || "")))
            .filter((item): item is ReasoningEffort => Boolean(item));
          if (mapped.length) reasoningEfforts = [...new Set(mapped)];
        }
      }
    } catch {
      // ignore
    }
  }

  if (currentModel && !seen.has(currentModel)) {
    models.unshift({ id: currentModel, label: currentModel });
  }

  return {
    engine: "codex",
    models,
    reasoningEfforts,
    ...(currentModel ? { currentModel } : {}),
    ...(currentReasoningEffort ? { currentReasoningEffort } : {})
  };
}

async function discoverClaudeCapability(): Promise<EngineCapability> {
  const home = os.homedir();
  const models: EngineModelOption[] = [];
  const seen = new Set<string>();
  let currentModel: string | undefined;
  let currentReasoningEffort: ReasoningEffort | undefined;
  const reasoningEfforts: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

  const settingsRaw = await readText(path.join(home, ".claude", "settings.json"));
  if (settingsRaw) {
    try {
      const settings = JSON.parse(settingsRaw) as {
        effortLevel?: string;
        model?: string;
        env?: Record<string, string>;
      };
      currentReasoningEffort = normalizeEffort(settings.effortLevel);
      currentModel = settings.model?.trim() || undefined;
      const env = settings.env || {};
      const candidates: Array<[string, string]> = [
        ["opus", env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME || env.ANTHROPIC_DEFAULT_OPUS_MODEL || "opus"],
        ["sonnet", env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME || env.ANTHROPIC_DEFAULT_SONNET_MODEL || "sonnet"],
        ["haiku", env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME || env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "haiku"]
      ];
      for (const [alias, full] of candidates) {
        const id = String(full || alias).replace(/\[.*?\]/g, "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({ id, label: alias === id ? id : `${alias} (${id})` });
        if (!seen.has(alias) && alias !== id) {
          seen.add(alias);
          models.push({ id: alias, label: alias });
        }
      }
      // Also include raw env model ids
      for (const key of Object.keys(env)) {
        if (!/MODEL/i.test(key)) continue;
        const id = String(env[key] || "").replace(/\[.*?\]/g, "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({ id, label: id });
      }
    } catch {
      // ignore
    }
  }

  // Fallback aliases when no settings
  if (!models.length) {
    for (const id of ["opus", "sonnet", "haiku"]) {
      models.push({ id, label: id });
    }
  }

  if (currentModel && !seen.has(currentModel)) {
    models.unshift({ id: currentModel, label: currentModel });
  }

  return {
    engine: "claude",
    models,
    reasoningEfforts,
    ...(currentModel ? { currentModel } : {}),
    ...(currentReasoningEffort ? { currentReasoningEffort } : {})
  };
}

async function discoverGrokCapability(): Promise<EngineCapability> {
  const home = os.homedir();
  const grokHome = process.env.GROK_HOME || path.join(home, ".grok");
  const models: EngineModelOption[] = [];
  const seen = new Set<string>();
  let currentModel: string | undefined;
  let currentReasoningEffort: ReasoningEffort | undefined;
  const reasoningEfforts: ReasoningEffort[] = ["low", "medium", "high"];

  const cacheRaw = await readText(path.join(grokHome, "models_cache.json"));
  if (cacheRaw) {
    try {
      const cache = JSON.parse(cacheRaw) as { models?: Record<string, any> };
      for (const [id, value] of Object.entries(cache.models || {})) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const info = value?.info || value || {};
        const label = String(info.name || info.system_prompt_label || id);
        const contextWindow = Number(info.context_window || 0) || undefined;
        models.push({ id, label, ...(contextWindow ? { contextWindow } : {}) });
      }
    } catch {
      // ignore
    }
  }

  const configRaw = await readText(path.join(grokHome, "config.toml"));
  if (configRaw) {
    currentModel = parseTomlString(configRaw, "model") || parseTomlString(configRaw, "default_model");
    currentReasoningEffort = normalizeEffort(
      parseTomlString(configRaw, "reasoning_effort")
      || parseTomlString(configRaw, "effort")
      || parseTomlString(configRaw, "model_reasoning_effort")
    );
  }
  if (process.env.GROK_MODEL) currentModel = process.env.GROK_MODEL.trim();
  if (process.env.XAI_MODEL) currentModel = process.env.XAI_MODEL.trim();

  if (currentModel && !seen.has(currentModel)) {
    models.unshift({ id: currentModel, label: currentModel });
  }

  return {
    engine: "grok",
    models,
    reasoningEfforts,
    ...(currentModel ? { currentModel } : {}),
    ...(currentReasoningEffort ? { currentReasoningEffort } : {})
  };
}

/**
 * Cursor Agent CLI models (see https://cursor.com/docs/cli + https://cursor.com/docs/models).
 *
 * Current CLI uses suffix slugs, NOT bracket params:
 *   gpt-5.6-sol-medium / gpt-5.6-sol-medium-fast / composer-2.5-fast
 * Older docs used `id[fast=…,effort=…]` — we still accept that from the web and rewrite to slugs.
 */
const CURSOR_FALLBACK_MODELS: EngineModelOption[] = [
  { id: "auto", label: "Auto" },
  {
    id: "composer-2.5",
    label: "Composer 2.5",
    supportsFast: true
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    supportsFast: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"]
  },
  {
    id: "claude-opus-5-thinking",
    label: "Claude Opus 5 Thinking",
    supportsFast: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    supportsFast: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    supportsFast: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    supportsFast: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
  },
  { id: "cursor-grok-4.5", label: "Grok 4.5", supportsFast: true, reasoningEfforts: ["low", "medium", "high"] },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    supportsFast: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
  }
];

/** Live CLI slugs from the last successful `agent models` probe (used to pick valid --model). */
let cursorLiveSlugSet: Set<string> = new Set();

/** Effort tokens that appear as `-{token}` before optional `-fast` in Cursor CLI slugs. */
const CURSOR_EFFORT_TOKENS = [
  "thinking-max",
  "thinking-xhigh",
  "thinking-high",
  "thinking-medium",
  "thinking-low",
  "extra-high",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
] as const;

type CursorEffortToken = (typeof CURSOR_EFFORT_TOKENS)[number];

function reasoningToEffortToken(effort: ReasoningEffort): CursorEffortToken {
  if (effort === "xhigh") return "xhigh";
  return effort;
}

function effortTokenToReasoning(token: CursorEffortToken): ReasoningEffort | undefined {
  if (token === "none") return undefined;
  if (token === "extra-high") return "xhigh";
  if (token.startsWith("thinking-")) {
    const inner = token.slice("thinking-".length) as ReasoningEffort | "xhigh";
    if (inner === "low" || inner === "medium" || inner === "high" || inner === "xhigh" || inner === "max") {
      return inner;
    }
    return undefined;
  }
  if (token === "low" || token === "medium" || token === "high" || token === "xhigh" || token === "max") {
    return token;
  }
  return undefined;
}

function splitCursorSlug(id: string): { base: string; effortToken?: CursorEffortToken; fast: boolean } {
  let rest = id.trim();
  if (!rest) return { base: "", fast: false };
  let fast = false;
  if (rest.endsWith("-fast")) {
    fast = true;
    rest = rest.slice(0, -5);
  }
  for (const token of CURSOR_EFFORT_TOKENS) {
    const suffix = `-${token}`;
    if (rest.endsWith(suffix) && rest.length > suffix.length) {
      return { base: rest.slice(0, -suffix.length), effortToken: token, fast };
    }
  }
  return { base: rest, fast };
}

function humanizeCursorBase(base: string): string {
  if (base === "auto") return "Auto";
  if (base === "composer-2.5") return "Composer 2.5";
  return base
    .split("-")
    .map((part) => {
      if (/^\d+(\.\d+)*$/.test(part)) return part;
      if (part.toLowerCase() === "gpt") return "GPT";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

type CursorFamily = {
  base: string;
  label: string;
  supportsFast: boolean;
  reasoningEfforts: ReasoningEffort[];
  /** All live slugs belonging to this family. */
  slugs: string[];
};

function groupCursorLiveSlugs(ids: string[]): CursorFamily[] {
  const byBase = new Map<string, {
    slugs: string[];
    efforts: Set<ReasoningEffort>;
    supportsFast: boolean;
    hasBare: boolean;
  }>();

  for (const id of ids) {
    const { base, effortToken, fast } = splitCursorSlug(id);
    if (!base || base.includes("[")) continue;
    let row = byBase.get(base);
    if (!row) {
      row = { slugs: [], efforts: new Set(), supportsFast: false, hasBare: false };
      byBase.set(base, row);
    }
    row.slugs.push(id);
    if (fast) row.supportsFast = true;
    if (!effortToken) row.hasBare = true;
    const effort = effortToken ? effortTokenToReasoning(effortToken) : undefined;
    if (effort) row.efforts.add(effort);
  }

  const families: CursorFamily[] = [];
  for (const [base, row] of byBase) {
    const order: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
    const reasoningEfforts = order.filter((e) => row.efforts.has(e));
    families.push({
      base,
      label: humanizeCursorBase(base),
      supportsFast: row.supportsFast,
      reasoningEfforts,
      slugs: row.slugs
    });
  }
  return families;
}

function looksLikeCursorModelLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 200) return false;
  if (/^(Available|Models|NAME|ID|Usage|\$|──|==)/i.test(t)) return false;
  if (/grok\s+build|Grok Build/i.test(t)) return false;
  return true;
}

function extractCursorModelIds(raw: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  // Comma-separated dump from error text / some CLI versions.
  if (raw.includes(",") && !raw.includes("\n")) {
    for (const part of raw.split(",")) {
      const id = part.trim();
      if (!id || seen.has(id) || /\s/.test(id) || id.includes("[")) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length) return ids;
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!looksLikeCursorModelLine(line)) continue;
    const cleaned = line.replace(/^[-*•]\s*/, "").trim();
    const m =
      cleaned.match(/^([a-z0-9][\w./+-]*)\s{2,}(.+)$/i)
      || cleaned.match(/^([a-z0-9][\w./+-]*)\s+\(([^)]+)\)\s*$/i)
      || cleaned.match(/^([a-z0-9][\w./+-]+)\s*$/i);
    if (!m?.[1]) continue;
    const id = m[1].trim();
    if (!id || seen.has(id) || id.includes(" ") || id.includes("[")) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function runCursorModelsList(command: string): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const isWindows = process.platform === "win32";
    const { windowsCmdArguments } = await import("../windows-command");
    const { collectLocalProxyEnv, cloudProxyChildEnv } = await import("../local-proxy");
    const proxy = await collectLocalProxyEnv();
    const env = await cloudProxyChildEnv();
    const attempts: string[][] = [["models"], ["--list-models"], ["models", "--json"]];
    for (const args of attempts) {
      try {
        const executable = isWindows ? process.env.ComSpec ?? "cmd.exe" : command;
        const finalArgs = isWindows ? windowsCmdArguments(command, args) : args;
        const { stdout, stderr } = await execFileAsync(executable, finalArgs, {
          timeout: 20_000,
          windowsHide: true,
          windowsVerbatimArguments: isWindows,
          // Must use proxy: Cursor model list is IP-region gated.
          env,
          maxBuffer: 1_000_000
        });
        const text = `${stdout || ""}\n${stderr || ""}`.trim();
        if (text && !/unknown command|unrecognized|error:/i.test(text.slice(0, 200))) {
          if (Object.keys(proxy).length) {
            console.log("[models] Cursor models listed via local proxy (non-China egress)");
          }
          return text;
        }
      } catch {
        // try next
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function pickCursorSlug(
  base: string,
  options?: { reasoningEffort?: ReasoningEffort; fast?: boolean },
  live?: Set<string>
): string {
  const fast = options?.fast === true;
  let effort = options?.reasoningEffort;

  // Bare base (e.g. gpt-5.6-sol) is often not a valid CLI id — default to medium when live set known.
  if (!effort && live && live.size && !live.has(base) && !live.has(`${base}-fast`)) {
    const fallbacks: ReasoningEffort[] = ["medium", "high", "low", "xhigh", "max"];
    for (const candidate of fallbacks) {
      const token = reasoningToEffortToken(candidate);
      const slug = fast ? `${base}-${token}-fast` : `${base}-${token}`;
      const alt = candidate === "xhigh"
        ? (fast ? `${base}-extra-high-fast` : `${base}-extra-high`)
        : null;
      if (live.has(slug) || (alt && live.has(alt))) {
        effort = candidate;
        break;
      }
    }
  }

  const tokens: Array<string | undefined> = [];
  if (effort) {
    const primary = reasoningToEffortToken(effort);
    tokens.push(primary);
    if (effort === "xhigh") tokens.push("extra-high");
    if (base.endsWith("-thinking") || /(?:^|-)thinking$/i.test(base)) {
      tokens.unshift(`thinking-${effort === "xhigh" ? "xhigh" : effort}`);
    }
  } else {
    tokens.push(undefined);
  }

  const candidates: string[] = [];
  for (const token of tokens) {
    const core = token ? `${base}-${token}` : base;
    if (fast) candidates.push(`${core}-fast`);
    candidates.push(core);
  }
  if (fast) candidates.push(`${base}-fast`);
  candidates.push(base);

  const seen = new Set<string>();
  const ordered = candidates.filter((id) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  if (live && live.size) {
    for (const id of ordered) {
      if (live.has(id)) return id;
    }
    if (effort) {
      const want = reasoningToEffortToken(effort);
      for (const slug of live) {
        const parts = splitCursorSlug(slug);
        if (parts.base !== base) continue;
        if (parts.fast !== fast) continue;
        if (parts.effortToken === want || (want === "xhigh" && parts.effortToken === "extra-high")) {
          return slug;
        }
      }
    }
  }

  return ordered[0] || base;
}

/**
 * Parse legacy `id[fast=true,effort=high]` or bare / slug ids into parts.
 */
export function parseCursorModelRef(model: string | undefined): {
  base: string;
  fast?: boolean;
  reasoningEffort?: ReasoningEffort;
} {
  const raw = (model || "").trim();
  if (!raw) return { base: "composer-2.5" };
  const bracket = raw.match(/^([^[\]]+)\[([^\]]+)\]\s*$/);
  if (bracket) {
    const base = (bracket[1] || "").trim() || "composer-2.5";
    let fast: boolean | undefined;
    let reasoningEffort: ReasoningEffort | undefined;
    for (const part of (bracket[2] || "").split(",")) {
      const [k, v] = part.split("=").map((s) => s.trim());
      if (!k) continue;
      if (k === "fast") fast = v === "true" || v === "1";
      if (k === "effort") {
        const mapped = v === "extra_high" || v === "extra-high" ? "xhigh" : v;
        if (mapped === "low" || mapped === "medium" || mapped === "high" || mapped === "xhigh" || mapped === "max") {
          reasoningEffort = mapped;
        }
      }
    }
    return { base, ...(fast !== undefined ? { fast } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
  }

  // Already a live slug like gpt-5.6-sol-medium-fast
  if (!raw.includes("[") && (raw.includes("-fast") || CURSOR_EFFORT_TOKENS.some((t) => raw.endsWith(`-${t}`)))) {
    const parts = splitCursorSlug(raw);
    const effort = parts.effortToken ? effortTokenToReasoning(parts.effortToken) : undefined;
    return {
      base: parts.base,
      ...(parts.fast ? { fast: true } : { fast: false }),
      ...(effort ? { reasoningEffort: effort } : {})
    };
  }

  return { base: raw };
}

async function discoverCursorCapability(): Promise<EngineCapability> {
  const models: EngineModelOption[] = [];
  const seen = new Set<string>();
  let liveCount = 0;
  cursorLiveSlugSet = new Set();

  try {
    const { resolveEngineBinary } = await import("./detect");
    const binary = await resolveEngineBinary("cursor");
    if (binary) {
      const raw = await runCursorModelsList(binary);
      if (raw) {
        const ids = extractCursorModelIds(raw);
        for (const id of ids) cursorLiveSlugSet.add(id);
        liveCount = ids.length;
        const families = groupCursorLiveSlugs(ids);
        for (const family of families) {
          if (seen.has(family.base)) continue;
          seen.add(family.base);
          models.push({
            id: family.base,
            label: family.label,
            ...(family.supportsFast ? { supportsFast: true } : {}),
            ...(family.reasoningEfforts.length ? { reasoningEfforts: family.reasoningEfforts } : {})
          });
        }
      }
    }
  } catch {
    // fall through
  }

  if (liveCount === 0) {
    for (const row of CURSOR_FALLBACK_MODELS) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      models.push({ ...row });
    }
  } else {
    for (const row of CURSOR_FALLBACK_MODELS) {
      const existing = models.find((m) => m.id === row.id);
      if (!existing) continue;
      if (row.supportsFast && existing.supportsFast === undefined) existing.supportsFast = true;
      if (row.reasoningEfforts?.length && !existing.reasoningEfforts?.length) {
        existing.reasoningEfforts = row.reasoningEfforts;
      }
      if (row.label && existing.label === existing.id) existing.label = row.label;
    }
  }

  models.sort((a, b) => {
    const rank = (id: string) => {
      if (id === "composer-2.5") return 0;
      if (id === "auto") return 1;
      if (id.startsWith("claude-opus")) return 2;
      if (id.includes("fable")) return 3;
      if (id.startsWith("gpt-5.6-sol")) return 4;
      if (id.startsWith("gpt-")) return 5;
      if (id.startsWith("grok") || id.startsWith("cursor-grok")) return 6;
      return 10;
    };
    return rank(a.id) - rank(b.id) || a.label.localeCompare(b.label);
  });

  const envModel = process.env.CURSOR_MODEL?.trim();
  const envBase = envModel ? parseCursorModelRef(envModel).base : "";
  const currentModel = envBase
    || (models.some((m) => m.id === "composer-2.5") ? "composer-2.5" : models[0]?.id)
    || "auto";
  if (currentModel && !seen.has(currentModel)) {
    models.unshift({ id: currentModel, label: humanizeCursorBase(currentModel) });
  }

  const reasoningEfforts: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

  return {
    engine: "cursor",
    models,
    reasoningEfforts,
    currentModel
  };
}

/**
 * Build Cursor CLI `--model` slug from base id + effort + optional fast flag.
 * Emits `gpt-5.6-sol-medium-fast`, never legacy `gpt-5.6-sol[fast=true]`.
 */
export function formatCursorModelArg(
  model: string | undefined,
  options?: { reasoningEffort?: ReasoningEffort; fast?: boolean }
): string {
  const parsed = parseCursorModelRef(model);
  if (parsed.base === "auto") return "auto";

  const fast = options?.fast ?? parsed.fast;
  const reasoningEffort = options?.reasoningEffort ?? parsed.reasoningEffort;

  return pickCursorSlug(
    parsed.base,
    {
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(fast !== undefined ? { fast } : {})
    },
    cursorLiveSlugSet.size ? cursorLiveSlugSet : undefined
  );
}

/** Collect model + effort options from local CLI configs/caches on this machine. */
export async function discoverEngineCapabilities(): Promise<EngineCapability[]> {
  const [codex, claude, grok, cursor] = await Promise.all([
    discoverCodexCapability(),
    discoverClaudeCapability(),
    discoverGrokCapability(),
    discoverCursorCapability()
  ]);
  return [codex, claude, grok, cursor];
}
