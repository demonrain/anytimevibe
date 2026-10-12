import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { issueUpdateProxyUrl } from "./update-proxy.js";

export type UpdateRelayOptions = {
  publicOrigin: string;
  transferUrl?: string;
  feedUrl?: string;
  cacheDir?: string;
  npmRegistryOrigin?: string;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  allowedRedirectHosts?: string[];
};

const PREFIX = "/api/agent";
const ROOT_PACKAGES = [
  "@openai/codex", "@anthropic-ai/claude-code", "@xai-official/grok", "@earendil-works/pi-coding-agent",
  // The official Claude launcher repair may install its native platform package directly.
  ...["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl"].map((platform) => `@anthropic-ai/claude-code-${platform}`)
];
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_OR_TAG = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,150}$/;
const FILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,199}$/;
const FEED_FILE = /^(?:latest(?:-mac|-linux)?(?:-arm64|-x64)?\.ya?ml|AnytimeVibe-Agent(?:-Setup)?(?:[-_.][a-zA-Z0-9][a-zA-Z0-9._+-]*)?\.(?:exe|dmg|zip)(?:\.blockmap)?)$/;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const METADATA_TTL = 5 * 60_000;

class TransportError extends Error {
  constructor(readonly code: string, readonly status = 502) { super(code); }
}

function trustedUrl(value: string): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("Update transport requires HTTPS (HTTP is allowed only on loopback)");
  if (url.username || url.password || url.search || url.hash) throw new Error("Update transport URL must not contain credentials, query, or fragment");
  return url;
}

export function agentUpdateConfiguration(options: Pick<UpdateRelayOptions, "publicOrigin" | "transferUrl" | "feedUrl">): {
  updateFeedUrl: string | null; engineUpdateBaseUrl: string; npmRegistryUrl: string;
} {
  const origin = trustedUrl(options.transferUrl || options.publicOrigin).toString().replace(/\/+$/, "");
  return {
    updateFeedUrl: options.feedUrl ? `${origin}${PREFIX}/update/` : null,
    engineUpdateBaseUrl: `${origin}${PREFIX}/engine/`,
    npmRegistryUrl: `${origin}${PREFIX}/npm/`
  };
}

export function registerAgentUpdateConfigRoute(
  app: FastifyInstance,
  options: Pick<UpdateRelayOptions, "publicOrigin" | "transferUrl" | "feedUrl"> & { proxyUrl?: string; proxyTokenSecret?: string },
  authorizeAgent: (token: string) => Promise<string | null>
): void {
  const advertised = agentUpdateConfiguration(options);
  app.get(`${PREFIX}/config`, async (request, reply) => {
    let engineUpdateProxyUrl: string | null = null;
    if (options.proxyUrl && options.proxyTokenSecret) {
      const header = request.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (token && token.length <= 512) {
        const hostId = await authorizeAgent(token);
        if (hostId) engineUpdateProxyUrl = issueUpdateProxyUrl(options.proxyUrl, options.proxyTokenSecret, hostId);
      }
    }
    reply.header("cache-control", "private, no-store");
    return { ...advertised, engineUpdateProxyUrl };
  });
}

function rawSuffix(request: FastifyRequest, route: string): string {
  return (request.raw.url || request.url).split("?")[0]!.slice(route.length);
}

function safeFeedFile(value: string): string {
  if (!FILE_NAME.test(value) || value.includes("..") || !FEED_FILE.test(value)) throw new TransportError("invalid_update_path", 400);
  return value;
}

function parseNpmPath(raw: string): { packageName: string; version?: string; tarball?: string } {
  // npm encodes the one slash in a scoped name. All other encoded separators are rejected.
  const canonical = raw.replace(/^(@[a-z0-9][a-z0-9._-]*)%2f([a-z0-9][a-z0-9._-]*)(?=\/|$)/i, "$1/$2");
  if (canonical.includes("%") || canonical.includes("\\") || canonical.includes("..")) throw new TransportError("invalid_update_path", 400);
  const segments = canonical.split("/");
  const packageName = canonical.startsWith("@") ? segments.splice(0, 2).join("/") : segments.shift()!;
  if (!PACKAGE_NAME.test(packageName) || packageName.length > 214) throw new TransportError("invalid_update_path", 400);
  if (!segments.length) return { packageName };
  if (segments.length === 1 && VERSION_OR_TAG.test(segments[0]!)) return { packageName, version: segments[0]! };
  if (segments.length === 2 && segments[0] === "-" && FILE_NAME.test(segments[1]!) && segments[1]!.endsWith(".tgz")) return { packageName, tarball: segments[1]! };
  throw new TransportError("invalid_update_path", 400);
}

