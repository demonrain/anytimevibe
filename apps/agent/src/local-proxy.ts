import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy"
] as const;

export type LocalProxyEnv = Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>>;

/** Hosts/CIDRs/suffixes that must never go through the system proxy. */
export const LOCAL_NO_PROXY_HOSTS = [
  // Loopback
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  // Common LAN / intranet DNS suffixes (leading dot = suffix match for curl/reqwest)
  ".localhost",
  ".local",
  ".lan",
  ".home",
  ".internal",
  ".intranet",
  ".corp",
  ".private",
  ".localdomain",
  // RFC1918 + link-local (CIDR — supported by curl / Rust no_proxy / many CLIs)
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  // IPv6 ULA + link-local
  "fc00::/7",
  "fe80::/10"
] as const;

/** Chromium/Electron bypass list (wildcards + <local>). */
export const LOCAL_PROXY_BYPASS_RULES = [
  "<local>",
  "localhost",
  "127.0.0.1",
  "::1",
  "*.localhost",
  "*.local",
  "*.lan",
  "*.home",
  "*.internal",
  "*.intranet",
  "*.corp",
  "*.private",
  "*.localdomain",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16"
] as const;

function normalizeProxyUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return value;
  // Windows Internet Settings often store host:port without scheme.
  return `http://${value}`;
}

function splitNoProxy(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Merge NO_PROXY lists; keep first-seen order, case-insensitive dedupe. */
export function mergeNoProxyLists(...parts: Array<string | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const item of splitNoProxy(part)) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out.join(",");
}

/**
 * Ensure loopback + LAN hosts/domains bypass the proxy.
 * Without this, Clash/system proxy intercepts http://localhost:3310 (and LAN IPs)
 * and yields 504 — while a clean cmd CLI works.
 */
export function withLocalNoProxy(proxy: LocalProxyEnv): LocalProxyEnv {
  const hasProxy = Boolean(
    proxy.HTTP_PROXY
    || proxy.http_proxy
    || proxy.HTTPS_PROXY
    || proxy.https_proxy
    || proxy.ALL_PROXY
    || proxy.all_proxy
  );
  if (!hasProxy) return { ...proxy };

  const merged = mergeNoProxyLists(
    proxy.NO_PROXY,
    proxy.no_proxy,
    ...LOCAL_NO_PROXY_HOSTS
  );
  return {
    ...proxy,
    NO_PROXY: merged,
    no_proxy: merged
  };
}

function parseWindowsProxyServer(proxyServer: string): LocalProxyEnv {
  const out: LocalProxyEnv = {};
  // Formats:
  //  - 127.0.0.1:7890
  //  - http=127.0.0.1:7890;https=127.0.0.1:7890
  if (!proxyServer.includes("=")) {
    const url = normalizeProxyUrl(proxyServer);
    out.HTTP_PROXY = url;
    out.HTTPS_PROXY = url;
    out.ALL_PROXY = url;
    out.http_proxy = url;
    out.https_proxy = url;
    out.all_proxy = url;
    return out;
  }
  for (const part of proxyServer.split(";")) {
    const [rawKey, rawValue] = part.split("=");
    if (!rawKey || !rawValue) continue;
    const key = rawKey.trim().toLowerCase();
    const url = normalizeProxyUrl(rawValue);
    if (key === "http") {
      out.HTTP_PROXY = url;
      out.http_proxy = url;
    } else if (key === "https") {
      out.HTTPS_PROXY = url;
      out.https_proxy = url;
    } else if (key === "socks" || key === "socks5") {
      const socks = rawValue.trim().startsWith("socks") ? rawValue.trim() : `socks5://${rawValue.trim()}`;
      out.ALL_PROXY = socks;
      out.all_proxy = socks;
    }
  }
  if (!out.HTTPS_PROXY && out.HTTP_PROXY) {
    out.HTTPS_PROXY = out.HTTP_PROXY;
    out.https_proxy = out.HTTP_PROXY;
  }
  const fallback = out.HTTPS_PROXY || out.HTTP_PROXY;
  if (!out.ALL_PROXY && fallback) {
    out.ALL_PROXY = fallback;
    out.all_proxy = fallback;
  }
  return out;
}

