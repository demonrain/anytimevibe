import { createConnection } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseTomlString(text: string, key: string): string | undefined {
  const re = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]*)"`, "i");
  const match = text.match(re);
  return match?.[1]?.trim() || undefined;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}

const BUILTIN_CODEX_PROVIDERS = new Set(["openai"]);

function codexHomeDir(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

function hasModelProviderSection(text: string, provider: string): boolean {
  const sectionRe = new RegExp(
    `\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`,
    "i"
  );
  return sectionRe.test(text);
}

function listCustomModelProviders(text: string): string[] {
  const names: string[] = [];
  const re = /\[model_providers\.([^\]]+)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = match[1]?.trim();
    if (name) names.push(name);
  }
  return names;
}

/** Read active model_provider base_url from ~/.codex/config.toml (no secrets). */
export async function resolveCodexProviderBaseUrl(): Promise<{
  provider: string;
  baseUrl: string;
} | null> {
  let text = "";
  try {
    text = await fs.readFile(path.join(codexHomeDir(), "config.toml"), "utf8");
  } catch {
    return null;
  }
  const provider = parseTomlString(text, "model_provider");
  if (!provider) return null;

  const sectionRe = new RegExp(
    `\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]([\\s\\S]*?)(?=\\n\\[|$)`,
    "i"
  );
  const section = text.match(sectionRe)?.[1] ?? "";
  const baseUrl =
    parseTomlString(section, "base_url") ||
    parseTomlString(text, "openai_base_url") ||
    parseTomlString(text, "base_url");
  if (!baseUrl) return null;
  return { provider, baseUrl };
}

function resolveFallbackProviderBaseUrl(text: string): string {
  const customs = listCustomModelProviders(text);
  for (const name of customs) {
    if (name.toLowerCase() === "codex_local_access") continue;
    const sectionRe = new RegExp(
      `\\[model_providers\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]([\\s\\S]*?)(?=\\n\\[|$)`,
      "i"
    );
    const section = text.match(sectionRe)?.[1] ?? "";
    const baseUrl = parseTomlString(section, "base_url");
    if (baseUrl) return baseUrl;
  }
  return parseTomlString(text, "openai_base_url") || parseTomlString(text, "base_url") || "http://localhost:3333/v1";
}

function ensureProviderSection(text: string, provider: string, baseUrl: string): string {
  if (hasModelProviderSection(text, provider)) return text;
  const block = [
    "",
    `[model_providers.${provider}]`,
    `name = "${provider}"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "responses"`,
    "requires_openai_auth = true",
    ""
  ].join("\n");
  const insertAt = text.search(/\n\[(?!model_providers\.)/);
  return insertAt >= 0
    ? `${text.slice(0, insertAt)}\n${block}${text.slice(insertAt + 1)}`
    : `${text.trimEnd()}\n${block}`;
}

/**
 * Cockpit Local Access often sets `model_provider = "codex_local_access"` then later
 * strips `[model_providers.codex_local_access]`. Old threads still store that provider
 * name, so thread/resume and CLI handoff fail with:
 *   failed to load configuration: Model provider `codex_local_access` not found
 *
 * Repair only touches ~/.codex/config.toml. Never starts, stops, or rewrites Cockpit
 * sidecar / cliproxy processes.
 */
export async function repairCodexModelProviderConfig(): Promise<{
  repaired: boolean;
  detail: string;
}> {
  const configPath = path.join(codexHomeDir(), "config.toml");
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    return { repaired: false, detail: "config.toml missing" };
  }

  const details: string[] = [];
  let next = text;
  const fallbackBaseUrl = resolveFallbackProviderBaseUrl(next);

  // Historical threads created under Cockpit Local Access still reference this provider.
  if (!hasModelProviderSection(next, "codex_local_access")) {
    next = ensureProviderSection(next, "codex_local_access", fallbackBaseUrl);
    details.push(`ensured [model_providers.codex_local_access] base_url=${fallbackBaseUrl}`);
  }

  const provider = parseTomlString(next, "model_provider");
  if (!provider) {
    if (next === text) return { repaired: false, detail: "model_provider unset" };
    await fs.writeFile(configPath, next, "utf8");
    return { repaired: true, detail: details.join("; ") };
  }

  if (!BUILTIN_CODEX_PROVIDERS.has(provider) && !hasModelProviderSection(next, provider)) {
    const customs = listCustomModelProviders(next);
    const fallback =
      customs.find((name) => name.toLowerCase() === "custom") ||
      customs.find((name) => name.toLowerCase() !== "codex_local_access") ||
      customs[0];

    if (fallback && fallback !== provider) {
      const rewritten = next.replace(
        /(?:^|\n)\s*model_provider\s*=\s*"[^"]*"/i,
        (m) => m.replace(/=\s*"[^"]*"/, `= "${fallback}"`)
      );
      if (rewritten !== next) {
        next = rewritten;
        details.push(`model_provider ${provider} missing section → switched to ${fallback}`);
      }
    } else {
      next = ensureProviderSection(next, provider, fallbackBaseUrl);
      details.push(`recreated [model_providers.${provider}] base_url=${fallbackBaseUrl}`);
    }
  }

  if (next === text) {
    return { repaired: false, detail: details[0] || `provider ${provider} ok` };
  }
  await fs.writeFile(configPath, next, "utf8");
  return { repaired: true, detail: details.join("; ") };
}

function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Read-only preflight: if Codex points at a loopback gateway, verify the port is listening.
 * Does not modify Cockpit sidecar config, and never kills/restarts cockpit-cliproxy.
 */
export async function assertCodexLocalGatewayReady(): Promise<void> {
  await repairCodexModelProviderConfig();

  const resolved = await resolveCodexProviderBaseUrl();
  if (!resolved) return;
  let url: URL;
  try {
    url = new URL(resolved.baseUrl);
  } catch {
    return;
  }
  if (!isLoopbackHost(url.hostname)) return;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isFinite(port) || port <= 0) return;
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;

  const ok = await probeTcp(host, port, 1_500);
  if (ok) return;
  throw new Error(
    [
      `本机 Codex 网关不可达：${url.origin}（model_provider=${resolved.provider}）。`,
      "当前 ~/.codex/config.toml 指向本机网关，但端口未监听。",
      "请在 Cockpit Tools 自行启动 / 修复 Local Access（API 服务），或把 model_provider 改成可直连供应商后重试。",
      "随码客户端不会改写、重启或强杀 Cockpit 相关进程。"
    ].join("\n")
  );
}
