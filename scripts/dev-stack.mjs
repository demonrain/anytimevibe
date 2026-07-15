#!/usr/bin/env node
/**
 * Start local Postgres (if needed) + Relay + Web for end-to-end testing.
 * Agent is separate: pnpm dev:agent:local
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envLocal = path.join(root, ".env.local");
const children = [];

function spawnLogged(name, command, args, extraEnv = {}) {
  console.log(`[${name}] ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: false
  });
  child.on("exit", (code, signal) => {
    if (signal) console.log(`[${name}] exited by ${signal}`);
    else if (code !== 0 && code !== null) console.log(`[${name}] exited with ${code}`);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (!existsSync(envLocal)) {
  console.error("Missing .env.local — run: pnpm dev:setup");
  process.exit(1);
}

// Ensure DB is up
spawnLogged("db", "docker", ["compose", "-f", "docker-compose.dev.yml", "up", "-d"]);

// Small delay then start app processes with env file loader
setTimeout(() => {
  spawnLogged("relay", "node", ["scripts/run-with-env.mjs", ".env.local", "--", "pnpm", "--filter", "@anytimevibe/relay", "dev"]);
  spawnLogged("web", "pnpm", ["--filter", "@anytimevibe/web", "dev"]);
  console.log(`
Local stack starting...
  Web:   http://127.0.0.1:4173
  Relay: http://127.0.0.1:8787
  Agent: pnpm dev:agent:local   (separate window)
`);
}, 1500);