type Transfer = {
  controller: AbortController;
  response: Response;
  body(): Readable;
  finish(): void;
};

async function openUpstream(target: URL, request: FastifyRequest, reply: FastifyReply, options: UpdateRelayOptions, method = request.method, extraHeaders: Record<string, string> = {}): Promise<Transfer> {
  const controller = new AbortController();
  const headers: Record<string, string> = { "user-agent": "AnytimeVibe-Update-Relay", "accept-encoding": "identity", ...extraHeaders };
  for (const name of ["range", "if-range", "if-none-match", "if-modified-since", "accept"]) {
    const value = request.headers[name];
    if (typeof value === "string" && value) headers[name] = value;
  }
  const disconnect = () => { if (!reply.raw.writableFinished) controller.abort(); };
  request.raw.once("aborted", disconnect);
  reply.raw.once("close", disconnect);
  let timer = setTimeout(() => controller.abort(), options.headersTimeoutMs ?? 30_000);
  timer.unref();
  const resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), options.idleTimeoutMs ?? 60_000);
    timer.unref();
  };
  const finish = () => {
    clearTimeout(timer);
    request.raw.off("aborted", disconnect);
    reply.raw.off("close", disconnect);
  };
  const approvedHosts = new Set([
    target.hostname, "github.com", "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
    ...(options.allowedRedirectHosts ?? [])
  ]);
  try {
    let current = target;
    let response!: Response;
    for (let count = 0; count <= 5; count++) {
      response = await fetch(current, { method, headers, redirect: "manual", signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || count === 5) throw new TransportError("update_redirect_rejected");
      const next = new URL(location, current);
      if (next.username || next.password || !approvedHosts.has(next.hostname) || (next.origin !== target.origin && next.protocol !== "https:")) throw new TransportError("update_redirect_rejected");
      current = next;
    }
    // The header timeout does not cap the lifetime of a healthy large-file stream.
    resetIdle();
    return {
      controller, response, finish,
      body() {
        if (!response.body) throw new TransportError("update_empty_body");
        const source = Readable.fromWeb(response.body as unknown as ReadableStream);
        const activity = new Transform({ transform(chunk: Buffer, _encoding, done) { resetIdle(); done(null, chunk); } });
        source.on("error", (error) => activity.destroy(error));
        activity.on("close", () => { if (!source.readableEnded) { controller.abort(); source.destroy(); } });
        return source.pipe(activity);
      }
    };
  } catch (error) { finish(); controller.abort(); throw error; }
}

function upstreamHeaders(response: Response, reply: FastifyReply): void {
  const compressed = response.headers.get("content-encoding");
  for (const name of ["content-type", "content-length", "content-range", "etag", "last-modified", "accept-ranges", "cache-control"]) {
    if (name === "content-length" && compressed && compressed !== "identity") continue;
    const value = response.headers.get(name);
    if (value) reply.header(name, value);
  }
  reply.header("x-anytimevibe-cache", "BYPASS");
  if (!response.headers.has("cache-control")) reply.header("cache-control", "no-cache");
}

async function streamUpstream(target: URL, request: FastifyRequest, reply: FastifyReply, options: UpdateRelayOptions): Promise<FastifyReply> {
  const transfer = await openUpstream(target, request, reply, options);
  upstreamHeaders(transfer.response, reply);
  reply.code(transfer.response.status);
  if (request.method === "HEAD" || [204, 304].includes(transfer.response.status) || !transfer.response.body) {
    await transfer.response.body?.cancel(); transfer.finish();
    return reply.send();
  }
  const stream = transfer.body();
  stream.once("close", transfer.finish);
  return reply.send(stream);
}

