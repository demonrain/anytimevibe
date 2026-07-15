#!/usr/bin/env node
/**
 * Load a dotenv-style file into the environment, then run a command.
 * Usage: node scripts/run-with-env.mjs .env.local -- <cmd> [args...]
 *    or: node scripts/run-with-env.mjs .env.local pnpm --filter @anytimevibe/relay dev
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node scripts/run-with-env.mjs <env-file> [--] <command> [args...]");
  process.exit(1);
}

const envFileArg = args[0];
let cmdArgs = args.slice(1);
if (cmdArgs[0] === "--") cmdArgs = cmdArgs.slice(1);
if (!cmdArgs.length) {
  console.error("Missing command after env file.");
  process.exit(1);
}

const envPath = path.resolve(process.cwd(), envFileArg);
const env = { ...process.env };

if (existsSync(envPath)) {
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  console.log(`[run-with-env] loaded ${envPath}`);
} else {
  console.warn(`[run-with-env] env file not found: ${envPath} (continuing with process env)`);
}

const [command, ...rest] = cmdArgs;
const child = spawn(command, rest, {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
  windowsHide: false
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
