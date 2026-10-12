import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { clearEngineLatestCache, enrichEnginesWithLatestVersions } from "./engine-updates";
import { configureEngineUpdateNetwork } from "./update-network";

const servers: Server[] = [];
afterEach(async () => {
  configureEngineUpdateNetwork({}); clearEngineLatestCache();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});
async function middle(handler: RequestListener): Promise<string> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("engine update checks over the transfer service", () => {
  it("checks Cursor and GitHub metadata through the configured middle without a local proxy", async () => {
    const seen: string[] = [];
    const url = await middle((request, response) => {
      seen.push(request.url!);
      if (request.url?.startsWith("/api/agent/engine/cursor/install")) response.end("https://downloads.cursor.com/lab/2026.10.01-e373342/windows/x64/agent-cli-package.zip");
      else if (request.url === "/api/agent/engine/antigravity/releases/latest") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ tag_name: "v2.0.0", name: "2.0.0" })); }
      else { response.writeHead(404); response.end(); }
    });
    configureEngineUpdateNetwork({ relayUrl: url });
    const result = await enrichEnginesWithLatestVersions([
      { engine: "cursor", ready: true, version: "2026.09.01-123abcd" },
      { engine: "antigravity", ready: true, version: "1.0.0" }
    ]);
    expect(result[0]?.latestVersion).toBe("2026.10.01-e373342");
    expect(result[1]?.latestVersion).toBe("2.0.0");
    expect(seen).toContain("/api/agent/engine/antigravity/releases/latest");
    expect(seen.some((path) => path.startsWith("/api/agent/engine/cursor/install"))).toBe(true);
  });

  it("does not reuse a version cache from a different relay", async () => {
    const first = await middle((_request, response) => { response.end(JSON.stringify({ "dist-tags": { latest: "1.0.0" } })); });
    const second = await middle((_request, response) => { response.end(JSON.stringify({ "dist-tags": { latest: "2.0.0" } })); });
    configureEngineUpdateNetwork({ relayUrl: first });
    expect((await enrichEnginesWithLatestVersions([{ engine: "codex", ready: true, version: "0.1.0" }]))[0]?.latestVersion).toBe("1.0.0");
    configureEngineUpdateNetwork({ relayUrl: second });
    expect((await enrichEnginesWithLatestVersions([{ engine: "codex", ready: true, version: "0.1.0" }]))[0]?.latestVersion).toBe("2.0.0");
  });
});