type Integrity = { algorithm: "sha512" | "sha256" | "sha1"; digest: Buffer; label: string };
function packageIntegrity(dist: Record<string, unknown>): Integrity {
  if (typeof dist.integrity === "string") {
    for (const algorithm of ["sha512", "sha256", "sha1"] as const) {
      const item = dist.integrity.split(/\s+/).find((part) => part.startsWith(`${algorithm}-`));
      if (!item) continue;
      const digest = Buffer.from(item.slice(algorithm.length + 1).split("?")[0]!, "base64");
      if (digest.length === { sha512: 64, sha256: 32, sha1: 20 }[algorithm]) return { algorithm, digest, label: `${algorithm}-${digest.toString("base64")}` };
    }
  }
  if (typeof dist.shasum === "string" && /^[a-f0-9]{40}$/i.test(dist.shasum)) return { algorithm: "sha1", digest: Buffer.from(dist.shasum, "hex"), label: `sha1-${dist.shasum}` };
  throw new TransportError("update_artifact_missing_integrity");
}

type Artifact = { upstream: URL; integrity: Integrity };
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

async function boundedBody(transfer: Transfer, limit: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of transfer.body()) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > limit) { transfer.controller.abort(); throw new TransportError("update_metadata_too_large"); }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally { transfer.finish(); }
}

async function verifiedFile(file: string, integrity: Integrity): Promise<boolean> {
  try {
    const hash = createHash(integrity.algorithm);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return timingSafeEqual(hash.digest(), integrity.digest);
  } catch { return false; }
}

async function cacheArtifact(artifact: Artifact, file: string, request: FastifyRequest, reply: FastifyReply, options: UpdateRelayOptions): Promise<"HIT" | "MISS"> {
  if (await verifiedFile(file, artifact.integrity)) return "HIT";
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.part`;
  // Range applies to the verified local file. Upstream must deliver the entire tarball.
  const cleanRequest = { ...request, headers: { ...request.headers } } as FastifyRequest;
  for (const name of ["range", "if-range", "if-none-match", "if-modified-since"]) delete cleanRequest.headers[name];
  const transfer = await openUpstream(artifact.upstream, cleanRequest, reply, options, "GET");
  try {
    if (transfer.response.status !== 200) throw new TransportError("update_artifact_upstream");
    const hash = createHash(artifact.integrity.algorithm);
    let size = 0;
    const validate = new Transform({ transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) { done(new TransportError("update_artifact_too_large")); return; }
      hash.update(chunk); done(null, chunk);
    } });
    await pipeline(transfer.body(), validate, createWriteStream(temporary, { flags: "wx" }));
    if (!timingSafeEqual(hash.digest(), artifact.integrity.digest)) throw new TransportError("update_artifact_integrity");
    await fs.rename(temporary, file);
    return "MISS";
  } finally {
    transfer.controller.abort(); transfer.finish();
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function serveArtifact(file: string, artifact: Artifact, cache: "HIT" | "MISS", request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { size, mtime } = await fs.stat(file);
  const etag = `"${artifact.integrity.label}"`;
  reply.header("etag", etag).header("last-modified", mtime.toUTCString()).header("accept-ranges", "bytes")
    .header("cache-control", "public, max-age=31536000, immutable").header("x-anytimevibe-cache", cache).header("content-type", "application/octet-stream");
  if (request.headers["if-none-match"]?.split(/\s*,\s*/).includes(etag)) return reply.code(304).send();
  let start = 0;
  let end = size - 1;
  const range = request.headers.range;
  const ifRange = request.headers["if-range"];
  if (range && (!ifRange || ifRange === etag || ifRange === mtime.toUTCString())) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) return reply.header("content-range", `bytes */${size}`).code(416).send();
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return reply.header("content-range", `bytes */${size}`).code(416).send();
    reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`);
  }
  reply.header("content-length", end - start + 1);
  if (request.method === "HEAD") return reply.send();
  return reply.send(createReadStream(file, { start, end }));
}

