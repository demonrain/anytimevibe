export type UpdateSource = {
  url: string;
  mode: "auto" | "direct";
  kind: "direct" | "relay";
};

function normalize(value: string | null | undefined): string {
  return value?.trim().replace(/\/+$/, "") || "";
}

function isGithubHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ["github.com", "api.github.com", "objects.githubusercontent.com", "githubusercontent.com"]
    .some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isGithubFeed(feedUrl: string): boolean {
  try { return isGithubHost(new URL(feedUrl).hostname); } catch { return false; }
}

/** Route public GitHub release feeds through the configured relay when it advertises the route. */
export function resolveUpdateFeedUrl(feedUrl: string, relayUrl: string, relaySupportsTransfer = true): string {
  const feed = normalize(feedUrl);
  const relay = normalize(relayUrl);
  if (!feed || !relay || !relaySupportsTransfer) return feed;
  try {
    if (isGithubHost(new URL(feed).hostname)) {
      // electron-updater appends latest.yml / latest-mac.yml to this URL.
      // Keep the trailing slash so the relay wildcard route receives that filename.
      return `${relay}/api/agent/update/`;
    }
  } catch {
    // Keep malformed/custom values unchanged so the updater reports the useful error.
  }
  return feed;
}

/**
 * Build the ordered update feeds used by the desktop updater.
 *
 * `updateDirectUrl` is the original public release feed (normally GitHub), while
 * `updateFeedUrl` is the server relay advertised to older clients. Keeping both
 * lets a client use the local proxy for GitHub and only consume relay bandwidth
 * after the direct check or download fails.
 */
export function resolveUpdateSources(options: {
  updateDirectUrl?: string | null | undefined;
  updateFeedUrl?: string | null | undefined;
}, relayUrl: string, relaySupportsTransfer = true): UpdateSource[] {
  const configuredDirect = normalize(options.updateDirectUrl);
  const configuredFeed = normalize(options.updateFeedUrl);
  const direct = configuredDirect || (configuredFeed && !isGithubFeed(configuredFeed) ? configuredFeed : isGithubFeed(configuredFeed) ? configuredFeed : "");
  const relay = configuredFeed && isGithubFeed(configuredFeed)
    ? resolveUpdateFeedUrl(configuredFeed, relayUrl, relaySupportsTransfer)
    : configuredFeed;
  const sources: UpdateSource[] = [];
  const add = (url: string, source: UpdateSource) => {
    const normalized = normalize(url);
    if (!normalized || sources.some((item) => item.url === normalized)) return;
    sources.push({ ...source, url: normalized });
  };
  if (direct) add(direct, { url: direct, mode: "auto", kind: "direct" });
  if (relay && relay !== direct) add(relay, { url: relay, mode: "direct", kind: "relay" });
  return sources;
}
