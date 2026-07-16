/**
 * Resolve the latest published desktop client version for soft update prompts.
 * Prefer env override; otherwise cache GitHub Releases "latest" tag.
 */

const CACHE_TTL_MS = 30 * 60_000;

type Cache = { version: string | null; fetchedAt: number };

let cache: Cache = { version: null, fetchedAt: 0 };

function normalizeVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^v/i, "");
  return cleaned || null;
}

export async function getLatestClientVersion(options?: {
  /** Explicit override from env (no network). */
  override?: string | null;
  /** GitHub API URL for latest release. */
  releasesUrl?: string;
}): Promise<string | null> {
  const override = normalizeVersion(options?.override);
  if (override) {
    cache = { version: override, fetchedAt: Date.now() };
    return override;
  }

  if (cache.version && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.version;
  }

  const url =
    options?.releasesUrl
    || "https://api.github.com/repos/demonrain/anytimevibe/releases/latest";

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "anytimevibe-relay"
      },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return cache.version;
    const body = (await response.json()) as { tag_name?: string; name?: string };
    const version = normalizeVersion(body.tag_name) || normalizeVersion(body.name);
    if (version) cache = { version, fetchedAt: Date.now() };
    return cache.version;
  } catch {
    return cache.version;
  }
}