/** Convert IE ProxyOverride list into NO_PROXY (preserve <local> as loopback hosts). */
export function proxyOverrideToNoProxy(override: string): string {
  const parts: string[] = [];
  for (const raw of override.split(";")) {
    const item = raw.trim();
    if (!item) continue;
    if (item.toLowerCase() === "<local>") {
      parts.push(...LOCAL_NO_PROXY_HOSTS);
      continue;
    }
    parts.push(item);
  }
  return mergeNoProxyLists(...parts);
}

async function readWindowsInternetProxy(): Promise<LocalProxyEnv> {
  if (process.platform !== "win32") return {};
  try {
    // reg query avoids native modules; works in packaged Electron too.
    const { stdout } = await execFileAsync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v",
      "ProxyEnable"
    ], { windowsHide: true, timeout: 5_000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(stdout) && !/ProxyEnable\s+REG_DWORD\s+1\b/i.test(stdout)) {
      return {};
    }
    const serverResult = await execFileAsync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v",
      "ProxyServer"
    ], { windowsHide: true, timeout: 5_000 });
    const match = serverResult.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)\s*$/im);
    const server = match?.[1]?.trim();
    if (!server) return {};
    const env = parseWindowsProxyServer(server);
    try {
      const overrideResult = await execFileAsync("reg", [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        "/v",
        "ProxyOverride"
      ], { windowsHide: true, timeout: 5_000 });
      const overrideMatch = overrideResult.stdout.match(/ProxyOverride\s+REG_SZ\s+(.+)\s*$/im);
      const override = overrideMatch?.[1]?.trim();
      if (override) {
        const noProxy = proxyOverrideToNoProxy(override);
        if (noProxy) {
          env.NO_PROXY = noProxy;
          env.no_proxy = noProxy;
        }
      }
    } catch {
      // optional
    }
    return env;
  } catch {
    return {};
  }
}

/** Collect local proxy settings from process env, then Windows system proxy as fallback. */
export async function collectLocalProxyEnv(): Promise<LocalProxyEnv> {
  const fromEnv: LocalProxyEnv = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) fromEnv[key] = value;
  }
  const hasHttp = Boolean(fromEnv.HTTP_PROXY || fromEnv.http_proxy || fromEnv.HTTPS_PROXY || fromEnv.https_proxy || fromEnv.ALL_PROXY || fromEnv.all_proxy);
  if (hasHttp) return withLocalNoProxy(fromEnv);

  const fromSystem = await readWindowsInternetProxy();
  return withLocalNoProxy({ ...fromSystem, ...fromEnv });
}

export function mergeProxyIntoEnv(base: NodeJS.ProcessEnv, proxy: LocalProxyEnv): NodeJS.ProcessEnv {
  const safe = withLocalNoProxy(proxy);
  const next = { ...base };
  for (const [key, value] of Object.entries(safe)) {
    if (value) next[key] = value;
  }
  // Even if `proxy` was empty, keep loopback bypass when the parent already has a proxy set.
  const parentHasProxy = Boolean(
    next.HTTP_PROXY
    || next.http_proxy
    || next.HTTPS_PROXY
    || next.https_proxy
    || next.ALL_PROXY
    || next.all_proxy
  );
  if (parentHasProxy) {
    const merged = mergeNoProxyLists(next.NO_PROXY, next.no_proxy, ...LOCAL_NO_PROXY_HOSTS);
    next.NO_PROXY = merged;
    next.no_proxy = merged;
    // Node 22+ / Cursor Agent bundled Node ignore HTTP(S)_PROXY unless this is set.
    // Docs: https://cursor.com/docs/cli/reference/configuration#proxy-configuration
    if (!next.NODE_USE_ENV_PROXY) next.NODE_USE_ENV_PROXY = "1";
  }
  return next;
}

