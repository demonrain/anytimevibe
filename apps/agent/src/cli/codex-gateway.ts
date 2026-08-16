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

/** Read openai_base_url (or active relay base) for Codex child env OPENAI_BASE_URL. */
export async function resolveCodexOpenaiBaseUrlForEnv(): Promise<string | null> {
  let text = "";
  try {
    text = await fs.readFile(path.join(codexHomeDir(), "config.toml"), "utf8");
  } catch {
    return null;
  }
  text = repairGluedOpenaiBaseUrlLine(text);
  const top = parseTomlString(text, "openai_base_url");
  if (top && !isOpenaiApiHost(top)) return toOpenaiStyleBaseUrl(top);
  const resolved = await resolveCodexProviderBaseUrl();
  if (!resolved?.baseUrl || isOpenaiApiHost(resolved.baseUrl)) return null;
  if (BUILTIN_CODEX_PROVIDERS.has(resolved.provider)) return null;
  return toOpenaiStyleBaseUrl(resolved.baseUrl);
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
  text = repairGluedOpenaiBaseUrlLine(text);
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
  // Custom / relay gateways authenticate with experimental_bearer_token (or API key),
  // not ChatGPT OAuth. Defaulting requires_openai_auth=true forces auth_mode=Chatgpt and
  // then fails with "refresh token was revoked" even when base_url points at a mid-proxy.
  let requiresOpenaiAuth = false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    requiresOpenaiAuth = host === "api.openai.com" || host.endsWith(".openai.com");
  } catch {
    requiresOpenaiAuth = false;
  }
  const block = [
    "",
    `[model_providers.${provider}]`,
    `name = "${provider}"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "responses"`,
    `requires_openai_auth = ${requiresOpenaiAuth}`,
    ""
  ].join("\n");
  const insertAt = text.search(/\n\[(?!model_providers\.)/);
  return insertAt >= 0
    ? `${text.slice(0, insertAt)}\n${block}${text.slice(insertAt + 1)}`
    : `${text.trimEnd()}\n${block}`;
}

/**
 * When a provider points at a non-OpenAI base_url but still requires_openai_auth,
 * Codex ignores the relay and refreshes ChatGPT OAuth — flip the flag so mid-proxy works.
 * CCSwitch / Cockpit third-party profiles often ship with requires_openai_auth=true by mistake.
 */
function relaxRelayOpenaiAuth(text: string): { text: string; changed: string[] } {
  const changed: string[] = [];
  const next = text.replace(
    /\[model_providers\.([^\]]+)\]([^\[]*)/gi,
    (full, provider: string, body: string) => {
      const baseUrl = parseTomlString(body, "base_url") || "";
      const requires = /^\s*requires_openai_auth\s*=\s*true\s*$/im.test(body);
      if (!requires || !baseUrl) return full;
      let host = "";
      try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { /* ignore */ }
      if (!host || host === "api.openai.com" || host.endsWith(".openai.com")) return full;
      const patched = body.replace(
        /^(\s*requires_openai_auth\s*=\s*)true(\s*)$/im,
        "$1false$2"
      );
      if (patched === body) return full;
      changed.push(provider);
      return `[model_providers.${provider}]${patched}`;
    }
  );
  return { text: next, changed };
}

/** Built-in `openai` provider expects a `/v1` base (…/v1/responses). */
function toOpenaiStyleBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  if (/\/v1$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

function isOpenaiApiHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com" || host.endsWith(".openai.com");
  } catch {
    return false;
  }
}

function upsertTopLevelTomlString(text: string, key: string, value: string): string {
  const re = new RegExp(`((?:^|\\n)\\s*${key}\\s*=\\s*)"[^"]*"`, "i");
  if (re.test(text)) return text.replace(re, `$1"${value}"`);
  // Insert on its own line after model_provider. Do NOT let \s* eat the following
  // newline — that previously produced: openai_base_url = "…"model = "…"
  const providerLine = text.match(/(?:^|\n)\s*model_provider\s*=\s*"[^"]*"/i);
  if (providerLine && providerLine.index != null) {
    const at = providerLine.index + providerLine[0].length;
    return `${text.slice(0, at)}\n${key} = "${value}"${text.slice(at)}`;
  }
  return `${key} = "${value}"\n${text}`;
}

