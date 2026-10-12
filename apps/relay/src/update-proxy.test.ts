import { afterEach, describe, expect, it } from "vitest";
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from "node:net";
import type { Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { createUpdateProxyServer, isPublicUpdateAddress, issueUpdateProxyUrl, verifyUpdateProxyAuthorization } from "./update-proxy";

const SECRET = "test-update-proxy-secret-with-at-least-32-characters";
const servers: Array<Server | TcpServer> = [];
const clients: Socket[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const socket of clients.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
async function listen(server: Server | TcpServer): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
function auth(url: string): string {
  const parsed = new URL(url);
  return `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")}`;
}
async function request(port: number, target: string, authorization?: string, body = ""): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1"); clients.push(socket);
    let reply = "";
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n${body}`));
    socket.on("data", (chunk) => {
      reply += chunk.toString();
      if (reply.includes("\r\n\r\n") && (!reply.startsWith("HTTP/1.1 200") || reply.includes("echo:hello"))) { socket.destroy(); resolve(reply); }
    });
    socket.on("error", reject);
  });
}

describe("maintenance-only authenticated CONNECT proxy", () => {
  it("issues short-lived signed credentials and rejects expiry or forged credentials", () => {
    const url = issueUpdateProxyUrl("https://updates.example.com:9443", SECRET, "host-id", 1_700_000_000_000);
    expect(verifyUpdateProxyAuthorization(auth(url), SECRET, 1_700_000_100_000)).toBeTruthy();
    expect(verifyUpdateProxyAuthorization(auth(url), SECRET, 1_700_001_000_000)).toBeNull();
    expect(verifyUpdateProxyAuthorization(auth(url), "a-different-secret-with-at-least-32-characters", 1_700_000_100_000)).toBeNull();
    expect(() => issueUpdateProxyUrl("http://45.205.27.168:8080", SECRET, "host-id")).toThrow();
  });

  it("requires proxy authentication and denies arbitrary hosts, IP targets, and non-HTTPS ports", async () => {
    const port = await listen(createUpdateProxyServer({ secret: SECRET }));
    expect(await request(port, "downloads.cursor.com:443")).toContain("407 Proxy Authentication Required");
    const authorization = auth(issueUpdateProxyUrl("https://updates.example.com:9443", SECRET, "host-id"));
    for (const target of ["evil.example.com:443", "127.0.0.1:443", "169.254.169.254:443", "downloads.cursor.com:80", "downloads.cursor.com:443@evil.example.com", "downloads.cursor.com.evil.example.com:443"]) {
      expect(await request(port, target, authorization), target).toContain("403 Forbidden");
    }
  });

  it("tunnels an allowed vendor connection and preserves CONNECT head bytes", async () => {
    const origin = createTcpServer((socket) => socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`)));
    const upstreamPort = await listen(origin);
    const proxy = createUpdateProxyServer({ secret: SECRET, connector: async (_host, _port) => {
      const socket = connect(upstreamPort, "127.0.0.1"); clients.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      return socket;
    } });
    const port = await listen(proxy);
    const authorization = auth(issueUpdateProxyUrl("https://updates.example.com:9443", SECRET, "host-id"));
    const response = await request(port, "downloads.cursor.com:443", authorization, "hello");
    expect(response).toContain("200 Connection Established");
    expect(response).toContain("echo:hello");
  });

  it("lets real curl download through an authenticated HTTPS proxy while verifying both TLS certificates", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "av-proxy-tls-")); directories.push(directory);
    const certificateFile = path.join(directory, "cert.pem");
    const keyFile = path.join(directory, "key.pem");
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,DNS:downloads.cursor.com", "-keyout", keyFile, "-out", certificateFile], { timeout: 10_000 });
    const tls = { cert: await fs.readFile(certificateFile), key: await fs.readFile(keyFile) };
    const origin = createHttpsServer(tls, (request, response) => { response.end(request.url === "/installer" ? "official-download" : "wrong-path"); });
    const originPort = await listen(origin);
    const proxy = createUpdateProxyServer({ secret: SECRET, tls, connector: async () => {
      const socket = connect(originPort, "127.0.0.1"); clients.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      return socket;
    } });
    const port = await listen(proxy);
    const proxyUrl = issueUpdateProxyUrl(`https://localhost:${port}`, SECRET, "host-id");
    const { stdout } = await promisify(execFile)(process.platform === "win32" ? "curl.exe" : "curl", ["--fail", "--silent", "--show-error", "--max-time", "10", "--proxy-cacert", certificateFile, "--cacert", certificateFile, "--noproxy", "", "--proxy", proxyUrl, "https://downloads.cursor.com/installer"], { timeout: 15_000 });
    expect(stdout).toBe("official-download");
  }, 25_000);

  it("blocks private and special-use DNS results before opening a tunnel", () => {
    for (const address of ["127.0.0.1", "10.2.3.4", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) expect(isPublicUpdateAddress(address), address).toBe(false);
    expect(isPublicUpdateAddress("8.8.8.8")).toBe(true);
    expect(isPublicUpdateAddress("2606:4700:4700::1111")).toBe(true);
  });
});
