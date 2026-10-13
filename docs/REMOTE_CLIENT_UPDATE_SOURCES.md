# Remote client update sources

New clients receive both URLs from `/api/agent/config`:

- `updateDirectUrl`: the original release feed, usually GitHub Releases.
- `updateFeedUrl`: the server-side relay used as a fallback and retained for older clients.

The desktop client checks and downloads from `updateDirectUrl` first through the
machine's configured proxy. If the check or package download fails, it retries
using `updateFeedUrl` with a direct Electron network session. A successful
GitHub check does not contact the relay, so the relay is not used for normal
downloads. Legacy relay responses remain supported.

Remote silent updates always download the complete installer/archive; differential
downloads are disabled because the silent installer replaces the full app tree.
The Windows backup uses Electron's `original-fs` API to copy `resources/app.asar`
as a physical file. Electron's patched `fs` treats ASAR paths as virtual paths,
which can otherwise produce `ENOENT, not found in ...resources\\app.asar` while
copying an existing installation.

Relevant verification:

- `apps/agent/src/cli/update-feed.test.ts`: source ordering and legacy relay behavior.
- `apps/relay/src/update-relay.test.ts`: both direct and relay URLs are advertised.
- `apps/agent/src/client-update-installer.test.ts`: Windows silent install and rollback.