/** Normalize a previously corrupted `openai_base_url = "…"model =` glue on the SAME line. */
function repairGluedOpenaiBaseUrlLine(text: string): string {
  // Only match horizontal whitespace — never cross newlines, or a healthy
  //   openai_base_url = "…"
  //   model = "…"
  // pair is treated as glued forever (write → watch → reload loop).
  return text.replace(
    /^(\s*openai_base_url\s*=\s*"[^"]+")([^\S\r\n]+)(model\s*=)/gim,
    "$1\n$3"
  );
}

function upsertProviderBearer(text: string, provider: string, apiKey: string): { text: string; changed: boolean } {
  const sectionRe = new RegExp(
    `(\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\])([^\\[]*)`,
    "i"
  );
  const match = text.match(sectionRe);
  if (!match) return { text, changed: false };
  const head = match[1];
  const body = match[2] ?? "";
  const existing = parseTomlString(body, "experimental_bearer_token")?.trim() || "";
  if (existing === apiKey) return { text, changed: false };
  let nextBody: string;
  if (/^\s*experimental_bearer_token\s*=/im.test(body)) {
    nextBody = body.replace(
      /^(\s*experimental_bearer_token\s*=\s*)"[^"]*"/im,
      `$1"${apiKey}"`
    );
  } else {
    const insert = `experimental_bearer_token = "${apiKey}"\n`;
    nextBody = /^\s*\n/.test(body) ? `\n${insert}${body.replace(/^\s*\n/, "")}` : `\n${insert}${body}`;
  }
  return {
    text: text.replace(sectionRe, `${head}${nextBody}`),
    changed: true
  };
}

/**
 * Old threads often stick to built-in provider `openai`. After stripping ChatGPT OAuth,
 * Codex falls into auth_mode=ApiKey and still posts to api.openai.com — so point the
 * built-in openai base at the same mid-proxy, and keep bearer on the active custom provider.
 */
function alignRelayOpenaiBaseUrl(text: string): { text: string; detail?: string } {
  const provider = parseTomlString(text, "model_provider");
  if (!provider || BUILTIN_CODEX_PROVIDERS.has(provider)) {
    return { text };
  }
  const sectionRe = new RegExp(
    `\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]([\\s\\S]*?)(?=\\n\\[|$)`,
    "i"
  );
  const section = text.match(sectionRe)?.[1] ?? "";
  const baseUrl = parseTomlString(section, "base_url") || "";
  if (!baseUrl || isOpenaiApiHost(baseUrl)) return { text };
  if (/^\s*requires_openai_auth\s*=\s*true\s*$/im.test(section)) return { text };

  const openaiBase = toOpenaiStyleBaseUrl(baseUrl);
  const current = parseTomlString(text, "openai_base_url") || "";
  if (current.replace(/\/+$/, "") === openaiBase.replace(/\/+$/, "")) {
    return { text };
  }
  return {
    text: upsertTopLevelTomlString(text, "openai_base_url", openaiBase),
    detail: `openai_base_url → ${openaiBase} (sticky openai threads / ApiKey mode)`
  };
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
  const unglued = repairGluedOpenaiBaseUrlLine(next);
  if (unglued !== next) {
    next = unglued;
    details.push("fixed glued openai_base_url/model line");
  }
  const fallbackBaseUrl = resolveFallbackProviderBaseUrl(next);

  // Historical threads created under Cockpit Local Access still reference this provider.
  if (!hasModelProviderSection(next, "codex_local_access")) {
    next = ensureProviderSection(next, "codex_local_access", fallbackBaseUrl);
    details.push(`ensured [model_providers.codex_local_access] base_url=${fallbackBaseUrl}`);
  }

  const relaxed = relaxRelayOpenaiAuth(next);
  if (relaxed.changed.length) {
    next = relaxed.text;
    details.push(
      `requires_openai_auth=false for relay provider(s): ${relaxed.changed.join(", ")}`
    );
  }

  const aligned = alignRelayOpenaiBaseUrl(next);
  if (aligned.detail) {
    next = aligned.text;
    details.push(aligned.detail);
  }

  const provider = parseTomlString(next, "model_provider");
  if (!provider) {
    if (next !== text) {
      await fs.writeFile(configPath, next, "utf8");
      details.push("model_provider unset");
    }
    const authRepair = await sanitizeCodexRelayAuth(next);
    if (authRepair.repaired) details.push(authRepair.detail);
    return {
      repaired: details.length > 0,
      detail: details.join("; ") || "model_provider unset"
    };
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
    const authRepair = await sanitizeCodexRelayAuth(next);
    if (authRepair.repaired) {
      return { repaired: true, detail: [details[0] || `provider ${provider} ok`, authRepair.detail].filter(Boolean).join("; ") };
    }
    return { repaired: false, detail: details[0] || `provider ${provider} ok` };
  }
  await fs.writeFile(configPath, next, "utf8");
  const authRepair = await sanitizeCodexRelayAuth(next);
  if (authRepair.repaired) details.push(authRepair.detail);
  return { repaired: true, detail: details.join("; ") };
}

