import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliEngine, ReasoningEffort } from "@anytimevibe/protocol";

export type EngineModelOption = {
  id: string;
  label: string;
  contextWindow?: number;
};

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

/** Collect model + effort options from local CLI configs/caches on this machine. */
export async function discoverEngineCapabilities(): Promise<EngineCapability[]> {
  const [codex, claude, grok] = await Promise.all([
    discoverCodexCapability(),
    discoverClaudeCapability(),
    discoverGrokCapability()
  ]);
  return [codex, claude, grok];
}
