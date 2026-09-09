import type { CliEngine, CliEngineInfo } from "@anytimevibe/protocol";
import { collectLocalProxyEnv, mergeProxyIntoEnv } from "../local-proxy";
import { compareVersions, isUpdateAvailable, normalizeVersionLabel } from "./version-compare";

const LATEST_PROBE_TIMEOUT_MS = 15_000;
const LATEST_CACHE_TTL_MS = 30 * 60_000;

const NPM_PACKAGES: Partial<Record<CliEngine, { packageName: string; prereleaseTags?: string[] }>> = {
  codex: { packageName: "@openai/codex" },
  claude: { packageName: "@anthropic-ai/claude-code", prereleaseTags: ["next"] },
  grok: { packageName: "@xai-official/grok" },
  pi: { packageName: "@earendil-works/pi-coding-agent" }
};

const latestCache = new Map<CliEngine, { value: string | undefined; checkedAt: number }>();

export function clearEngineLatestCache(): void {
  latestCache.clear();
}

async function withProxyFetchEnv<T>(run: () => Promise<T>): Promise<T> {
  const proxy = await collectLocalProxyEnv();
  const previous: Record<string, string | undefined> = {};
  const merged = mergeProxyIntoEnv({ ...process.env }, proxy);
  const keys = [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
    "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"
  ] as const;
  for (const key of keys) {
    previous[key] = process.env[key];
    const value = merged[key];
    if (typeof value === "string" && value) process.env[key] = value;
  }
  if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  return withProxyFetchEnv(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LATEST_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "AnytimeVibe-Agent"
        }
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}

async function fetchText(url: string): Promise<string | null> {
  return withProxyFetchEnv(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LATEST_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "text/plain,*/*",
          "User-Agent": "AnytimeVibe-Agent"
        }
      });
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}

function pickNpmLatest(
  distTags: Record<string, unknown>,
  prereleaseTags: string[],
  localVersion: string | undefined
): string | undefined {
  const latest = typeof distTags.latest === "string" ? distTags.latest : undefined;
  if (!latest) return undefined;

  const localAhead = localVersion
    ? compareVersions(localVersion, latest) > 0
    : false;
  if (!prereleaseTags.length || !localAhead) return latest;

  let best = latest;
  for (const tag of prereleaseTags) {
    const candidate = distTags[tag];
    if (typeof candidate === "string" && compareVersions(candidate, best) > 0) {
      best = candidate;
    }
  }
  return best;
}

async function fetchNpmLatest(
  packageName: string,
  prereleaseTags: string[],
  localVersion: string | undefined
): Promise<string | undefined> {
  // registry.npmjs.org expects the literal scoped path (@scope/name), not URI-encoded.
  const body = await fetchJson(`https://registry.npmjs.org/${packageName}`) as {
    "dist-tags"?: Record<string, unknown>;
  } | null;
  const tags = body?.["dist-tags"];
  if (!tags || typeof tags !== "object") return undefined;
  return pickNpmLatest(tags as Record<string, unknown>, prereleaseTags, localVersion);
}

async function fetchGithubLatestTag(repo: string): Promise<string | undefined> {
  const json = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`) as {
    tag_name?: string;
    name?: string;
  } | null;
  if (!json) return undefined;
  const candidates = [json.name, json.tag_name?.replace(/^v/i, "")];
  for (const candidate of candidates) {
    const normalized = normalizeVersionLabel(candidate);
    if (!normalized) continue;
    // Drop calendar-style years mistaken as semver majors (Hermes-style tags).
    const major = Number(normalized.split(".")[0]);
    if (Number.isFinite(major) && major >= 2000) continue;
    return normalized;
  }
  return undefined;
}

/** Cursor install script embeds the current lab build id. */
async function fetchCursorLatestVersion(): Promise<string | undefined> {
  const urls = process.platform === "win32"
    ? ["https://cursor.com/install?win32=true", "https://cursor.com/install"]
    : ["https://cursor.com/install", "https://cursor.com/install?win32=true"];
  for (const url of urls) {
    const text = await fetchText(url);
    if (!text) continue;
    const match = text.match(/downloads\.cursor\.com\/lab\/(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)/i)
      || text.match(/versions\/(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)/i)
      || text.match(/(\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7,})/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

async function fetchLatestForEngine(
  engine: CliEngine,
  localVersion: string | undefined
): Promise<string | undefined> {
  const cached = latestCache.get(engine);
  if (cached && Date.now() - cached.checkedAt < LATEST_CACHE_TTL_MS) {
    return cached.value;
  }

  let value: string | undefined;
  const npm = NPM_PACKAGES[engine];
  if (npm) {
    value = await fetchNpmLatest(npm.packageName, npm.prereleaseTags ?? [], localVersion);
  }
  if (!value && engine === "cursor") value = await fetchCursorLatestVersion();
  if (!value && engine === "antigravity") {
    value = await fetchGithubLatestTag("google-antigravity/antigravity-cli");
  }

  latestCache.set(engine, { value, checkedAt: Date.now() });
  return value;
}

export async function enrichEnginesWithLatestVersions(
  engines: CliEngineInfo[],
  options: { force?: boolean } = {}
): Promise<CliEngineInfo[]> {
  if (options.force) clearEngineLatestCache();
  const results = await Promise.all(
    engines.map(async (item) => {
      if (!item.ready) {
        return { ...item, updateAvailable: false };
      }
      const local = normalizeVersionLabel(item.version);
      try {
        const latest = await fetchLatestForEngine(item.engine, local);
        if (!latest) return { ...item, updateAvailable: false };
        const updateAvailable = isUpdateAvailable(local, latest);
        return {
          ...item,
          latestVersion: latest,
          updateAvailable
        };
      } catch {
        return { ...item, updateAvailable: false };
      }
    })
  );
  return results;
}
