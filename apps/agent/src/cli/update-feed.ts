/** Route public GitHub release feeds through the configured relay when it advertises the route. */
export function resolveUpdateFeedUrl(feedUrl: string, relayUrl: string, relaySupportsTransfer = true): string {
  const feed = feedUrl.trim().replace(/\/+$/, "");
  const relay = relayUrl.trim().replace(/\/+$/, "");
  if (!feed || !relay || !relaySupportsTransfer) return feed;
  try {
    const host = new URL(feed).hostname.toLowerCase();
    if (["github.com", "api.github.com", "objects.githubusercontent.com", "githubusercontent.com"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      // electron-updater appends latest.yml / latest-mac.yml to this URL.
      // Keep the trailing slash so the relay wildcard route receives that filename.
      return `${relay}/api/agent/update/`;
    }
  } catch {
    // Keep malformed/custom values unchanged so the updater reports the useful error.
  }
  return feed;
}