/**
 * CCSwitch "preserve official auth" leaves dead ChatGPT OAuth tokens in auth.json.
 * With a relay provider (non-OpenAI base_url + requires_openai_auth=false), Codex still
 * prefers those tokens → auth_mode=Chatgpt, MCP codex_apps 401, refresh_token_invalidated.
 *
 * Convert to API-key mode, keep the mid-proxy key in auth.json, and ensure the active
 * custom provider has experimental_bearer_token. Pair with openai_base_url alignment so
 * sticky built-in `openai` threads do not keep posting to api.openai.com.
 */
export async function sanitizeCodexRelayAuth(configText?: string): Promise<{
  repaired: boolean;
  detail: string;
}> {
  const home = codexHomeDir();
  const configPath = path.join(home, "config.toml");
  const authPath = path.join(home, "auth.json");
  let text = configText || "";
  if (!text) {
    try {
      text = await fs.readFile(configPath, "utf8");
    } catch {
      return { repaired: false, detail: "config.toml missing" };
    }
  }

  const provider = parseTomlString(text, "model_provider");
  if (!provider || BUILTIN_CODEX_PROVIDERS.has(provider)) {
    return { repaired: false, detail: "official openai provider" };
  }
  const sectionRe = new RegExp(
    `\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]([\\s\\S]*?)(?=\\n\\[|$)`,
    "i"
  );
  const section = text.match(sectionRe)?.[1] ?? "";
  const baseUrl = parseTomlString(section, "base_url") || "";
  if (!baseUrl || isOpenaiApiHost(baseUrl)) {
    return { repaired: false, detail: "openai host or missing base_url" };
  }
  if (/^\s*requires_openai_auth\s*=\s*true\s*$/im.test(section)) {
    return { repaired: false, detail: "provider still requires_openai_auth" };
  }

  const bearer = parseTomlString(section, "experimental_bearer_token")?.trim() || "";
  let authRaw = "";
  try {
    authRaw = await fs.readFile(authPath, "utf8");
  } catch {
    authRaw = "";
  }
  let auth: Record<string, unknown> = {};
  if (authRaw) {
    try {
      auth = JSON.parse(authRaw) as Record<string, unknown>;
    } catch {
      auth = {};
    }
  }
  const existingKey = typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY.trim() : "";
  const apiKey = bearer || existingKey;
  if (!apiKey) {
    return { repaired: false, detail: "no relay bearer / OPENAI_API_KEY to install" };
  }

  const details: string[] = [];
  let nextConfig = text;
  const bearerUpsert = upsertProviderBearer(nextConfig, provider, apiKey);
  if (bearerUpsert.changed) {
    nextConfig = bearerUpsert.text;
    details.push(`synced experimental_bearer_token on ${provider}`);
  }
  const aligned = alignRelayOpenaiBaseUrl(nextConfig);
  if (aligned.detail) {
    nextConfig = aligned.text;
    details.push(aligned.detail);
  }
  if (nextConfig !== text) {
    try {
      await fs.writeFile(configPath, nextConfig, "utf8");
    } catch (error) {
      return { repaired: false, detail: `config rewrite failed: ${String(error)}` };
    }
  }

  const tokens = auth.tokens;
  const hasOauthTokens = Boolean(
    tokens
    && typeof tokens === "object"
    && (
      (tokens as Record<string, unknown>).access_token
      || (tokens as Record<string, unknown>).refresh_token
    )
  );
  const authNeedsRewrite = hasOauthTokens
    || existingKey !== apiKey
    || Boolean(auth.tokens)
    || Boolean(auth.last_refresh)
    || Object.keys(auth).some((k) => k !== "OPENAI_API_KEY");

  if (authNeedsRewrite) {
    const nextAuth: Record<string, unknown> = { OPENAI_API_KEY: apiKey };
    try {
      if (authRaw) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await fs.writeFile(path.join(home, `auth.json.bak-relay-${stamp}`), authRaw, "utf8");
      }
      await fs.writeFile(authPath, `${JSON.stringify(nextAuth, null, 2)}\n`, "utf8");
    } catch (error) {
      return { repaired: false, detail: `auth rewrite failed: ${String(error)}` };
    }
    details.push(
      hasOauthTokens
        ? "stripped ChatGPT OAuth tokens from auth.json (relay api-key mode)"
        : "normalized auth.json to relay api-key mode"
    );
  }

  if (!details.length) {
    return { repaired: false, detail: "auth/config already relay-ready" };
  }
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
 * Stable fingerprint of on-disk Codex credential routing (no secrets).
 * Used to detect stale app-server processes after CCSwitch / manual config edits.
 */