/**
 * Remove proxy env vars so Codex talks to local gateways (e.g. :3310) the same way as a clean cmd.
 * NO_PROXY alone is not enough: Codex stream_open / some Clash paths still route localhost via HTTP_PROXY.
 */
export function stripProxyFromEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...base };
  for (const key of PROXY_ENV_KEYS) {
    if (key === "NO_PROXY" || key === "no_proxy") continue;
    delete next[key];
  }
  // Keep an explicit bypass list for any residual tooling that still reads proxy settings.
  const merged = mergeNoProxyLists(next.NO_PROXY, next.no_proxy, ...LOCAL_NO_PROXY_HOSTS);
  next.NO_PROXY = merged;
  next.no_proxy = merged;
  return next;
}

/**
 * Clash / system HTTP proxies often break Cursor Agent HTTP/2 streams (GPT models like gpt-5.6-sol).
 * Official fallback: ~/.cursor/cli-config.json → network.useHttp1ForAgent = true
 * Only flips false→true when a local proxy is active; never disables an existing true.
 */
export async function ensureCursorHttp1ForProxy(proxy: LocalProxyEnv): Promise<boolean> {
  const hasProxy = Boolean(
    proxy.HTTP_PROXY
    || proxy.http_proxy
    || proxy.HTTPS_PROXY
    || proxy.https_proxy
    || proxy.ALL_PROXY
    || proxy.all_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
  );
  if (!hasProxy) return false;

  const { promises: fs } = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const configPath = path.join(os.homedir(), ".cursor", "cli-config.json");
  try {
    let raw = "";
    try {
      raw = await fs.readFile(configPath, "utf8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parsed = raw.trim() ? JSON.parse(raw) as Record<string, any> : { version: 1 };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const network = (parsed.network && typeof parsed.network === "object" && !Array.isArray(parsed.network))
      ? { ...parsed.network }
      : {};
    if (network.useHttp1ForAgent === true) return false;
    network.useHttp1ForAgent = true;
    parsed.network = network;
    if (parsed.version == null) parsed.version = 1;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    console.warn("[proxy] failed to enable Cursor useHttp1ForAgent:", error);
    return false;
  }
}

/** Shell lines that clear proxy vars (cmd / powershell / bash). */
export function proxyClearShellLines(platform: "win32" | "darwin" | "powershell"): string[] {
  const keys = PROXY_ENV_KEYS.filter((key) => key !== "NO_PROXY" && key !== "no_proxy");
  const noProxy = mergeNoProxyLists(...LOCAL_NO_PROXY_HOSTS);
  if (platform === "powershell") {
    return [
      ...keys.map((key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`),
      `$env:NO_PROXY = ${JSON.stringify(noProxy)}`,
      `$env:no_proxy = ${JSON.stringify(noProxy)}`
    ];
  }
  if (platform === "win32") {
    return [
      ...keys.map((key) => `set "${key}="`),
      `set "NO_PROXY=${noProxy}"`,
      `set "no_proxy=${noProxy}"`
    ];
  }
  return [
    ...keys.map((key) => `unset ${key}`),
    `export NO_PROXY=${JSON.stringify(noProxy)}`,
    `export no_proxy=${JSON.stringify(noProxy)}`
  ];
}

/** Shell prefix that sets proxy vars before the real CLI command. */
export function proxyShellPrefix(proxy: LocalProxyEnv, platform: NodeJS.Platform = process.platform): string {
  const safe = withLocalNoProxy(proxy);
  const entries = Object.entries(safe).filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (!entries.length) return "";
  if (platform === "win32") {
    // cmd.exe: set VAR=value && ...
    return `${entries.map(([key, value]) => `set "${key}=${value.replace(/"/g, "")}"`).join(" && ")} && `;
  }
  // bash/zsh for macOS Terminal
  return `${entries.map(([key, value]) => `export ${key}=${JSON.stringify(value)}`).join(" && ")} && `;
}
