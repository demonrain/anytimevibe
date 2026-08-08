import { createConnection } from "node:net";
import { spawn } from "node:child_process";
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

/**
 * Cockpit Local Access often sets `model_provider = "codex_local_access"` then later
 * strips `[model_providers.codex_local_access]`, which makes Codex fail at startup with:
 *   failed to load configuration: Model provider `codex_local_access` not found
 *
 * Repair by switching to an existing custom provider (preferred), or recreating a
 * minimal local-access section from openai_base_url / localhost:3310.
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

  const provider = parseTomlString(text, "model_provider");
  if (!provider) return { repaired: false, detail: "model_provider unset" };
  if (BUILTIN_CODEX_PROVIDERS.has(provider) || hasModelProviderSection(text, provider)) {
    return { repaired: false, detail: `provider ${provider} ok` };
  }

  const customs = listCustomModelProviders(text);
  const fallback =
    customs.find((name) => name.toLowerCase() === "custom") ||
    customs.find((name) => name.toLowerCase() !== "codex_local_access") ||
    customs[0];

  if (fallback) {
    const next = text.replace(
      /(?:^|\n)\s*model_provider\s*=\s*"[^"]*"/i,
      (m) => m.replace(/=\s*"[^"]*"/, `= "${fallback}"`)
    );
    if (next === text) {
      return { repaired: false, detail: `failed to rewrite model_provider → ${fallback}` };
    }
    await fs.writeFile(configPath, next, "utf8");
    return {
      repaired: true,
      detail: `model_provider ${provider} missing section → switched to ${fallback}`
    };
  }

  // No custom providers at all: recreate a minimal section so Codex can boot.
  const baseUrl =
    parseTomlString(text, "openai_base_url") ||
    (provider === "codex_local_access" ? "http://localhost:3310/v1" : "") ||
    "http://localhost:3310/v1";
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
  const next =
    insertAt >= 0 ? `${text.slice(0, insertAt)}\n${block}${text.slice(insertAt + 1)}` : `${text.trimEnd()}\n${block}`;
  await fs.writeFile(configPath, next, "utf8");
  return {
    repaired: true,
    detail: `recreated [model_providers.${provider}] base_url=${baseUrl}`
  };
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

function sidecarDir(): string {
  return path.join(os.homedir(), ".antigravity_cockpit", "codex_local_access_sidecar");
}

function cliproxyCandidates(): string[] {
  const home = os.homedir();
  return [
    process.env.COCKPIT_CLIPROXY?.trim() || "",
    "D:\\Cockpit Tools\\cockpit-cliproxy.exe",
    "C:\\Cockpit Tools\\cockpit-cliproxy.exe",
    path.join(home, "Cockpit Tools", "cockpit-cliproxy.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Cockpit Tools", "cockpit-cliproxy.exe")
  ].filter(Boolean);
}

/**
 * Cockpit Tools periodically rewrites sidecar config back to aggressive defaults
 * (stream-idle 60s + responses_websockets beta) which surfaces as HTTP 499/504
 * on store.demonrain.top during long Codex reasoning.
 *
 * Re-apply durable streaming settings (no secrets modified).
 */
