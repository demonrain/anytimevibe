import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, get, type RequestListener, type Server, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentUpdateConfiguration, registerAgentUpdateConfigRoute, registerUpdateRelayRoutes, type UpdateRelayOptions } from "./update-relay";

const apps: FastifyInstance[] = [];
const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function upstream(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function relay(options: Partial<UpdateRelayOptions> = {}): Promise<FastifyInstance> {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "av-update-relay-"));
  directories.push(cacheDir);
  const app = Fastify();
  apps.push(app);
  registerUpdateRelayRoutes(app, { publicOrigin: "https://vibe.example.com", cacheDir, ...options });
  await app.ready();
  return app;
}

describe("desktop update transport", () => {
  it("returns short-lived native proxy credentials only to an authenticated paired host", async () => {
    const app = Fastify(); apps.push(app);
    registerAgentUpdateConfigRoute(app, {
      publicOrigin: "https://vibe.example.com", proxyUrl: "https://updates.example.com:9443",
      proxyTokenSecret: "test-update-proxy-secret-with-at-least-32-characters"
    }, async (token) => token === "paired-host-token" ? "host-id" : null);
    const anonymous = await app.inject({ url: "/api/agent/config" });
    expect(anonymous.json().engineUpdateProxyUrl).toBeNull();
    const invalid = await app.inject({ url: "/api/agent/config", headers: { authorization: "Bearer invalid" } });
    expect(invalid.json().engineUpdateProxyUrl).toBeNull();
    const paired = await app.inject({ url: "/api/agent/config", headers: { authorization: "Bearer paired-host-token" } });
    const proxy = new URL(paired.json().engineUpdateProxyUrl);
    expect(proxy.origin).toBe("https://updates.example.com:9443");
    expect(proxy.username).toMatch(/^av-/);
    expect(proxy.password.length).toBeGreaterThan(30);
    expect(paired.headers["cache-control"]).toBe("private, no-store");
  });

  it("advertises an explicitly configured HTTPS transfer server and retains the generic feed for old clients", () => {
    expect(agentUpdateConfiguration({
      publicOrigin: "https://vibe.example.com", transferUrl: "https://updates.example.com/edge/",
      feedUrl: "https://github.com/demonrain/anytimevibe/releases/latest/download"
    })).toEqual({
      updateFeedUrl: "https://updates.example.com/edge/api/agent/update/",
      engineUpdateBaseUrl: "https://updates.example.com/edge/api/agent/engine/",
      npmRegistryUrl: "https://updates.example.com/edge/api/agent/npm/"
    });
    expect(() => agentUpdateConfiguration({ publicOrigin: "https://vibe.example.com", transferUrl: "http://45.205.27.168" })).toThrow();
  });

  it("rejects external URLs, traversal, encoded separators, and unrelated files without contacting upstream", async () => {
    const seen: string[] = [];
    const origin = await upstream((request, response) => { seen.push(request.url!); response.end("unreachable"); });
    const app = await relay({ feedUrl: `${origin}/releases/latest/download` });
    for (const suffix of ["https://evil.example/asset.exe", "//evil.example/asset.exe", "../latest.yml", "%2e%2e/latest.yml", "AnytimeVibe-Agent%2fSetup.exe", "AnytimeVibe-Agent%5cSetup.exe", "%252e%252e%252flatest.yml", "secret.txt"]) {
      const response = await app.inject({ url: `/api/agent/update/${suffix}` });
      // HTTP clients may normalize literal dot segments before the router sees them.
      expect([400, 404], suffix).toContain(response.statusCode);
    }
    expect(seen).toEqual([]);
  });

  it("forwards Range and conditional validators and supports HEAD without a body", async () => {
    const seen: Array<{ method: string; range: string | undefined; ifRange: string | undefined }> = [];
    const origin = await upstream((request, response) => {
      seen.push({ method: request.method!, range: request.headers.range, ifRange: request.headers["if-range"] as string | undefined });
      response.setHeader("etag", '"release-a"');
      response.setHeader("accept-ranges", "bytes");
      response.setHeader("cache-control", "public, max-age=60");
      if (request.headers["if-none-match"] === '"release-a"') { response.writeHead(304); response.end(); return; }
      if (request.headers.range) { response.writeHead(206, { "content-range": "bytes 1-3/6", "content-length": "3" }); response.end("bcd"); return; }
      response.writeHead(200, { "content-length": "6" }); response.end("abcdef");
    });
    const app = await relay({ feedUrl: `${origin}/feed` });
    const partial = await app.inject({ url: "/api/agent/update/AnytimeVibe-Agent-Setup.exe", headers: { range: "bytes=1-3", "if-range": '"release-a"' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe("bcd");
    expect(partial.headers["content-range"]).toBe("bytes 1-3/6");
    expect(partial.headers["x-anytimevibe-cache"]).toBe("BYPASS");
    expect(partial.headers["cache-control"]).toBe("public, max-age=60");
    const head = await app.inject({ method: "HEAD", url: "/api/agent/update/AnytimeVibe-Agent-Setup.exe" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe("6");
    const unchanged = await app.inject({ url: "/api/agent/update/latest.yml", headers: { "if-none-match": '"release-a"' } });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.headers.etag).toBe('"release-a"');
    expect(seen[0]).toEqual({ method: "GET", range: "bytes=1-3", ifRange: '"release-a"' });
    expect(seen[1]?.method).toBe("HEAD");
  });

  it("keeps an active stream alive after the upstream header deadline", async () => {
    const origin = await upstream((_request, response) => {
      response.writeHead(200); response.write("start");
      const timer = setTimeout(() => response.end("finish"), 180);
      response.on("close", () => clearTimeout(timer));
    });
    const app = await relay({ feedUrl: `${origin}/feed`, headersTimeoutMs: 80, idleTimeoutMs: 1000 });
    const response = await app.inject({ url: "/api/agent/update/AnytimeVibe-Agent-Setup.exe" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("startfinish");
  });

  it("cancels the upstream download when the desktop disconnects", async () => {
    let closed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => { closed = resolve; });
    const origin = await upstream((_request, response) => {
      response.writeHead(200); response.write("chunk");
      const timer = setInterval(() => response.write("chunk"), 20);
      response.on("close", () => { clearInterval(timer); closed(); });
    });
    const app = await relay({ feedUrl: `${origin}/feed` });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      const client = get(`${address}/api/agent/update/AnytimeVibe-Agent-Setup.exe`, (response) => {
        response.once("data", () => { response.destroy(); client.destroy(); resolve(); });
      });
      client.on("error", reject);
    });
    await Promise.race([upstreamClosed, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("upstream kept downloading")), 1500))]);
  });

  it("rejects redirects to an unapproved origin", async () => {
    const origin = await upstream((_request, response) => { response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }); response.end(); });
    const app = await relay({ feedUrl: `${origin}/feed` });
    const response = await app.inject({ url: "/api/agent/update/latest.yml" });
    expect(response.statusCode).toBe(502);
  });
});

