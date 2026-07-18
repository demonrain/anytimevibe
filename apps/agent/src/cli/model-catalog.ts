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
 * IDs are CLI `--model` slugs; Fast/effort are composed as `id[fast=…,effort=…]` at spawn time.
 * Prefer live `agent models` / `--list-models` when the binary is installed.
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
    id: "claude-fable-5",
    label: "Claude Fable 5",
    reasoningEfforts: ["low", "medium", "high", "xhigh"]
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    supportsFast: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"]
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    supportsFast: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"]
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    supportsFast: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"]
  },
  { id: "grok-4.5", label: "Grok 4.5" },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    supportsFast: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"]
  }
];

function looksLikeCursorModelLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 120) return false;
  if (/^(Available|Models|NAME|ID|Usage|\$|──|==)/i.test(t)) return false;
  // Skip Grok Build help noise if wrong binary ever leaks in.
  if (/grok\s+build|Grok Build/i.test(t)) return false;
  return true;
}

function parseCursorModelsCliOutput(raw: string): EngineModelOption[] {
  const models: EngineModelOption[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!looksLikeCursorModelLine(line)) continue;
    // Formats seen: "composer-2.5", "composer-2.5  Composer 2.5", "- composer-2.5 (Composer 2.5)"
    const cleaned = line.replace(/^[-*•]\s*/, "").trim();
    const m =
      cleaned.match(/^([a-z0-9][\w./+-]*(?:\[[^\]]+\])?)\s{2,}(.+)$/i)
      || cleaned.match(/^([a-z0-9][\w./+-]*)\s+\(([^)]+)\)\s*$/i)
      || cleaned.match(/^([a-z0-9][\w./+-]+)\s*$/i);
    if (!m?.[1]) continue;
    const id = m[1].trim();
    if (!id || seen.has(id) || id.includes(" ")) continue;
    // Drop param-only variants from listing; we compose params ourselves.
    if (id.includes("[")) continue;
    seen.add(id);
    const label = (m[2] || id).trim();
    const lower = `${id} ${label}`.toLowerCase();
    const supportsFast =
      /composer|opus|sonnet|gpt|gemini/i.test(lower) && !/auto|grok/i.test(id);
    const reasoningEfforts: ReasoningEffort[] | undefined =
      /gpt|opus|fable|sonnet|claude/i.test(lower) && !/composer|auto|grok/i.test(id)
        ? ["low", "medium", "high", "xhigh"]
        : undefined;
    models.push({
      id,
      label,
      ...(supportsFast ? { supportsFast: true } : {}),
      ...(reasoningEfforts ? { reasoningEfforts } : {})
    });
  }
  return models;
}

async function runCursorModelsList(command: string): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const isWindows = process.platform === "win32";
    const { windowsCmdArguments } = await import("../windows-command");
    const attempts: string[][] = [["models"], ["--list-models"], ["models", "--json"]];
    for (const args of attempts) {
      try {
        const executable = isWindows ? process.env.ComSpec ?? "cmd.exe" : command;
        const finalArgs = isWindows ? windowsCmdArguments(command, args) : args;
        const { stdout, stderr } = await execFileAsync(executable, finalArgs, {
          timeout: 20_000,
          windowsHide: true,
          windowsVerbatimArguments: isWindows,
          env: process.env,
          maxBuffer: 512_000
        });
        const text = `${stdout || ""}\n${stderr || ""}`.trim();
        if (text && !/unknown command|unrecognized|error:/i.test(text.slice(0, 200))) {
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

async function discoverCursorCapability(): Promise<EngineCapability> {
  const models: EngineModelOption[] = [];
  const seen = new Set<string>();

  // Live list from Cursor Agent CLI when installed (never Grok's `agent`).
  try {
    const { resolveEngineBinary } = await import("./detect");
    const binary = await resolveEngineBinary("cursor");
    if (binary) {
      const raw = await runCursorModelsList(binary);
      if (raw) {
        for (const row of parseCursorModelsCliOutput(raw)) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          models.push(row);
        }
      }
    }
  } catch {
    // fall through to static catalog
  }

  // Ensure curated first-party / popular models exist even if CLI list is sparse.
  for (const row of CURSOR_FALLBACK_MODELS) {
    if (seen.has(row.id)) {
      // Merge metadata onto live row when CLI omitted flags.
      const existing = models.find((m) => m.id === row.id);
      if (existing) {
        if (row.supportsFast && existing.supportsFast === undefined) existing.supportsFast = true;
        if (row.reasoningEfforts?.length && !existing.reasoningEfforts?.length) {
          existing.reasoningEfforts = row.reasoningEfforts;
        }
        if (row.label && existing.label === existing.id) existing.label = row.label;
      }
      continue;
    }
    seen.add(row.id);
    models.push({ ...row });
  }

  // Prefer Composer 2.5 first in the picker (after optional Auto).
  models.sort((a, b) => {
    const rank = (id: string) => {
      if (id === "composer-2.5") return 0;
      if (id === "auto") return 1;
      if (id.startsWith("claude-opus")) return 2;
      if (id.includes("fable")) return 3;
      if (id.startsWith("gpt-")) return 4;
      if (id.startsWith("grok")) return 5;
      return 10;
    };
    return rank(a.id) - rank(b.id) || a.label.localeCompare(b.label);
  });

  const envModel = process.env.CURSOR_MODEL?.trim();
  const currentModel = envModel || "composer-2.5";
  if (currentModel && !seen.has(currentModel.split("[")[0]!)) {
    models.unshift({ id: currentModel, label: currentModel });
  }

  // Engine-level efforts are a union used as fallback when a model has none.
  const reasoningEfforts: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

  return {
    engine: "cursor",
    models,
    reasoningEfforts,
    currentModel
  };
}

/**
 * Build Cursor CLI `--model` value from base id + effort + optional fast flag.
 * Docs/community use forms like `composer-2.5[fast=false]` and effort-bearing GPT names.
 */
export function formatCursorModelArg(
  model: string | undefined,
  options?: { reasoningEffort?: ReasoningEffort; fast?: boolean }
): string {
  const raw = (model || process.env.CURSOR_MODEL || "composer-2.5").trim() || "composer-2.5";
  // Already parameterized by web/UI — pass through.
  if (raw.includes("[")) return raw;
  if (raw === "auto") return "auto";

  const base = raw;
  const params: string[] = [];
  const lower = base.toLowerCase();
  const catalog = CURSOR_FALLBACK_MODELS.find((m) => m.id === base);
  const supportsFast = catalog?.supportsFast ?? /composer|opus|sonnet|gpt/i.test(lower);
  const supportsEffort =
    Boolean(catalog?.reasoningEfforts?.length)
    || /gpt|opus|fable|sonnet|claude/i.test(lower);

  if (supportsFast && options?.fast !== undefined) {
    params.push(`fast=${options.fast ? "true" : "false"}`);
  }

  if (supportsEffort && options?.reasoningEffort) {
    const effortMap: Record<ReasoningEffort, string> = {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "extra_high",
      max: "extra_high"
    };
    params.push(`effort=${effortMap[options.reasoningEffort]}`);
  }

  if (!params.length) return base;
  return `${base}[${params.join(",")}]`;
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
