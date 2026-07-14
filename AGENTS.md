# Agent / contributor notes

## Desktop client releases

- **Only bump and publish the desktop agent** (`apps/agent` version, git tag `v*`, GitHub Release client artifacts, CI `build-clients`) when the change **actually affects the Electron client** (e.g. `apps/agent/**`, packaging that ships with the client).
- If the change is **only** relay, web, admin, docs, protocol-used-by-server, or CI unrelated to the desktop app: **do not** bump `apps/agent` version, **do not** create a client Release tag solely for that work, and **do not** upload new Setup/dmg/zip.
- Shared protocol changes: publish a **client** release only if the packaged agent must pick up the protocol change; otherwise ship server/web without a new client build.