export async function readCodexCredentialFingerprint(): Promise<string> {
  const home = codexHomeDir();
  const configPath = path.join(home, "config.toml");
  const authPath = path.join(home, "auth.json");
  let configText = "";
  let configMeta = "missing";
  let authMeta = "missing";
  try {
    const st = await fs.stat(configPath);
    configMeta = `${st.mtimeMs}:${st.size}`;
    configText = await fs.readFile(configPath, "utf8");
  } catch {
    /* ignore */
  }
  let hasApiKey = false;
  let hasOauth = false;
  try {
    const st = await fs.stat(authPath);
    authMeta = `${st.mtimeMs}:${st.size}`;
    const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
    hasApiKey = Boolean(typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim());
    const tokens = auth.tokens;
    hasOauth = Boolean(
      tokens
      && typeof tokens === "object"
      && (
        (tokens as Record<string, unknown>).access_token
        || (tokens as Record<string, unknown>).refresh_token
      )
    );
  } catch {
    /* ignore */
  }
  const provider = parseTomlString(configText, "model_provider") || "";
  const openaiBase = parseTomlString(configText, "openai_base_url") || "";
  let providerBase = "";
  let requiresAuth = "";
  let hasBearer = false;
  if (provider) {
    const sectionRe = new RegExp(
      `\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]([\\s\\S]*?)(?=\\n\\[|$)`,
      "i"
    );
    const section = configText.match(sectionRe)?.[1] ?? "";
    providerBase = parseTomlString(section, "base_url") || "";
    requiresAuth = /^\s*requires_openai_auth\s*=\s*true\s*$/im.test(section) ? "true" : "false";
    hasBearer = Boolean(parseTomlString(section, "experimental_bearer_token")?.trim());
  }
  return [
    `cfg=${configMeta}`,
    `auth=${authMeta}`,
    `provider=${provider}`,
    `openaiBase=${openaiBase}`,
    `providerBase=${providerBase}`,
    `requiresAuth=${requiresAuth}`,
    `bearer=${hasBearer ? "1" : "0"}`,
    `apiKey=${hasApiKey ? "1" : "0"}`,
    `oauth=${hasOauth ? "1" : "0"}`
  ].join("|");
}

/**
 * Repair relay flags / auth, then return whether on-disk routing changed enough
 * that a running Codex app-server must be restarted to pick it up.
 */
export async function syncCodexRelayConfigForTurn(): Promise<{
  repaired: boolean;
  detail: string;
  fingerprint: string;
}> {
  const before = await readCodexCredentialFingerprint();
  const providerRepair = await repairCodexModelProviderConfig();
  const authRepair = await sanitizeCodexRelayAuth();
  const fingerprint = await readCodexCredentialFingerprint();
  const details = [
    providerRepair.repaired ? providerRepair.detail : "",
    authRepair.repaired ? authRepair.detail : ""
  ].filter(Boolean);
  return {
    repaired: providerRepair.repaired || authRepair.repaired || before !== fingerprint,
    detail: details.join("; ") || (before !== fingerprint ? "credential fingerprint changed" : "unchanged"),
    fingerprint
  };
}

/**
 * Read-only preflight: if Codex points at a loopback gateway, verify the port is listening.
 * Does not modify Cockpit sidecar config, and never kills/restarts cockpit-cliproxy.
 */
export async function assertCodexLocalGatewayReady(): Promise<void> {
  await repairCodexModelProviderConfig();
  await sanitizeCodexRelayAuth();

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
