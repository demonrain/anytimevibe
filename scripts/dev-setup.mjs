#!/usr/bin/env node
/**
 * One-shot local test environment bootstrap:
 * - ensure .env.local exists
 * - start Postgres (docker compose dev)
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

console.log("\n[1/3] Starting local Postgres (docker compose)...");
try {
  run("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "-d"]);
} catch (error) {
  console.error("\nFailed to start Postgres. Is Docker Desktop running?");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log("\n[2/3] Waiting for Postgres health...");
let healthy = false;
for (let attempt = 1; attempt <= 30; attempt += 1) {
  const check = spawnSync(
    "docker",
    ["compose", "-f", "docker-compose.dev.yml", "exec", "-T", "postgres", "pg_isready", "-U", "anytimevibe", "-d", "anytimevibe"],
    { cwd: root, shell: process.platform === "win32", encoding: "utf8" }
  );
  if (check.status === 0) {
    healthy = true;
    break;
  }
  if (process.platform === "win32") {
    spawnSync("timeout", ["/t", "1", "/nobreak"], { shell: true, stdio: "ignore" });
  } else {
    spawnSync("sleep", ["1"], { stdio: "ignore" });
  }
}
if (!healthy) {
  console.error("Postgres did not become ready in time.");
  process.exit(1);
}
console.log("Postgres is ready.");

console.log("\n[3/3] Building protocol package...");
run("pnpm", ["--filter", "@anytimevibe/protocol", "build"]);

console.log(`
=== Setup complete ===

Next (three terminals, or use pnpm dev:stack):

  1) Relay   pnpm dev:relay
  2) Web     pnpm dev:web
  3) Agent   pnpm dev:agent:local

Open:  http://127.0.0.1:4173
Setup token (from .env.local): SETUP_TOKEN
Agent relay URL: http://127.0.0.1:8787

Agent local data dir: .local/agent-data (isolated from production installs)
Docs: docs/LOCAL_DEV.md
`);