function json(response: ServerResponse, value: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

describe("npm engine transport", () => {
  it("lets real npm install a scoped engine and its native dependency entirely from the transfer registry", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "av-npm-consumer-")); directories.push(fixture);
    const packages = new Map<string, { bytes: Buffer; integrity: string }>();
    for (const name of ["@openai/codex", "@openai/codex-win32-x64"]) {
      const directory = path.join(fixture, name.endsWith("-x64") ? "native" : "engine");
      await fs.mkdir(path.join(directory, "package"), { recursive: true });
      const optionalDependencies = name === "@openai/codex" ? { "@openai/codex-win32-x64": "1.0.0" } : {};
      await fs.writeFile(path.join(directory, "package", "package.json"), JSON.stringify({ name, version: "1.0.0", optionalDependencies }));
      const tarball = path.join(directory, "package.tgz");
      await promisify(execFile)("tar", ["-czf", tarball, "-C", directory, "package"]);
      const bytes = await fs.readFile(tarball);
      packages.set(name, { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` });
    }
    const downloaded: string[] = [];
    const origin = await upstream((request, response) => {
      const requested = decodeURIComponent(request.url!);
      const name = requested.replace(/^\//, "").split("/-/")[0]!;
      const artifact = packages.get(name);
      if (!artifact) { response.writeHead(404); response.end(); return; }
      if (requested.includes("/-/")) { downloaded.push(name); response.end(artifact.bytes); return; }
      json(response, { name, "dist-tags": { latest: "1.0.0" }, versions: {
        "1.0.0": { name, version: "1.0.0", optionalDependencies: name === "@openai/codex" ? { "@openai/codex-win32-x64": "1.0.0" } : {}, dist: { tarball: `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-1.0.0.tgz`, integrity: artifact.integrity } }
      } });
    });
    // Advertise the listening transfer origin; npm must never see the inaccessible public fixture hostname.
    const local = Fastify(); apps.push(local);
    const localPort = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
    });
    registerUpdateRelayRoutes(local, { publicOrigin: `http://127.0.0.1:${localPort}`, npmRegistryOrigin: origin, cacheDir: path.join(fixture, "cache") });
    await local.listen({ host: "127.0.0.1", port: localPort });
    const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", path.join(fixture, "installed"), "--cache", path.join(fixture, "npm-cache"), `--registry=http://127.0.0.1:${localPort}/api/agent/npm/`, "@openai/codex@1.0.0"];
    const executable = process.platform === "win32" ? process.execPath : "npm";
    const commandArgs = process.platform === "win32" ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...args] : args;
    await promisify(execFile)(executable, commandArgs, { timeout: 20_000, env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", ALL_PROXY: "", all_proxy: "", npm_config_proxy: "", npm_config_https_proxy: "" } });
    expect(JSON.parse(await fs.readFile(path.join(fixture, "installed", "node_modules", "@openai", "codex", "package.json"), "utf8")).name).toBe("@openai/codex");
    expect(JSON.parse(await fs.readFile(path.join(fixture, "installed", "node_modules", "@openai", "codex-win32-x64", "package.json"), "utf8")).version).toBe("1.0.0");
    expect(downloaded.sort()).toEqual(["@openai/codex", "@openai/codex-win32-x64"]);
  }, 30_000);

  it("rewrites official tarballs through the relay and admits only declared dependencies", async () => {
    const bytes = Buffer.from("official-package");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const seen: string[] = [];
    const origin = await upstream((request, response) => {
      seen.push(request.url!);
      if (request.url === "/@openai/codex") json(response, {
        name: "@openai/codex", "dist-tags": { latest: "1.2.3" }, versions: {
          "1.2.3": { name: "@openai/codex", version: "1.2.3", optionalDependencies: { "@openai/codex-win32-x64": "1.2.3" }, dist: { tarball: "https://registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz", integrity } }
        }
      });
      else if (request.url === "/@openai/codex-win32-x64") json(response, { name: "@openai/codex-win32-x64", "dist-tags": { latest: "1.2.3" }, versions: {} });
      else if (request.url === "/@openai/codex/-/codex-1.2.3.tgz") response.end(bytes);
      else { response.writeHead(404); response.end(); }
    });
    const app = await relay({ npmRegistryOrigin: origin });
    const metadata = await app.inject({ url: "/api/agent/npm/@openai%2fcodex" });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().versions["1.2.3"].dist).toEqual({ tarball: "https://vibe.example.com/api/agent/npm/@openai/codex/-/codex-1.2.3.tgz", integrity });
    const nativeMetadata = await app.inject({ url: "/api/agent/npm/@openai%2fcodex-win32-x64" });
    expect(nativeMetadata.statusCode).toBe(200);
    const tarball = await app.inject({ url: "/api/agent/npm/@openai/codex/-/codex-1.2.3.tgz" });
    expect(tarball.statusCode).toBe(200);
    expect(tarball.rawPayload).toEqual(bytes);
    const denied = await app.inject({ url: "/api/agent/npm/unrelated-package" });
    expect(denied.statusCode).toBe(403);
    expect(seen).not.toContain("/unrelated-package");
  });

  it("verifies integrity before serving and persists cache files across relay restarts", async () => {
    const bytes = Buffer.from("verified-cache-contents");
    let downloads = 0;
    const origin = await upstream((request, response) => {
      if (request.url === "/@openai/codex") json(response, {
        name: "@openai/codex", "dist-tags": { latest: "1.0.0" }, versions: {
          "1.0.0": { name: "@openai/codex", version: "1.0.0", dist: { tarball: "https://registry.npmjs.org/@openai/codex/-/codex-1.0.0.tgz", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } }
        }
      });
      else { downloads++; response.end(bytes); }
    });
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "av-npm-cache-"));
    directories.push(cacheDir);
    const first = await relay({ npmRegistryOrigin: origin, cacheDir });
    await first.inject({ url: "/api/agent/npm/@openai/codex" });
    expect((await first.inject({ url: "/api/agent/npm/@openai/codex/-/codex-1.0.0.tgz" })).headers["x-anytimevibe-cache"]).toBe("MISS");
    await first.close();
    const restarted = await relay({ npmRegistryOrigin: origin, cacheDir });
    const partial = await restarted.inject({ url: "/api/agent/npm/@openai/codex/-/codex-1.0.0.tgz", headers: { range: "bytes=0-7" } });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe("verified");
    expect(partial.headers["x-anytimevibe-cache"]).toBe("HIT");
    expect(downloads).toBe(1);
    const files = await fs.readdir(cacheDir);
    const artifact = files.find((file) => file.endsWith(".tgz"))!;
    await fs.writeFile(path.join(cacheDir, artifact), "corrupt");
    const repaired = await restarted.inject({ url: "/api/agent/npm/@openai/codex/-/codex-1.0.0.tgz" });
    expect(repaired.rawPayload).toEqual(bytes);
    expect(downloads).toBe(2);
  });

  it("restores the engine dependency closure so npm cached metadata can request a native tarball after restart", async () => {
    const bytes = Buffer.from("native-dependency");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const origin = await upstream((request, response) => {
      const name = request.url === "/@openai/codex" ? "@openai/codex" : "@openai/codex-win32-x64";
      if (request.url?.endsWith(".tgz")) { response.end(bytes); return; }
      const file = name === "@openai/codex" ? "codex" : "codex-win32-x64";
      json(response, { name, "dist-tags": { latest: "1.0.0" }, versions: {
        "1.0.0": { name, version: "1.0.0", optionalDependencies: name === "@openai/codex" ? { "@openai/codex-win32-x64": "1.0.0" } : {}, dist: { tarball: `https://registry.npmjs.org/${name}/-/${file}-1.0.0.tgz`, integrity } }
      } });
    });
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "av-npm-native-cache-"));
    directories.push(cacheDir);
    const first = await relay({ npmRegistryOrigin: origin, cacheDir });
    await first.inject({ url: "/api/agent/npm/@openai/codex" });
    await first.inject({ url: "/api/agent/npm/@openai/codex-win32-x64" });
    await first.close();
    const restarted = await relay({ npmRegistryOrigin: origin, cacheDir });
    const native = await restarted.inject({ url: "/api/agent/npm/@openai/codex-win32-x64/-/codex-win32-x64-1.0.0.tgz" });
    expect(native.statusCode).toBe(200);
    expect(native.rawPayload).toEqual(bytes);
  });

  it("refuses a tampered upstream package instead of serving or retaining it", async () => {
    const origin = await upstream((request, response) => {
      if (request.url === "/@openai/codex") json(response, { name: "@openai/codex", "dist-tags": { latest: "1.0.0" }, versions: {
        "1.0.0": { name: "@openai/codex", version: "1.0.0", dist: { tarball: "https://registry.npmjs.org/@openai/codex/-/codex-1.0.0.tgz", integrity: `sha512-${createHash("sha512").update("original").digest("base64")}` } }
      } });
      else response.end("tampered");
    });
    const app = await relay({ npmRegistryOrigin: origin });
    await app.inject({ url: "/api/agent/npm/@openai/codex" });
    const response = await app.inject({ url: "/api/agent/npm/@openai/codex/-/codex-1.0.0.tgz" });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("update_artifact_integrity");
  });
});
