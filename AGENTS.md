# Agent / contributor notes

## Local debugging vs remote

- **Do not push local debugging work to the remote** unless the user **explicitly** asks to commit and/or push (e.g. 「提交」「推送」「发版」).
- While iterating / 本地调试: keep changes on the machine only (`git commit` / `git push` only on request).
- **Never** commit or push secrets or machine-local runtime data, including:
  - `.env`, `.env.local`, `.env.*.local`
  - `.local/` (embedded Postgres data, local agent userdata)
  - personal notes, scratch dirs, IDE junk covered by `.gitignore`
- Shared repo tooling (e.g. `docs/LOCAL_DEV.md`, `scripts/dev-*.mjs`) is product infrastructure, not “debug residue”; still only push when the user asks.

## Desktop client releases

- **Only bump and publish the desktop agent** (`apps/agent` version, git tag `v*`, GitHub Release client artifacts, CI `build-clients`) when the change **actually affects the Electron client** (e.g. `apps/agent/**`, packaging that ships with the client).
- If the change is **only** relay, web, admin, docs, protocol-used-by-server, or CI unrelated to the desktop app: **do not** bump `apps/agent` version, **do not** create a client Release tag solely for that work, and **do not** upload new Setup/dmg/zip.
- Shared protocol changes: publish a **client** release only if the packaged agent must pick up the protocol change; otherwise ship server/web without a new client build.