export function registerUpdateRelayRoutes(app: FastifyInstance, options: UpdateRelayOptions): void {
  const advertised = agentUpdateConfiguration(options);
  const feed = options.feedUrl ? trustedUrl(options.feedUrl) : null;
  const registry = trustedUrl(options.npmRegistryOrigin || "https://registry.npmjs.org");
  registry.pathname = `${registry.pathname.replace(/\/+$/, "")}/`;
  const cacheDir = path.resolve(options.cacheDir || "apps/relay/data/update-cache");
  const allowedPackages = new Set(ROOT_PACKAGES);
  const artifacts = new Map<string, Artifact>();
  const metadata = new Map<string, { value: Record<string, unknown>; expires: number }>();
  const metadataFile = (name: string) => path.join(cacheDir, `metadata-${createHash("sha256").update(`${registry}|${name}`).digest("hex")}.json`);

  function rewriteVersion(version: Record<string, unknown>, packageName: string): void {
    for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = version[key];
      if (!isRecord(deps)) continue;
      for (const [name, range] of Object.entries(deps)) {
        if (!PACKAGE_NAME.test(name) || typeof range !== "string") continue;
        if (allowedPackages.size >= 4096 && !allowedPackages.has(name)) throw new TransportError("update_dependency_limit");
        allowedPackages.add(name);
        const alias = range.match(/^npm:((?:@[^/]+\/)?[^@]+)@/);
        if (alias && PACKAGE_NAME.test(alias[1]!)) allowedPackages.add(alias[1]!);
      }
    }
    if (!isRecord(version.dist) || typeof version.dist.tarball !== "string") return;
    const original = new URL(version.dist.tarball);
    const expectedPrefix = `/${packageName}/-/`;
    // Only the registry's package tarball path can become a downloadable artifact.
    const registryPrefix = `${registry.pathname}${packageName}/-/`;
    const validHost = [registry.hostname, "registry.npmjs.org", "registry.npmmirror.com"].includes(original.hostname);
    const prefix = original.pathname.startsWith(registryPrefix) ? registryPrefix : expectedPrefix;
    const file = original.pathname.slice(prefix.length);
    if (!validHost || !["https:", ...(original.origin === registry.origin ? [registry.protocol] : [])].includes(original.protocol) || !original.pathname.startsWith(prefix) || !FILE_NAME.test(file) || file.includes("..") || !file.endsWith(".tgz") || original.search || original.hash || original.username || original.password) throw new TransportError("update_artifact_url_rejected");
    const key = `${packageName}/-/${file}`;
    artifacts.set(key, { upstream: new URL(key, registry), integrity: packageIntegrity(version.dist) });
    version.dist.tarball = `${advertised.npmRegistryUrl}${key}`;
  }

  async function packageMetadata(packageName: string, request: FastifyRequest, reply: FastifyReply): Promise<{ value: Record<string, unknown>; cache: "HIT" | "MISS" }> {
    const stored = metadata.get(packageName);
    if (stored && stored.expires > Date.now()) return { value: structuredClone(stored.value), cache: "HIT" };
    const cleanRequest = { ...request, headers: { ...request.headers } } as FastifyRequest;
    for (const name of ["range", "if-range", "if-none-match", "if-modified-since"]) delete cleanRequest.headers[name];
    const transfer = await openUpstream(new URL(packageName, registry), cleanRequest, reply, options, "GET", { accept: "application/json" });
    if (transfer.response.status !== 200) { await transfer.response.body?.cancel(); transfer.finish(); throw new TransportError("update_metadata_upstream", transfer.response.status); }
    const value: unknown = JSON.parse((await boundedBody(transfer, MAX_METADATA_BYTES)).toString("utf8"));
    if (!isRecord(value) || value.name !== packageName || !isRecord(value.versions)) throw new TransportError("invalid_update_metadata");
    const expires = Date.now() + METADATA_TTL;
    await fs.mkdir(cacheDir, { recursive: true });
    const file = metadataFile(packageName);
    const temporary = `${file}.${randomUUID()}.part`;
    try {
      // Preserve official metadata, then rewrite a separate in-memory copy for this public host.
      await fs.writeFile(temporary, JSON.stringify({ registry: registry.toString(), packageName, expires, value }), { flag: "wx" });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    for (const version of Object.values(value.versions)) if (isRecord(version)) rewriteVersion(version, packageName);
    metadata.set(packageName, { value, expires });
    return { value: structuredClone(value), cache: "MISS" };
  }

  app.addHook("onReady", async () => {
    await fs.mkdir(cacheDir, { recursive: true });
    const records = new Map<string, { value: Record<string, unknown>; expires: number }>();
    for (const file of (await fs.readdir(cacheDir)).filter((name) => /^metadata-[a-f0-9]{64}\.json$/.test(name)).slice(0, 4096)) {
      try {
        const absolute = path.join(cacheDir, file);
        if ((await fs.stat(absolute)).size > MAX_METADATA_BYTES) continue;
        const stored: unknown = JSON.parse(await fs.readFile(absolute, "utf8"));
        if (!isRecord(stored) || stored.registry !== registry.toString() || typeof stored.packageName !== "string" || !PACKAGE_NAME.test(stored.packageName) || !isRecord(stored.value) || stored.value.name !== stored.packageName || !isRecord(stored.value.versions) || typeof stored.expires !== "number") continue;
        records.set(stored.packageName, { value: stored.value, expires: stored.expires });
      } catch { /* An incomplete metadata file is fetched again on demand. */ }
    }
    // Rebuild only the closure rooted in official engines; disk files cannot grant arbitrary packages.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [name, stored] of records) {
        if (!allowedPackages.has(name)) continue;
        records.delete(name);
        try {
          for (const version of Object.values(stored.value.versions as Record<string, unknown>)) if (isRecord(version)) rewriteVersion(version, name);
          if (stored.expires > Date.now()) metadata.set(name, stored);
          expanded = true;
        } catch { /* Invalid persisted metadata never authorizes an artifact. */ }
      }
    }
  });

  const failure = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    app.log.warn({ error, path: request.url }, "update transport failed");
    if (!reply.sent && !reply.raw.destroyed) return reply.code(error instanceof TransportError ? error.status : 502).send({ error: error instanceof TransportError ? error.code : "update_upstream_unreachable" });
    return reply;
  };
  app.route({ method: ["GET", "HEAD"], url: `${PREFIX}/update/*`, async handler(request, reply) {
    try {
      const file = safeFeedFile(rawSuffix(request, `${PREFIX}/update/`));
      if (!feed) return reply.code(404).send({ error: "update_feed_not_configured" });
      const target = new URL(`${feed.toString().replace(/\/+$/, "")}/${file}`);
      return await streamUpstream(target, request, reply, options);
    } catch (error) { return failure(request, reply, error); }
  } });

  app.route({ method: ["GET", "HEAD"], url: `${PREFIX}/engine/*`, async handler(request, reply) {
    try {
      const suffix = rawSuffix(request, `${PREFIX}/engine/`);
      let target: URL;
      if (suffix === "cursor/install") {
        const query = new URL(request.url, options.publicOrigin).searchParams;
        if ([...query.keys()].some((key) => key !== "win32") || (query.has("win32") && query.get("win32") !== "true")) throw new TransportError("invalid_update_path", 400);
        target = new URL(`https://cursor.com/install${query.has("win32") ? "?win32=true" : ""}`);
      } else if (suffix === "antigravity/releases/latest") target = new URL("https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest");
      else throw new TransportError("invalid_update_path", 400);
      return await streamUpstream(target, request, reply, options);
    } catch (error) { return failure(request, reply, error); }
  } });

  app.route({ method: ["GET", "HEAD"], url: `${PREFIX}/npm/*`, async handler(request, reply) {
    try {
      const parsed = parseNpmPath(rawSuffix(request, `${PREFIX}/npm/`));
      if (!allowedPackages.has(parsed.packageName)) throw new TransportError("update_package_not_allowed", 403);
      if (parsed.tarball) {
        const key = `${parsed.packageName}/-/${parsed.tarball}`;
        if (!artifacts.has(key)) await packageMetadata(parsed.packageName, request, reply);
        const artifact = artifacts.get(key);
        if (!artifact) throw new TransportError("update_artifact_not_found", 404);
        const file = path.join(cacheDir, `${createHash("sha256").update(`${artifact.upstream}|${artifact.integrity.label}`).digest("hex")}.tgz`);
        const cache = await cacheArtifact(artifact, file, request, reply, options);
        return await serveArtifact(file, artifact, cache, request, reply);
      }
      const result = await packageMetadata(parsed.packageName, request, reply);
      let value = result.value;
      if (parsed.version) {
        const tags = isRecord(value["dist-tags"]) ? value["dist-tags"] : {};
        const version = typeof tags[parsed.version] === "string" ? tags[parsed.version] as string : parsed.version;
        const item = (value.versions as Record<string, unknown>)[version];
        if (!isRecord(item)) throw new TransportError("update_version_not_found", 404);
        value = item;
      }
      const body = JSON.stringify(value);
      const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
      reply.header("etag", etag).header("cache-control", "public, max-age=300").header("x-anytimevibe-cache", result.cache);
      if (request.headers["if-none-match"] === etag) return reply.code(304).send();
      reply.header("content-type", "application/json").header("content-length", Buffer.byteLength(body));
      return reply.send(request.method === "HEAD" ? undefined : body);
    } catch (error) { return failure(request, reply, error); }
  } });
}