export async function hardenCodexLocalAccessSidecar(): Promise<{ changed: boolean; path: string }> {
  const configPath = path.join(sidecarDir(), "config.json");
  let raw = "";
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return { changed: false, path: configPath };
  }
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(raw) as Record<string, any>;
  } catch {
    return { changed: false, path: configPath };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { changed: false, path: configPath };
  }

  const streaming = (parsed.streaming && typeof parsed.streaming === "object" && !Array.isArray(parsed.streaming))
    ? { ...parsed.streaming }
    : {};
  const headers = (parsed["codex-header-defaults"] && typeof parsed["codex-header-defaults"] === "object"
    && !Array.isArray(parsed["codex-header-defaults"]))
    ? { ...parsed["codex-header-defaults"] }
    : {};

  let changed = false;
  const setNum = (obj: Record<string, any>, key: string, value: number) => {
    if (Number(obj[key]) === value) return;
    obj[key] = value;
    changed = true;
  };
  setNum(streaming, "stream-idle-timeout-ms", 600_000);
  setNum(streaming, "image-stream-idle-timeout-ms", 600_000);
  setNum(streaming, "stream-open-timeout-ms", 60_000);
  setNum(streaming, "image-stream-open-timeout-ms", 60_000);
  setNum(streaming, "stream-open-max-attempts", 5);
  setNum(streaming, "bootstrap-retries", 3);
  setNum(streaming, "keepalive-seconds", 15);
  if (Number(parsed["request-retry"]) !== 3) {
    parsed["request-retry"] = 3;
    changed = true;
  }
  const beta = String(headers["beta-features"] ?? "");
  if (/responses_websockets/i.test(beta) || beta.trim() !== "") {
    // Empty string disables forced WS beta that breaks long SSE turns.
    if (headers["beta-features"] !== "") {
      headers["beta-features"] = "";
      changed = true;
    }
  }

  if (!changed) return { changed: false, path: configPath };

  parsed.streaming = streaming;
  parsed["codex-header-defaults"] = headers;
  try {
    await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  } catch {
    return { changed: false, path: configPath };
  }
  return { changed: true, path: configPath };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function killCliproxyWindows(): Promise<void> {
  if (process.platform !== "win32") return;
  await new Promise<void>((resolve) => {
    const child = spawn("taskkill", ["/IM", "cockpit-cliproxy.exe", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
    setTimeout(resolve, 2_000);
  });
}

/** Best-effort restart of Cockpit local-access sidecar so hardened config is loaded. */
export async function restartCodexLocalAccessSidecar(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const dir = sidecarDir();
  const configPath = path.join(dir, "config.json");
  const manifestPath = path.join(dir, "manifest.json");
  const quotaReserve = path.join(dir, "quota-reserve.json");
  const quotaPool = path.join(dir, "quota-pool-state.json");
  if (!(await pathExists(configPath))) return false;

  let exe = "";
  for (const candidate of cliproxyCandidates()) {
    if (await pathExists(candidate)) {
      exe = candidate;
      break;
    }
  }
  if (!exe) return false;

  await killCliproxyWindows();
  await new Promise((r) => setTimeout(r, 800));

  const args = ["--config", configPath, "--manifest", manifestPath];
  if (await pathExists(quotaReserve)) args.push("--quota-reserve-state", quotaReserve);
  if (await pathExists(quotaPool)) args.push("--quota-pool-state", quotaPool);

  try {
    const child = spawn(exe, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  } catch {
    return false;
  }
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    if (await probeTcp("127.0.0.1", 3310, 800)) return true;
  }
  return await probeTcp("127.0.0.1", 3310, 1_000);
}

/**
 * Fail fast when Codex is configured to a local gateway that is not listening.
 * Also harden Cockpit sidecar streaming defaults that commonly cause HTTP 499.
 */
export async function assertCodexLocalGatewayReady(): Promise<void> {
  // Repair broken Cockpit leftovers before Codex app-server loads config.toml.
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

  const harden = await hardenCodexLocalAccessSidecar();
  let ok = await probeTcp(host, port, 1_500);
  if (!ok || harden.changed) {
    const restarted = await restartCodexLocalAccessSidecar();
    ok = restarted || await probeTcp(host, port, 1_500);
  }
  if (ok) return;
  throw new Error(
    [
      `本机 Codex 网关不可达：${url.origin}（model_provider=${resolved.provider}）。`,
      "当前 ~/.codex/config.toml 指向 Cockpit local-access（常见 cockpit-cliproxy :3310），但端口未监听。",
      "请打开 Cockpit Tools 启本地 API / Codex Local Access，或把 model_provider 改成可直连供应商后重启 AnytimeVibe Agent。",
      "提示：Cockpit 常把 stream-idle-timeout 重置为 60s 并强制 responses_websockets，长推理会表现为 HTTP 499；随码会在任务前尝试自动加固该配置。"
    ].join("\n")
  );
}
