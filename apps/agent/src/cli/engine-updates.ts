import type { CliEngine, CliEngineInfo } from "@anytimevibe/protocol";
import { compareVersions, isUpdateAvailable, normalizeVersionLabel } from "./version-compare";
import { engineUpdateNetworkRevision, npmUpdateRegistryCandidates, resolveEngineUpdateUrl } from "./update-network";

const LATEST_PROBE_TIMEOUT_MS = 15_000;
const LATEST_CACHE_TTL_MS = 30 * 60_000;

const NPM_PACKAGES: Partial<Record<CliEngine, { packageName: string; prereleaseTags?: string[] }>> = {
  codex: { packageName: "@openai/codex" },
  claude: { packageName: "@anthropic-ai/claude-code", prereleaseTags: ["next"] },
  grok: { packageName: "@xai-official/grok" },
  pi: { packageName: "@earendil-works/pi-coding-agent" }
};

const latestCache = new Map<string, { value: string | undefined; checkedAt: number }>();

/** npm is intermittently unreachable from mainland networks; keep a deterministic mirror fallback. */
export function npmRegistryCandidates(): string[] {
  return npmUpdateRegistryCandidates();
}

export function clearEngineLatestCache(): void {
  latestCache.clear();
}

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LATEST_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "AnytimeVibe-Agent" } });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LATEST_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "text/plain,*/*", "User-Agent": "AnytimeVibe-Agent" } });
    if (!response.ok) return null;
    return await response.text();
  } catch { return null; }
  finally { clearTimeout(timer); }
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
  // Keep the literal scoped path (@scope/name), not URI-encoded.
  for (const registry of npmRegistryCandidates()) {
    const body = await fetchJson(`${registry}/${packageName}`) as {
      "dist-tags"?: Record<string, unknown>;
    } | null;
    const tags = body?.["dist-tags"];
    if (!tags || typeof tags !== "object") continue;
    const latest = pickNpmLatest(tags as Record<string, unknown>, prereleaseTags, localVersion);
    if (latest) return latest;
  }
  return undefined;
}

async function fetchGithubLatestTag(repo: string): Promise<string | undefined> {
  const officialUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const json = await fetchJson(resolveEngineUpdateUrl("antigravity-latest", officialUrl)) as {
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
    const text = await fetchText(resolveEngineUpdateUrl("cursor-installer", url));
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
  const cacheKey = `${engineUpdateNetworkRevision()}|${npmRegistryCandidates().join(",")}|${engine}|${localVersion || ""}`;
  const cached = latestCache.get(cacheKey);
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

  latestCache.set(cacheKey, { value, checkedAt: Date.now() });
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
