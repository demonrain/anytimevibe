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
  /** Cursor: whether the currently selected model has thinking enabled. */
  currentThinking?: boolean;
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
  // Cockpit / Codex catalogs may expose "ultra"; map to max for the shared schema.
  if (v === "ultra") return "max";
  if (v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max") return v;
  return undefined;
}

function parseCatalogEffortList(raw: unknown): ReasoningEffort[] {
  if (!Array.isArray(raw)) return [];
  const out: ReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = normalizeEffort(
      String(
        (item && typeof item === "object"
          ? (item as Record<string, unknown>).effort
            ?? (item as Record<string, unknown>).level
            ?? (item as Record<string, unknown>).id
            ?? (item as Record<string, unknown>).value
          : item) ?? ""
      )
    );
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function ingestCodexCatalogRows(
  rows: Array<Record<string, any>> | undefined,
  models: EngineModelOption[],
  seen: Set<string>,
  effortUnion: Set<ReasoningEffort>
): void {
  for (const row of rows || []) {
    const id = String(row.slug || row.id || row.model || "").trim();
    if (!id) continue;
    const label = String(row.display_name || row.name || id).trim() || id;
    const contextWindow = Number(row.context_window || row.max_context_window || 0) || undefined;
    const modelEfforts = parseCatalogEffortList(
      row.supported_reasoning_levels || row.reasoning_efforts || row.supported_efforts
    );
    for (const effort of modelEfforts) effortUnion.add(effort);

    if (seen.has(id)) {
      const existing = models.find((item) => item.id === id);
      if (!existing) continue;
      if (modelEfforts.length) {
        const merged = [...new Set([...(existing.reasoningEfforts || []), ...modelEfforts])];
        const order: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
        existing.reasoningEfforts = order.filter((effort) => merged.includes(effort));
      }
      if (!existing.contextWindow && contextWindow) existing.contextWindow = contextWindow;
      if (existing.label === existing.id && label !== id) existing.label = label;
      continue;
    }
    seen.add(id);
    models.push({
      id,
      label,
      ...(contextWindow ? { contextWindow } : {}),
      ...(modelEfforts.length ? { reasoningEfforts: modelEfforts } : {})
    });
  }
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
  const effortUnion = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

  const configText = await readText(path.join(codexHome, "config.toml"));
  if (configText) {
    currentModel = parseTomlString(configText, "model");
    currentReasoningEffort = normalizeEffort(parseTomlString(configText, "model_reasoning_effort"));
  }

  // Prefer live Codex cache + Cockpit Local Access catalog; CCSwitch is a fallback.
  const catalogFiles = [
    "models_cache.json",
    "cockpit-local-access-model-catalog.json",
    "cc-switch-model-catalog.json"
  ];
  for (const fileName of catalogFiles) {
    const catalogRaw = await readText(path.join(codexHome, fileName));
    if (!catalogRaw) continue;
    try {
      const catalog = JSON.parse(catalogRaw) as {
        models?: Array<Record<string, any>> | Record<string, any>;
      };
      const rows = Array.isArray(catalog.models)
        ? catalog.models
        : catalog.models && typeof catalog.models === "object"
          ? Object.entries(catalog.models).map(([id, value]) => {
              const row = (value && typeof value === "object" ? value : {}) as Record<string, any>;
              const info = (row.info && typeof row.info === "object" ? row.info : row) as Record<string, any>;
              return { slug: id, ...info, ...row };
            })
          : [];
      ingestCodexCatalogRows(rows, models, seen, effortUnion);
    } catch {
      // ignore
    }
  }

  if (currentModel && !seen.has(currentModel)) {
    models.unshift({ id: currentModel, label: currentModel });
  }

  const order: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
  const reasoningEfforts = order.filter((effort) => effortUnion.has(effort));
  if (currentReasoningEffort && !reasoningEfforts.includes(currentReasoningEffort)) {
    reasoningEfforts.unshift(currentReasoningEffort);
  }

  return {
    engine: "codex",
    models,
    reasoningEfforts: reasoningEfforts.length ? reasoningEfforts : ["low", "medium", "high", "xhigh"],
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
        ["haiku", env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME || env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "haiku"],
        ["fable", env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME || env.ANTHROPIC_DEFAULT_FABLE_MODEL || ""]
      ];
      for (const [alias, full] of candidates) {
        const id = String(full || "").replace(/\[.*?\]/g, "").trim();
        if (!id) continue;
        if (!seen.has(id)) {
          seen.add(id);
          models.push({ id, label: alias === id ? id : `${alias} (${id})` });
        }
        if (alias && alias !== id && !seen.has(alias)) {
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

function parseGrokEffortList(raw: unknown): ReasoningEffort[] {
  if (!Array.isArray(raw)) return [];
  const out: ReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = normalizeEffort(
      String(
        (item && typeof item === "object"
          ? (item as Record<string, unknown>).value
            ?? (item as Record<string, unknown>).id
            ?? (item as Record<string, unknown>).level
          : item) ?? ""
      )
    );
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Grok Build ≥1.0 stores catalog in models_cache.json and defaults in:
 *   [models]
 *   default = "grok-4.6"
 *   default_reasoning_effort = "xhigh"
 * Older flat keys (model / reasoning_effort) are still accepted.
 */
async function discoverGrokCapability(): Promise<EngineCapability> {
  const home = os.homedir();
  const grokHome = process.env.GROK_HOME || path.join(home, ".grok");
  const models: EngineModelOption[] = [];
  const seen = new Set<string>();
  let currentModel: string | undefined;
  let currentReasoningEffort: ReasoningEffort | undefined;
  let reasoningEfforts: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
  const effortUnion = new Set<ReasoningEffort>(reasoningEfforts);

  const cacheRaw = await readText(path.join(grokHome, "models_cache.json"));
  if (cacheRaw) {
    try {
      const cache = JSON.parse(cacheRaw) as { models?: Record<string, any> };
      for (const [id, value] of Object.entries(cache.models || {})) {
        if (!id || seen.has(id)) continue;
        const info = value?.info || value || {};
        if (info.hidden === true) continue;
        seen.add(id);
        const label = String(info.name || info.system_prompt_label || id);
        const contextWindow = Number(info.context_window || 0) || undefined;
        const modelEfforts = parseGrokEffortList(info.reasoning_efforts);
        if (modelEfforts.length) {
          for (const effort of modelEfforts) effortUnion.add(effort);
        } else if (info.supports_reasoning_effort) {
          // Catalog claims effort support but omitted list — keep engine defaults.
          for (const effort of reasoningEfforts) effortUnion.add(effort);
        }
        const defaultEffort = normalizeEffort(
          String(info.reasoning_effort || info.default_reasoning_effort || "")
        );
        models.push({
          id,
          label,
          ...(contextWindow ? { contextWindow } : {}),
          ...(modelEfforts.length
            ? { reasoningEfforts: modelEfforts }
            // Catalog says effort is supported but omitted the list — use engine defaults
            // so the web per-model picker still offers levels instead of clearing effort.
            : info.supports_reasoning_effort
              ? { reasoningEfforts: ["low", "medium", "high", "xhigh"] as ReasoningEffort[] }
              : {})
        });
        if (!currentReasoningEffort && defaultEffort) currentReasoningEffort = defaultEffort;
      }
    } catch {
      // ignore
    }
  }

  const configRaw = await readText(path.join(grokHome, "config.toml"));
  if (configRaw) {
    // New Grok Build layout: [models] default / default_reasoning_effort
    const modelsSection = configRaw.match(/\[models\]([\s\S]*?)(?=\n\[|$)/i)?.[1] ?? "";
    currentModel =
      parseTomlString(modelsSection, "default")
      || parseTomlString(configRaw, "model")
      || parseTomlString(configRaw, "default_model")
      || currentModel;
    currentReasoningEffort =
      normalizeEffort(parseTomlString(modelsSection, "default_reasoning_effort"))
      || normalizeEffort(parseTomlString(configRaw, "reasoning_effort"))
      || normalizeEffort(parseTomlString(configRaw, "effort"))
      || normalizeEffort(parseTomlString(configRaw, "model_reasoning_effort"))
      || currentReasoningEffort;

    // Also surface any explicitly configured [model."id"] blocks.
    const modelBlockRe = /\[model\."([^"]+)"\]/gi;
    let match: RegExpExecArray | null;
    while ((match = modelBlockRe.exec(configRaw))) {
      const id = match[1]?.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: id });
    }
  }
  if (process.env.GROK_MODEL) currentModel = process.env.GROK_MODEL.trim();
  if (process.env.XAI_MODEL) currentModel = process.env.XAI_MODEL.trim();

  if (currentModel && !seen.has(currentModel)) {
    models.unshift({ id: currentModel, label: currentModel });
  }

  const order: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
  reasoningEfforts = order.filter((effort) => effortUnion.has(effort));
  if (!reasoningEfforts.length) reasoningEfforts = ["low", "medium", "high", "xhigh"];

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
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsThinking: true,
    thinkingEfforts: ["low", "medium", "high", "xhigh", "max"]
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    supportsFast: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsThinking: true,
    thinkingEfforts: ["low", "medium", "high", "xhigh", "max"]
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsThinking: true,
    thinkingEfforts: ["low", "medium", "max"]
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
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsThinking: true,
    thinkingEfforts: ["low", "medium", "max"]
  }
];

/** Live CLI slugs from the last successful `agent models` probe (used to pick valid --model). */
let cursorLiveSlugSet: Set<string> = new Set();

/**
 * Effort tokens that appear as `-{token}` in Cursor CLI slugs.
 * NOTE: `thinking` is a SEPARATE dimension and is stripped before matching these
 * (Cursor emits e.g. `claude-opus-5-thinking-high` = base + thinking + effort).
 */
const CURSOR_EFFORT_TOKENS = [
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

function effortTokenToReasoning(token: CursorEffortToken | undefined): ReasoningEffort | undefined {
  if (!token || token === "none") return undefined;
  if (token === "extra-high") return "xhigh";
  if (token === "low" || token === "medium" || token === "high" || token === "xhigh" || token === "max") {
    return token;
  }
  return undefined;
}

/**
 * Split a Cursor slug into base + thinking flag + effort + fast.
 *
 * Cursor uses two thinking placements, both supported here:
 *   - infix:  `claude-opus-5-thinking-high`        (base + thinking + effort)
 *   - suffix: `claude-4.6-sonnet-medium-thinking`  (base + effort + thinking)
 *             `claude-4.5-sonnet-thinking`         (base + thinking, no effort)
 */
function splitCursorSlug(id: string): {
  base: string;
  effortToken?: CursorEffortToken;
  fast: boolean;
  thinking: boolean;
} {
  let rest = id.trim();
  if (!rest) return { base: "", fast: false, thinking: false };
  let fast = false;
  if (rest.endsWith("-fast")) {
    fast = true;
    rest = rest.slice(0, -5);
  }
  let thinking = false;
  // Suffix thinking: `...-thinking` (possibly after effort).
  if (rest.endsWith("-thinking")) {
    thinking = true;
    rest = rest.slice(0, -"-thinking".length);
  }
  // Effort token (now free of trailing thinking/fast).
  let effortToken: CursorEffortToken | undefined;
  for (const token of CURSOR_EFFORT_TOKENS) {
    const suffix = `-${token}`;
    if (rest.endsWith(suffix) && rest.length > suffix.length) {
      effortToken = token;
      rest = rest.slice(0, -suffix.length);
      break;
    }
  }
  // Infix thinking: `base-thinking-<effort>` leaves `base-thinking` here.
  if (!thinking && rest.endsWith("-thinking")) {
    thinking = true;
    rest = rest.slice(0, -"-thinking".length);
  }
  return { base: rest, ...(effortToken ? { effortToken } : {}), fast, thinking };
}

/** Normalize Cursor model family ids (CLI may print `Auto` as a label-looking line). */
function normalizeCursorBaseId(base: string): string {
  const raw = (base || "").trim();
  if (!raw) return raw;
  if (/^auto$/i.test(raw)) return "auto";
  return raw;
}

/** True when the Cursor model family is Auto (any casing / legacy bracket form). */
export function isCursorAutoModel(modelId?: string): boolean {
  const base = normalizeCursorBaseId((modelId || "").split("[")[0] || "");
  return base === "auto";
}

/** Persistable family id for UI snapshots — strips `[fast=…]` and normalizes Auto. */
export function cursorPersistedModelId(modelId?: string): string | undefined {
  const raw = (modelId || "").trim();
  if (!raw) return undefined;
  if (isCursorAutoModel(raw)) return "auto";
  return normalizeCursorBaseId(raw.split("[")[0]?.trim() || raw) || undefined;
}

function humanizeCursorBase(base: string): string {
  const id = normalizeCursorBaseId(base);
  if (id === "auto") return "Auto";
  if (id === "composer-2.5") return "Composer 2.5";
  return id
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
  /** Model exposes an extended-thinking variant. */
  supportsThinking: boolean;
  /** Efforts available when thinking is enabled (may differ from reasoningEfforts). */
  thinkingEfforts: ReasoningEffort[];
  /** All live slugs belonging to this family. */
  slugs: string[];
};

function groupCursorLiveSlugs(ids: string[]): CursorFamily[] {
  const byBase = new Map<string, {
    slugs: string[];
    efforts: Set<ReasoningEffort>;
    thinkingEfforts: Set<ReasoningEffort>;
    supportsFast: boolean;
    supportsThinking: boolean;
    hasBare: boolean;
  }>();

  for (const id of ids) {
    const split = splitCursorSlug(id);
    const base = normalizeCursorBaseId(split.base);
    const { effortToken, fast, thinking } = split;
    if (!base || base.includes("[")) continue;
    let row = byBase.get(base);
    if (!row) {
      row = {
        slugs: [],
        efforts: new Set(),
        thinkingEfforts: new Set(),
        supportsFast: false,
        supportsThinking: false,
        hasBare: false
      };
      byBase.set(base, row);
    }
    row.slugs.push(id);
    if (fast) row.supportsFast = true;
    if (thinking) row.supportsThinking = true;
    if (!effortToken && !thinking) row.hasBare = true;
    const effort = effortTokenToReasoning(effortToken);
    if (effort) {
      if (thinking) row.thinkingEfforts.add(effort);
      else row.efforts.add(effort);
    }
  }

  const order: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
  const families: CursorFamily[] = [];
  for (const [base, row] of byBase) {
    families.push({
      base,
      label: humanizeCursorBase(base),
      supportsFast: row.supportsFast,
      reasoningEfforts: order.filter((e) => row.efforts.has(e)),
      supportsThinking: row.supportsThinking,
      thinkingEfforts: order.filter((e) => row.thinkingEfforts.has(e)),
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
    const { collectLocalProxyEnv, cloudProxyChildEnv } = await import("../local-proxy");
    const { execFileWithTreeKill } = await import("./exec-file-tree-kill");
    const proxy = await collectLocalProxyEnv();
    const env = await cloudProxyChildEnv();
    const attempts: string[][] = [["models"], ["--list-models"], ["models", "--json"]];
    for (const args of attempts) {
      try {
        const { stdout, stderr } = await execFileWithTreeKill(command, args, {
          timeoutMs: 20_000,
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

/** Build the ordered `thinking` segment candidates for a slug (infix + suffix forms). */
function cursorSlugCandidates(
  base: string,
  effort: ReasoningEffort | undefined,
  thinking: boolean,
  fast: boolean
): string[] {
  const effortTokens: string[] = [];
  if (effort) {
    effortTokens.push(reasoningToEffortToken(effort));
    if (effort === "xhigh") effortTokens.push("extra-high");
  }

  // Core forms (without fast), most-specific first.
  const cores: string[] = [];
  if (thinking) {
    // Infix: base-thinking-<effort>
    for (const token of effortTokens) cores.push(`${base}-thinking-${token}`);
    // Suffix: base-<effort>-thinking
    for (const token of effortTokens) cores.push(`${base}-${token}-thinking`);
    // Thinking without effort: base-thinking
    cores.push(`${base}-thinking`);
  }
  for (const token of effortTokens) cores.push(`${base}-${token}`);
  cores.push(base);

  const out: string[] = [];
  for (const core of cores) {
    if (fast) out.push(`${core}-fast`);
    out.push(core);
  }
  if (fast) out.push(`${base}-fast`);
  out.push(base);
  return out;
}

function pickCursorSlug(
  base: string,
  options?: { reasoningEffort?: ReasoningEffort; fast?: boolean; thinking?: boolean },
  live?: Set<string>
): string {
  const fast = options?.fast === true;
  const thinking = options?.thinking === true;
  let effort = options?.reasoningEffort;

  // Bare base (e.g. gpt-5.6-sol) is often not a valid CLI id — default to medium when live set known.
  if (!effort && live && live.size && !live.has(base) && !live.has(`${base}-fast`)) {
    const fallbacks: ReasoningEffort[] = ["medium", "high", "low", "xhigh", "max"];
    for (const candidate of fallbacks) {
      const token = reasoningToEffortToken(candidate);
      const probes = thinking
        ? [`${base}-thinking-${token}`, `${base}-${token}-thinking`]
        : [`${base}-${token}`, candidate === "xhigh" ? `${base}-extra-high` : ""];
      if (probes.some((slug) => slug && (live.has(slug) || live.has(`${slug}-fast`)))) {
        effort = candidate;
        break;
      }
    }
  }

  const candidates = cursorSlugCandidates(base, effort, thinking, fast);
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
    // Fallback: scan live set for a slug matching base + effort + thinking (+fast when possible).
    const want = effort ? reasoningToEffortToken(effort) : undefined;
    let fastMatch = "";
    let anyMatch = "";
    for (const slug of live) {
      const parts = splitCursorSlug(slug);
      if (parts.base !== base) continue;
      if (parts.thinking !== thinking) continue;
      const effortOk = !want
        ? true
        : parts.effortToken === want || (want === "xhigh" && parts.effortToken === "extra-high");
      if (!effortOk) continue;
      if (parts.fast === fast && !fastMatch) fastMatch = slug;
      if (!anyMatch) anyMatch = slug;
    }
    if (fastMatch) return fastMatch;
    if (anyMatch) return anyMatch;
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
  thinking?: boolean;
} {
  const raw = (model || "").trim();
  if (!raw) return { base: "composer-2.5" };
  const bracket = raw.match(/^([^[\]]+)\[([^\]]+)\]\s*$/);
  if (bracket) {
    const base = normalizeCursorBaseId((bracket[1] || "").trim() || "composer-2.5");
    // Auto never takes effort/fast params.
    if (base === "auto") return { base: "auto" };
    let fast: boolean | undefined;
    let reasoningEffort: ReasoningEffort | undefined;
    let thinking: boolean | undefined;
    for (const part of (bracket[2] || "").split(",")) {
      const [k, v] = part.split("=").map((s) => s.trim());
      if (!k) continue;
      if (k === "fast") fast = v === "true" || v === "1";
      if (k === "thinking") thinking = v === "true" || v === "1";
      if (k === "effort") {
        const mapped = v === "extra_high" || v === "extra-high" ? "xhigh" : v;
        if (mapped === "low" || mapped === "medium" || mapped === "high" || mapped === "xhigh" || mapped === "max") {
          reasoningEffort = mapped;
        }
      }
    }
    return {
      base,
      ...(fast !== undefined ? { fast } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(thinking !== undefined ? { thinking } : {})
    };
  }

  // Already a live slug like gpt-5.6-sol-medium-fast / claude-opus-5-thinking-high
  const looksLikeSlug = !raw.includes("[")
    && (raw.includes("-fast") || raw.includes("-thinking") || CURSOR_EFFORT_TOKENS.some((t) => raw.endsWith(`-${t}`)));
  if (looksLikeSlug) {
    const parts = splitCursorSlug(raw);
    const base = normalizeCursorBaseId(parts.base);
    if (base === "auto") return { base: "auto" };
    const effort = effortTokenToReasoning(parts.effortToken);
    return {
      base,
      fast: Boolean(parts.fast),
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(parts.thinking ? { thinking: true } : {})
    };
  }

  return { base: normalizeCursorBaseId(raw) };
}

async function discoverCursorCapability(): Promise<EngineCapability> {
  const models: EngineModelOption[] = [];
  const seen = new Set<string>();
  let liveCount = 0;
  cursorLiveSlugSet = new Set();
  let currentModel: string | undefined;
  let currentReasoningEffort: ReasoningEffort | undefined;
  let currentThinking: boolean | undefined;

  try {
    const { resolveEngineBinary } = await import("./detect");
    const binary = await resolveEngineBinary("cursor");
    if (binary) {
      const raw = await runCursorModelsList(binary);
      if (raw) {
        const ids = extractCursorModelIds(raw);
        for (const id of ids) {
          const normalized = /^auto$/i.test(id) ? "auto" : id;
          cursorLiveSlugSet.add(normalized);
        }
        liveCount = cursorLiveSlugSet.size;
        const families = groupCursorLiveSlugs([...cursorLiveSlugSet]);
        for (const family of families) {
          if (seen.has(family.base)) continue;
          seen.add(family.base);
          models.push({
            id: family.base,
            label: family.label,
            ...(family.supportsFast ? { supportsFast: true } : {}),
            ...(family.reasoningEfforts.length ? { reasoningEfforts: family.reasoningEfforts } : {}),
            ...(family.supportsThinking ? { supportsThinking: true } : {}),
            ...(family.thinkingEfforts.length ? { thinkingEfforts: family.thinkingEfforts } : {})
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
      if (row.supportsThinking && existing.supportsThinking === undefined) existing.supportsThinking = true;
      if (row.thinkingEfforts?.length && !existing.thinkingEfforts?.length) {
        existing.thinkingEfforts = row.thinkingEfforts;
      }
      if (row.label && existing.label === existing.id) existing.label = row.label;
    }
  }

  // Sync selected model / effort from Cursor CLI config (updated by account / UI switches).
  try {
    const cliRaw = await readText(path.join(os.homedir(), ".cursor", "cli-config.json"));
    if (cliRaw) {
      const cli = JSON.parse(cliRaw) as {
        selectedModel?: { modelId?: string; parameters?: Array<{ id?: string; value?: string }> };
        model?: { modelId?: string; displayModelId?: string };
        modelParameters?: Record<string, Array<{ id?: string; value?: string }>>;
      };
      const selectedId = String(
        cli.selectedModel?.modelId
        || cli.model?.displayModelId
        || cli.model?.modelId
        || ""
      ).trim();
      if (selectedId && !/^default$/i.test(selectedId)) {
        if (/^auto$/i.test(selectedId)) {
          currentModel = "auto";
        } else {
          // selectedId may be a full slug (claude-opus-5-thinking-high) — split to base + thinking + effort.
          const ref = parseCursorModelRef(selectedId);
          currentModel = normalizeCursorBaseId(ref.base);
          if (ref.thinking) currentThinking = true;
          if (!currentReasoningEffort && ref.reasoningEffort) currentReasoningEffort = ref.reasoningEffort;
        }
      } else if (/^auto$/i.test(String(cli.model?.displayModelId || ""))) {
        currentModel = "auto";
      }
      const paramKey = selectedId && !/^default$/i.test(selectedId) ? selectedId : (currentModel || "");
      const params = [
        ...(cli.selectedModel?.parameters || []),
        ...((paramKey && cli.modelParameters?.[paramKey]) || [])
      ];
      for (const param of params) {
        if (!/reasoning|effort/i.test(String(param.id || ""))) continue;
        const effort = normalizeEffort(String(param.value || ""));
        if (effort) {
          currentReasoningEffort = effort;
          break;
        }
      }
    }
  } catch {
    // ignore
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
  currentModel = envBase
    || currentModel
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
    currentModel,
    ...(currentReasoningEffort ? { currentReasoningEffort } : {}),
    ...(currentThinking ? { currentThinking: true } : {})
  };
}

const AGY_EFFORTS: Array<"low" | "medium" | "high"> = ["low", "medium", "high"];

const ANTIGRAVITY_FALLBACK_MODELS: EngineModelOption[] = [
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", reasoningEfforts: ["low", "medium", "high"] },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", reasoningEfforts: ["low", "medium", "high"] },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", reasoningEfforts: ["low", "medium", "high"] },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", reasoningEfforts: ["low", "high"] },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b", label: "GPT-OSS 120B", reasoningEfforts: ["medium"] }
];

/** Label/id → family id, filled by the last `agy models` discovery. */
const agyLabelToFamily = new Map<string, string>();
const agyFamilyEfforts = new Map<string, Array<"low" | "medium" | "high">>();
/** Exact CLI `--model` ids from the last `agy models` probe (e.g. gemini-3.7-flash-high). */
const agyLiveModelSlugs = new Set<string>();

function rememberAgyCatalog(models: EngineModelOption[], liveSlugs: string[] = []): void {
  agyLabelToFamily.clear();
  agyFamilyEfforts.clear();
  agyLiveModelSlugs.clear();
  for (const slug of liveSlugs) {
    const id = String(slug || "").trim();
    if (id) agyLiveModelSlugs.add(id.toLowerCase());
  }
  for (const model of models) {
    agyLabelToFamily.set(model.id.toLowerCase(), model.id);
    agyLabelToFamily.set(model.label.toLowerCase(), model.id);
    const efforts = (model.reasoningEfforts || []).filter((item): item is "low" | "medium" | "high" => (
      item === "low" || item === "medium" || item === "high"
    ));
    if (efforts.length) {
      agyFamilyEfforts.set(model.id, efforts);
      for (const effort of efforts) {
        const combined = `${model.id}-${effort}`;
        agyLabelToFamily.set(combined.toLowerCase(), model.id);
        agyLabelToFamily.set(`${model.label} (${effort})`.toLowerCase(), model.id);
        // Fallback catalog has no live probe — still treat combined ids as valid spawn slugs.
        if (!liveSlugs.length) agyLiveModelSlugs.add(combined.toLowerCase());
      }
    } else if (!liveSlugs.length) {
      agyLiveModelSlugs.add(model.id.toLowerCase());
    }
  }
}
rememberAgyCatalog(ANTIGRAVITY_FALLBACK_MODELS);

export function splitAgyEffortSuffix(id: string): { base: string; effort?: "low" | "medium" | "high" } {
  const trimmed = id.trim();
  const match = trimmed.match(/^(.*)-(low|medium|high)$/i);
  if (!match?.[1] || !match[2]) return { base: trimmed };
  return { base: match[1], effort: match[2].toLowerCase() as "low" | "medium" | "high" };
}

function parseAgyDisplayName(raw: string): { label: string; effort?: "low" | "medium" | "high" } {
  const match = raw.trim().match(/^(.*?)\s*\((low|medium|high)\)$/i);
  if (match?.[1] && match[2]) {
    return { label: match[1].trim(), effort: match[2].toLowerCase() as "low" | "medium" | "high" };
  }
  return { label: raw.trim() };
}

function mapAgyEffortValue(effort?: ReasoningEffort | string | null): "low" | "medium" | "high" | undefined {
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "xhigh" || effort === "max") return "high";
  return undefined;
}

/**
 * Build agy spawn model args.
 *
 * Current Antigravity CLI publishes combined slugs (`gemini-3.7-flash-high`,
 * `gpt-oss-120b-medium`). Passing `--model gemini-3.7-flash --effort high` fails with
 * "effort is not supported" and the session silently keeps the previous model (e.g. Claude),
 * which is exactly how a UI switch to Flash still burns Claude quota.
 *
 * Always prefer a single `--model <slug>`; only emit separate `--effort` for true legacy CLIs
 * that list the bare family id and accept the flag.
 */
export function formatAgySpawnArgs(
  model?: string,
  effort?: ReasoningEffort
): { model?: string; effort?: "low" | "medium" | "high" } {
  let raw = (model || "").trim();
  let fromName: "low" | "medium" | "high" | undefined;
  if (raw && /\s/.test(raw)) {
    const display = parseAgyDisplayName(raw);
    fromName = display.effort;
    raw = agyLabelToFamily.get(raw.toLowerCase())
      || agyLabelToFamily.get(display.label.toLowerCase())
      || "";
  } else if (raw) {
    // Keep a full live slug if the user/UI already sent one (gemini-3.7-flash-high).
    if (agyLiveModelSlugs.has(raw.toLowerCase())) {
      return { model: raw };
    }
    const split = splitAgyEffortSuffix(raw);
    fromName = split.effort;
    raw = agyLabelToFamily.get(raw.toLowerCase())
      || agyLabelToFamily.get(split.base.toLowerCase())
      || split.base;
  }
  const split = raw ? splitAgyEffortSuffix(raw) : { base: "" };
  const base = split.base;
  if (!base) return {};

  const familyEfforts = agyFamilyEfforts.get(base);
  const chosen = mapAgyEffortValue(effort) || fromName || split.effort
    || (familyEfforts?.length ? familyEfforts[0] : undefined);
  const combined = chosen ? `${base}-${chosen}` : "";

  // Current CLI: combined slug is the real --model id.
  if (combined && agyLiveModelSlugs.has(combined.toLowerCase())) {
    return { model: combined };
  }
  if (agyLiveModelSlugs.has(base.toLowerCase())) {
    // Bare id is live (claude-opus-4-6-thinking) — never attach --effort.
    // Legacy only: bare family listed AND combined missing AND family has efforts.
    if (
      chosen
      && familyEfforts?.includes(chosen)
      && !agyLiveModelSlugs.has((combined || "").toLowerCase())
      && !/-thinking$/i.test(base)
    ) {
      // If the live set contains only the bare family (unusual), keep legacy --effort.
      const hasAnyCombinedLive = [...agyLiveModelSlugs].some((slug) => slug.startsWith(`${base.toLowerCase()}-`));
      if (!hasAnyCombinedLive) return { model: base, effort: chosen };
    }
    return { model: base };
  }

  // No live probe / unknown catalog: prefer combined when UI has an effort dimension.
  if (combined && familyEfforts?.length) return { model: combined };
  return { model: base };
}

function parseAgyModelsOutput(raw: string): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/^[-*•]\s*/, "").trim();
    if (!trimmed) continue;
    if (/^fetching\b|^available models|^usage\b|^error:/i.test(trimmed)) continue;
    const m = trimmed.match(/^([a-z0-9][\w./+-]*)\s{1,}(.+)$/i)
      || trimmed.match(/^([a-z0-9][\w./+-]+)\s*$/i);
    if (!m?.[1]) continue;
    const id = m[1].trim();
    if (!id || seen.has(id) || id.includes(" ")) continue;
    seen.add(id);
    out.push({ id, label: (m[2] || id).trim() || id });
  }
  return out;
}

function ingestAgyModelRow(
  id: string,
  label: string,
  models: EngineModelOption[],
  seen: Set<string>
): void {
  const split = splitAgyEffortSuffix(id);
  const display = parseAgyDisplayName(label);
  const familyId = split.effort ? split.base : id;
  const familyLabel = display.effort ? display.label : (label || familyId);
  let row = models.find((item) => item.id === familyId);
  if (!row) {
    if (seen.has(familyId)) return;
    seen.add(familyId);
    row = { id: familyId, label: familyLabel };
    models.push(row);
  }
  const effort = split.effort || display.effort;
  if (!effort) return;
  const list = row.reasoningEfforts ? [...row.reasoningEfforts] : [];
  if (!list.includes(effort)) list.push(effort);
  row.reasoningEfforts = AGY_EFFORTS.filter((item) => list.includes(item));
}

async function runAgyModelsList(command: string): Promise<string | null> {
  try {
    const { cloudProxyChildEnv } = await import("../local-proxy");
    const { execFileWithTreeKill } = await import("./exec-file-tree-kill");
    const env = await cloudProxyChildEnv();
    // Important on Windows: do not leave orphan `agy models` after timeout.
    // Spawning via cmd.exe + execFile kill only ends cmd and used to leave dozens of hung agy.exe.
    const { stdout, stderr } = await execFileWithTreeKill(command, ["models"], {
      timeoutMs: 15_000,
      env,
      maxBuffer: 512_000
    });
    const text = `${stdout || ""}\n${stderr || ""}`.trim();
    if (text && !/unknown command|unrecognized|error:/i.test(text.slice(0, 200))) return text;
  } catch {
    // ignore (including timeout)
  }
  return null;
}

async function discoverAntigravityCapability(): Promise<EngineCapability> {
  const models: EngineModelOption[] = [];
  const seen = new Set<string>();
  let currentModel: string | undefined;
  let currentReasoningEffort: ReasoningEffort | undefined;

  try {
    const { resolveEngineBinary } = await import("./detect");
    const binary = await resolveEngineBinary("antigravity");
    if (binary) {
      const raw = await runAgyModelsList(binary);
      if (raw) {
        const parsed = parseAgyModelsOutput(raw);
        for (const item of parsed) {
          ingestAgyModelRow(item.id, item.label, models, seen);
        }
        rememberAgyCatalog(models, parsed.map((item) => item.id));
      }
    }
  } catch {
    // ignore
  }

  if (!models.length) {
    for (const item of ANTIGRAVITY_FALLBACK_MODELS) {
      models.push({
        id: item.id,
        label: item.label,
        ...(item.reasoningEfforts ? { reasoningEfforts: [...item.reasoningEfforts] } : {})
      });
      seen.add(item.id);
    }
    rememberAgyCatalog(models);
  }

  const settingsRaw = await readText(path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"));
  let settingsLabel = "";
  if (settingsRaw) {
    try {
      const settings = JSON.parse(settingsRaw) as { model?: string };
      settingsLabel = String(settings.model || "").trim();
    } catch {
      // ignore
    }
  }
  if (settingsLabel) {
    const display = parseAgyDisplayName(settingsLabel);
    const family = agyLabelToFamily.get(settingsLabel.toLowerCase())
      || agyLabelToFamily.get(display.label.toLowerCase())
      || models.find((item) => item.label.toLowerCase() === display.label.toLowerCase())?.id
      || models.find((item) => item.id.toLowerCase() === settingsLabel.toLowerCase())?.id;
    if (family) {
      currentModel = family;
      const allowed = agyFamilyEfforts.get(family) || [];
      currentReasoningEffort = display.effort && allowed.includes(display.effort)
        ? display.effort
        : allowed[0];
    }
  }

  const effortUnion = new Set<ReasoningEffort>();
  for (const model of models) {
    for (const effort of model.reasoningEfforts || []) effortUnion.add(effort);
  }
  const reasoningEfforts = AGY_EFFORTS.filter((item) => effortUnion.has(item));

  return {
    engine: "antigravity",
    models,
    reasoningEfforts,
    ...(currentModel ? { currentModel } : {}),
    ...(currentReasoningEffort ? { currentReasoningEffort } : {})
  };
}

/**
 * Build Cursor CLI `--model` slug from base id + effort + optional fast flag.
 * Emits `gpt-5.6-sol-medium-fast`, never legacy `gpt-5.6-sol[fast=true]`.
 */
export function formatCursorModelArg(
  model: string | undefined,
  options?: { reasoningEffort?: ReasoningEffort; fast?: boolean; thinking?: boolean }
): string {
  const parsed = parseCursorModelRef(model);
  // Auto is a bare CLI id — never append effort/fast (would become Auto-xhigh).
  if (isCursorAutoModel(parsed.base) || isCursorAutoModel(model)) return "auto";

  const fast = options?.fast ?? parsed.fast;
  const reasoningEffort = options?.reasoningEffort ?? parsed.reasoningEffort;
  const thinking = options?.thinking ?? parsed.thinking;

  return pickCursorSlug(
    normalizeCursorBaseId(parsed.base),
    {
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(fast !== undefined ? { fast } : {}),
      ...(thinking !== undefined ? { thinking } : {})
    },
    cursorLiveSlugSet.size ? cursorLiveSlugSet : undefined
  );
}

/** Collect model + effort options from local CLI configs/caches on this machine. */
export async function discoverEngineCapabilities(): Promise<EngineCapability[]> {
  const [codex, claude, grok, cursor, antigravity] = await Promise.all([
    discoverCodexCapability(),
    discoverClaudeCapability(),
    discoverGrokCapability(),
    discoverCursorCapability(),
    discoverAntigravityCapability()
  ]);
  return [codex, claude, grok, cursor, antigravity];
}
