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

/** Read active model_provider base_url from ~/.codex/config.toml (no secrets). */
export async function resolveCodexProviderBaseUrl(): Promise<{
  provider: string;
  baseUrl: string;
} | null> {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  let text = "";
  try {
    text = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return null;
  }
  const provider = parseTomlString(text, "model_provider");
  if (!provider) return null;

  // Prefer the matching [model_providers.<name>] section's base_url.
  const sectionRe = new RegExp(
    `\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]([\\s\\S]*?)(?=\\n\\[|$)`,
    "i"
  );
  const section = text.match(sectionRe)?.[1] ?? "";
  const baseUrl = parseTomlString(section, "base_url") || parseTomlString(text, "base_url");
  if (!baseUrl) return null;
  return { provider, baseUrl };
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
 * Fail fast when Codex is configured to a local gateway that is not listening.
 * Avoids opaque upstream 499 / connection errors after turn/start.
 */
export async function assertCodexLocalGatewayReady(): Promise<void> {
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
      "当前 ~/.codex/config.toml 指向本地转发（常见为 Cockpit Tools / cockpit-cliproxy :3310），但端口未监听。",
      "请先启动对应网关后再从网页下发 Codex 任务；或把 model_provider 改成可直连的供应商后重启 AnytimeVibe Agent。"
    ].join("\n")
  );
}
