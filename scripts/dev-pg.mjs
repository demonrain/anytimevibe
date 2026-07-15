#!/usr/bin/env node
/**
 * Start a local Postgres for AnytimeVibe development without Docker Desktop.
 *
 * Strategy (first match wins):
 * 1) If DATABASE_URL / 127.0.0.1:5432 already answers → do nothing (use it)
 * 2) If Docker engine is healthy → docker compose -f docker-compose.dev.yml up -d
 * 3) If embedded-postgres is available and process is NOT elevated admin → embedded cluster
 * 4) Otherwise print Windows guidance (WSL/Docker fix or winget PostgreSQL)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envLocal = path.join(root, ".env.local");
const mode = (process.argv[2] || process.env.DEV_DB || "auto").toLowerCase();

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const raw of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function parseHostPort(databaseUrl) {
  try {
    const u = new URL(databaseUrl);
    return { host: u.hostname || "127.0.0.1", port: Number(u.port || 5432) };
  } catch {
    return { host: "127.0.0.1", port: 5432 };
  }
}

function canConnect(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function isElevatedAdminWindows() {
  if (process.platform !== "win32") return false;
  const whoami = spawnSync("whoami", ["/groups"], { encoding: "utf8", shell: true });
  const text = `${whoami.stdout || ""}\n${whoami.stderr || ""}`;
  // S-1-5-32-544 = Administrators; elevated tokens usually include high mandatory level
  return /S-1-5-32-544/.test(text) && /S-1-16-12288|High Mandatory Level|高强制/i.test(text);
}

function dockerHealthy() {
  const result = spawnSync("docker", ["info"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 8000
  });
  return result.status === 0;
}

async function startDockerCompose() {
  console.log("[dev-pg] Starting Postgres via Docker Compose...");
  const up = spawnSync("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "-d"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (up.status !== 0) throw new Error("docker compose up failed");
  for (let i = 0; i < 40; i += 1) {
    const ready = spawnSync(
      "docker",
      ["compose", "-f", "docker-compose.dev.yml", "exec", "-T", "postgres", "pg_isready", "-U", "anytimevibe", "-d", "anytimevibe"],
      { cwd: root, shell: process.platform === "win32", encoding: "utf8" }
    );
    if (ready.status === 0) {
      console.log("[dev-pg] Docker Postgres is ready on 127.0.0.1:5432");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Docker Postgres did not become ready");
}

async function startEmbedded() {
  if (isElevatedAdminWindows()) {
    throw new Error(
      "Embedded Postgres cannot run as Windows Administrator (PostgreSQL security policy).\n"
      + "  Fix options:\n"
      + "  1) Open a normal (non-admin) terminal and run: pnpm dev:pg\n"
      + "  2) Install native PostgreSQL: winget install PostgreSQL.PostgreSQL.16\n"
      + "  3) Repair Docker/WSL (see docs/LOCAL_DEV.md)"
    );
  }
  console.log("[dev-pg] Starting embedded Postgres (no Docker)...");
  // Ensure platform package post-install symlinks exist (pnpm may skip lifecycle scripts).
  try {
    const hydrate = path.join(
      root,
      "node_modules",
      ".pnpm",
      "@embedded-postgres+windows-x64@18.1.0-beta.15",
      "node_modules",
      "@embedded-postgres",
      "windows-x64",
      "scripts",
      "hydrate-symlinks.js"
    );
    if (existsSync(hydrate)) spawnSync(process.execPath, [hydrate], { cwd: root, stdio: "ignore" });
  } catch {
    // ignore
  }

  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dataDir = path.join(root, ".local", "pg-data");
  mkdirSync(dataDir, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "anytimevibe",
    password: "anytimevibe_dev",
    port: 5432,
    persistent: true
  });
  await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("anytimevibe");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) console.warn("[dev-pg] createDatabase:", message);
  }
  console.log("[dev-pg] Embedded Postgres is ready on 127.0.0.1:5432");
  console.log("[dev-pg] Keep this process running while you use pnpm dev:relay / dev:stack");
  console.log("[dev-pg] Ctrl+C to stop\n");

  const shutdown = async () => {
    try {
      await pg.stop();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep alive
  await new Promise(() => undefined);
}

function printDockerStuckHelp() {
  console.log(`
Docker Desktop stuck on "Starting the Docker Engine" is usually a WSL problem.

Diagnosed on this machine earlier:
  - com.docker.service was Stopped
  - WSL distros "docker-desktop" and "Ubuntu" were Stopped / hang on start

Try these in order (PowerShell as Administrator for 1–4):

  1) wsl --shutdown
  2) net stop LxssManager & net start LxssManager
  3) wsl --update
  4) Restart PC, then open Docker Desktop once

If WSL still hangs:
  - Settings → Apps → Docker Desktop → Repair
  - Or: wsl --unregister docker-desktop
    then reinstall Docker Desktop

Without Docker (recommended here):

  A) Use embedded Postgres in a NON-admin terminal:
       pnpm dev:pg

  B) Install native PostgreSQL service (works under admin):
       winget install -e --id PostgreSQL.PostgreSQL.16
     Then create role/db (psql as postgres superuser):

       CREATE USER anytimevibe WITH PASSWORD 'anytimevibe_dev' CREATEDB;
       CREATE DATABASE anytimevibe OWNER anytimevibe;

     DATABASE_URL in .env.local:
       postgres://anytimevibe:anytimevibe_dev@127.0.0.1:5432/anytimevibe

Docs: docs/LOCAL_DEV.md
`);
}

async function main() {
  const fileEnv = loadEnvFile(envLocal);
  const databaseUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL
    || "postgres://anytimevibe:anytimevibe_dev@127.0.0.1:5432/anytimevibe";
  const { host, port } = parseHostPort(databaseUrl);

  if (await canConnect(host, port)) {
    console.log(`[dev-pg] Postgres already accepting connections at ${host}:${port}`);
    return;
  }

  // ensure = non-blocking bootstrap check (docker or already-up only)
  if (mode === "ensure") {
    if (dockerHealthy()) {
      await startDockerCompose();
      return;
    }
    console.warn("[dev-pg] No Postgres on port and Docker is unhealthy.");
    process.exit(2);
  }

  if (mode === "docker") {
    if (!dockerHealthy()) {
      printDockerStuckHelp();
      process.exit(1);
    }
    await startDockerCompose();
    return;
  }

  if (mode === "embedded") {
    await startEmbedded();
    return;
  }

  // auto (default for `pnpm dev:pg`): docker if possible, else embedded (keeps process alive)
  if (dockerHealthy()) {
    await startDockerCompose();
    return;
  }

  console.warn("[dev-pg] Docker engine is not healthy — skipping Docker.");
  try {
    await startEmbedded();
  } catch (error) {
    console.error(`\n[dev-pg] ${error instanceof Error ? error.message : error}`);
    printDockerStuckHelp();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
