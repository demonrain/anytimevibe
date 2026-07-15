#!/usr/bin/env node
/**
 * One-shot local test environment bootstrap:
 * - ensure .env.local exists
 * - start local Postgres (Docker if healthy, else embedded / native guidance)
 * - build protocol package
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envLocal = path.join(root, ".env.local");
const envExample = path.join(root, ".env.local.example");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }
}

console.log("=== AnytimeVibe local setup ===\n");

if (!existsSync(envLocal)) {
  if (!existsSync(envExample)) {
    console.error("Missing .env.local.example");
    process.exit(1);
  }
  copyFileSync(envExample, envLocal);
  console.log(`Created ${envLocal} from .env.local.example`);
} else {
  console.log(`Using existing ${envLocal}`);
}

mkdirSync(path.join(root, ".local"), { recursive: true });

console.log("\n[1/2] Preparing local Postgres (Docker if available, otherwise embedded)...");
console.log("      Prefer: open Docker Desktop only if it starts cleanly.");
console.log("      If Docker is stuck on \"Starting the Docker Engine\", ignore it and use this path.\n");

// Start/ensure DB. For embedded mode this would block — so only run the non-blocking path here.
// Prefer docker-or-already-up; if only embedded works, ask user to run `pnpm dev:pg` separately.
const ensure = spawnSync(process.execPath, ["scripts/dev-pg.mjs", "ensure"], {
  cwd: root,
  encoding: "utf8",
  shell: false
});
if (ensure.stdout) process.stdout.write(ensure.stdout);
if (ensure.stderr) process.stderr.write(ensure.stderr);
if (ensure.status === 0) {
  console.log("[setup] Postgres is reachable.");
} else {
  console.warn("\n[setup] Postgres is not ready yet (Docker unavailable is OK).");
  console.warn("  Next: in a NON-admin terminal run  pnpm dev:pg  and leave it open.");
  console.warn("  Or: winget install -e --id PostgreSQL.PostgreSQL.16\n");
}

console.log("\n[2/2] Building protocol package...");
run("pnpm", ["--filter", "@anytimevibe/protocol", "build"]);

console.log(`
=== Setup files ready ===

Daily local test (recommended when Docker Desktop is broken):

  Terminal 1:  pnpm dev:pg          # keep running (embedded Postgres) — use NON-admin shell
  Terminal 2:  pnpm dev:stack       # Relay + Web
  Terminal 3:  pnpm dev:agent:local # Electron → http://127.0.0.1:8787

Open:  http://127.0.0.1:4173
SETUP_TOKEN: see .env.local

If this shell is Administrator, PostgreSQL embedded mode will refuse to start.
Use a normal PowerShell/Windows Terminal window, or install native PostgreSQL.

Docker stuck help: docs/LOCAL_DEV.md#docker-desktop-卡住
`);
