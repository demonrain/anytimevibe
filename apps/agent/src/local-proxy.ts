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

function normalizeProxyUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return value;
  // Windows Internet Settings often store host:port without scheme.
  return `http://${value}`;
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
  if (!out.ALL_PROXY && (out.HTTP_PROXY || out.HTTPS_PROXY)) {
    const fallback = out.HTTPS_PROXY || out.HTTP_PROXY;
    out.ALL_PROXY = fallback;
    out.all_proxy = fallback;
  }
  return out;
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
        // Convert IE-style list to NO_PROXY (comma separated, drop <local>)
        const noProxy = override
          .split(";")
          .map((item) => item.trim())
          .filter((item) => item && item.toLowerCase() !== "<local>")
          .join(",");
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
  if (hasHttp) return fromEnv;

  const fromSystem = await readWindowsInternetProxy();
  return { ...fromSystem, ...fromEnv };
}

export function mergeProxyIntoEnv(base: NodeJS.ProcessEnv, proxy: LocalProxyEnv): NodeJS.ProcessEnv {
  const next = { ...base };
  for (const [key, value] of Object.entries(proxy)) {
    if (value) next[key] = value;
  }
  return next;
}

/** Shell prefix that sets proxy vars before the real CLI command. */
export function proxyShellPrefix(proxy: LocalProxyEnv, platform: NodeJS.Platform = process.platform): string {
  const entries = Object.entries(proxy).filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (!entries.length) return "";
  if (platform === "win32") {
    // cmd.exe: set VAR=value && ...
    return `${entries.map(([key, value]) => `set "${key}=${value.replace(/"/g, "")}"`).join(" && ")} && `;
  }
  // bash/zsh for macOS Terminal
  return `${entries.map(([key, value]) => `export ${key}=${JSON.stringify(value)}`).join(" && ")} && `;
}
