import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTlsServer, type ServerOptions as TlsOptions } from "node:https";
import { connect, isIP, type Socket } from "node:net";

const CREDENTIAL_LIFETIME_MS = 15 * 60_000;
/** Exact vendor hosts; encrypted CONNECT cannot distinguish URLs on a permitted host. */
const UPDATE_HOSTS = new Set([
  "cursor.com", "downloads.cursor.com", "claude.ai", "claude.com", "downloads.claude.ai", "storage.googleapis.com",
  "x.ai", "downloads.x.ai", "static.x.ai", "antigravity.google", "github.com", "api.github.com",
  "objects.githubusercontent.com", "release-assets.githubusercontent.com", "registry.npmjs.org", "registry.npmmirror.com"
]);

function requireSecret(secret: string): void { if (secret.length < 32) throw new Error("UPDATE_PROXY_TOKEN_SECRET must contain at least 32 characters"); }
function signature(username: string, secret: string): string { return createHmac("sha256", secret).update(username).digest("base64url"); }

export function issueUpdateProxyUrl(baseUrl: string, secret: string, hostId: string, now = Date.now()): string {
  requireSecret(secret);
  const url = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("The update proxy must use HTTPS outside loopback");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("UPDATE_PROXY_URL must be a credential-free proxy origin");
  const expiry = Math.floor((now + CREDENTIAL_LIFETIME_MS) / 1000);
  const owner = createHash("sha256").update(hostId).digest("hex").slice(0, 16);
  url.username = `av-${expiry}-${owner}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  url.password = signature(url.username, secret);
  return url.toString();
}

export function verifyUpdateProxyAuthorization(header: string | undefined, secret: string, now = Date.now()): string | null {
  if (!header?.startsWith("Basic ") || header.length > 512 || secret.length < 32) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const match = decoded.match(/^(av-(\d{10})-[a-f0-9]{16}-[a-f0-9]{12}):([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  const remaining = Number(match[2]) * 1000 - now;
  if (remaining <= 0 || remaining > CREDENTIAL_LIFETIME_MS + 60_000) return null;
  const supplied = Buffer.from(match[3]!);
  const expected = Buffer.from(signature(match[1]!, secret));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? match[1]! : null;
}

export function isPublicUpdateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 192 && b === 2) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (version !== 6) return false;
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPublicUpdateAddress(lower.slice(7));
  // Global unicast only; exclude documentation, transition, and embedded-address ranges.
  return /^[23][0-9a-f]{3}:/.test(lower) && !/^(?:2001:(?:db8|0):|2002:)/.test(lower);
}

async function connectPublicHost(hostname: string, port: number): Promise<Socket> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicUpdateAddress(item.address))) throw new Error("private_update_target");
  const first = addresses[0]!;
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: first.address, family: first.family, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("update_proxy_connect_timeout")); }, 15_000);
    timer.unref();
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
  });
}

export type UpdateProxyOptions = {
  secret: string;
  tls?: TlsOptions;
  /** Network connector injection supports deployments with a controlled egress gateway. */
  connector?: (hostname: string, port: number) => Promise<Socket>;
};

export function createUpdateProxyServer(options: UpdateProxyOptions): Server {
  requireSecret(options.secret);
  const handler: Parameters<typeof createServer>[1] = (request, response) => {
    if (request.method === "GET" && request.url === "/health") { response.setHeader("content-type", "application/json"); response.end('{"ok":true}'); return; }
    response.writeHead(405); response.end("CONNECT required");
  };
  const server: Server = options.tls ? createTlsServer(options.tls, handler) : createServer(handler);
  const activeByCredential = new Map<string, number>();
  const activeByAddress = new Map<string, number>();
  const attempts = new Map<string, { start: number; count: number }>();
  const liveSockets = new Set<Socket>();
  let active = 0;
  server.on("connect", (request, duplex, head) => {
    const client = duplex as Socket;
    const deny = (code: number, message: string) => { client.end(`HTTP/1.1 ${code} ${message}\r\n${code === 407 ? 'Proxy-Authenticate: Basic realm="AnytimeVibe updates"\r\n' : ""}Connection: close\r\nContent-Length: 0\r\n\r\n`); };
    const ip = client.remoteAddress || "unknown";
    const now = Date.now();
    const previous = attempts.get(ip);
    const count = previous && now - previous.start < 60_000 ? previous.count + 1 : 1;
    attempts.set(ip, { start: count === 1 ? now : previous!.start, count });
    if (attempts.size > 10_000) for (const [key, value] of attempts) if (now - value.start >= 60_000) attempts.delete(key);
    if (count > 120) { deny(429, "Too Many Requests"); return; }
    const authorization = request.headers["proxy-authorization"];
    const credential = verifyUpdateProxyAuthorization(typeof authorization === "string" ? authorization : undefined, options.secret, now);
    if (!credential) { deny(407, "Proxy Authentication Required"); return; }
    const match = request.url?.match(/^([a-z0-9.-]+):443$/i);
    const hostname = match?.[1]?.toLowerCase();
    if (!hostname || !UPDATE_HOSTS.has(hostname) || isIP(hostname)) { deny(403, "Forbidden"); return; }
    if (active >= 192 || (activeByAddress.get(ip) || 0) >= 16 || (activeByCredential.get(credential) || 0) >= 8) { deny(429, "Too Many Requests"); return; }
    active++; activeByAddress.set(ip, (activeByAddress.get(ip) || 0) + 1); activeByCredential.set(credential, (activeByCredential.get(credential) || 0) + 1);
    liveSockets.add(client);
    let target: Socket | undefined;
    const lifetime = setTimeout(() => client.destroy(), 30 * 60_000); lifetime.unref();
    client.once("close", () => {
      clearTimeout(lifetime); target?.destroy(); liveSockets.delete(client); active--;
      const addressCount = (activeByAddress.get(ip) || 1) - 1;
      const credentialCount = (activeByCredential.get(credential) || 1) - 1;
      if (addressCount) activeByAddress.set(ip, addressCount); else activeByAddress.delete(ip);
      if (credentialCount) activeByCredential.set(credential, credentialCount); else activeByCredential.delete(credential);
    });
    client.on("error", () => target?.destroy());
    client.setTimeout(60_000, () => client.destroy());
    void (options.connector || connectPublicHost)(hostname, 443).then((socket) => {
      target = socket;
      if (client.destroyed) { socket.destroy(); return; }
      socket.on("error", () => client.destroy());
      socket.on("close", () => client.destroy());
      socket.setTimeout(60_000, () => socket.destroy());
      let bytes = head.length;
      const limit = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024 * 1024) client.destroy(); };
      client.on("data", limit); socket.on("data", limit);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.write(head);
      client.pipe(socket); socket.pipe(client);
    }, () => { if (!client.destroyed) deny(502, "Bad Gateway"); });
  });
  server.on("close", () => { for (const socket of liveSockets) socket.destroy(); });
  return server;
}
