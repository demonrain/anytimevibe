import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEngineMaintenanceNetworkEnv, configureEngineUpdateNetwork, createEngineUpdateOutputRedactor, engineUpdateNetworkRevision, npmUpdateRegistryCandidates, redactEngineUpdateOutput, resolveEngineUpdateUrl } from "./update-network";

afterEach(() => { vi.unstubAllEnvs(); configureEngineUpdateNetwork({}); });

describe("configured engine update transport", () => {
  it("routes Cursor and Antigravity probes through the current relay", () => {
    configureEngineUpdateNetwork({ relayUrl: "https://vibe.example.com/" });
    expect(resolveEngineUpdateUrl("cursor-installer", "https://cursor.com/install?win32=true")).toBe("https://vibe.example.com/api/agent/engine/cursor/install?win32=true");
    expect(resolveEngineUpdateUrl("antigravity-latest", "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest")).toBe("https://vibe.example.com/api/agent/engine/antigravity/releases/latest");
    expect(npmUpdateRegistryCandidates()).toEqual(["https://vibe.example.com/api/agent/npm"]);
  });

  it("uses standalone transfer URLs while preserving an explicit npm registry override", () => {
    vi.stubEnv("ANYTIMEVIBE_NPM_REGISTRY", "https://registry.npmmirror.com/");
    configureEngineUpdateNetwork({ relayUrl: "https://vibe.example.com", engineUpdateBaseUrl: "https://updates.example.com/api/agent/engine/", npmRegistryUrl: "https://updates.example.com/api/agent/npm/" });
    expect(resolveEngineUpdateUrl("cursor-installer", "https://cursor.com/install")).toBe("https://updates.example.com/api/agent/engine/cursor/install");
    expect(npmUpdateRegistryCandidates()).toEqual(["https://registry.npmmirror.com", "https://updates.example.com/api/agent/npm"]);
  });

  it("invalidates probe cache identity after switching relays and rejects insecure remote transfer URLs", () => {
    configureEngineUpdateNetwork({ relayUrl: "https://first.example.com" });
    const before = engineUpdateNetworkRevision();
    configureEngineUpdateNetwork({ relayUrl: "https://second.example.com", engineUpdateBaseUrl: "http://45.205.27.168/api/agent/engine/" });
    expect(engineUpdateNetworkRevision()).not.toBe(before);
    expect(resolveEngineUpdateUrl("cursor-installer", "https://cursor.com/install")).toBe("https://second.example.com/api/agent/engine/cursor/install");
  });

  it("uses original update endpoints when an older relay explicitly reports missing transport support", () => {
    configureEngineUpdateNetwork({ relayUrl: "https://old.example.com", engineUpdateBaseUrl: null, npmRegistryUrl: null });
    expect(npmUpdateRegistryCandidates()).toEqual(["https://registry.npmjs.org", "https://registry.npmmirror.com"]);
    expect(resolveEngineUpdateUrl("cursor-installer", "https://cursor.com/install")).toBe("https://cursor.com/install");
  });

  it("sets an authenticated HTTPS proxy only in the returned maintenance environment and redacts credentials", () => {
    configureEngineUpdateNetwork({ relayUrl: "https://vibe.example.com", engineUpdateProxyUrl: "https://av-123456:long-secret-password@updates.example.com:9443" });
    const original = { PATH: "tools", HTTPS_PROXY: "http://old-proxy:8080", NO_PROXY: "*" };
    const env = buildEngineMaintenanceNetworkEnv(original);
    expect(env.HTTPS_PROXY).toBe("https://av-123456:long-secret-password@updates.example.com:9443/");
    expect(env.http_proxy).toBe(env.HTTPS_PROXY);
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,vibe.example.com");
    expect(original.HTTPS_PROXY).toBe("http://old-proxy:8080");
    expect(redactEngineUpdateOutput(`failed via ${env.HTTPS_PROXY} password long-secret-password`)).toBe("failed via https://[redacted]@updates.example.com:9443/ password [redacted]");
    expect(redactEngineUpdateOutput("failed via https://av-123456:long-secre")).toBe("failed via https://[redacted]");
  });

  it("redacts credentials when a child emits a proxy URL over multiple output chunks", () => {
    configureEngineUpdateNetwork({ relayUrl: "https://vibe.example.com", engineUpdateProxyUrl: "https://av-123456:long-secret-password@updates.example.com:9443" });
    const chunks: string[] = [];
    const redact = createEngineUpdateOutputRedactor((chunk) => chunks.push(chunk));
    redact.write("proxy failed at https://av-123456:long-");
    redact.write("secret-password@updates.example.com:9443\nnext");
    redact.flush();
    expect(chunks.join("")).toBe("proxy failed at https://[redacted]@updates.example.com:9443\nnext");
    expect(chunks.join("")).not.toContain("long-secret");
  });

  it("redacts authentication headers and keeps a subprocess credential snapshot when config refresh rotates tokens", () => {
    configureEngineUpdateNetwork({ relayUrl: "https://vibe.example.com", engineUpdateProxyUrl: "https://av-123456:long-secret-password@updates.example.com:9443" });
    const header = `Proxy-Authorization: Basic ${Buffer.from("av-123456:long-secret-password").toString("base64")}`;
    expect(redactEngineUpdateOutput(header)).toBe("Proxy-Authorization: [redacted]");
    const output: string[] = [];
    const redact = createEngineUpdateOutputRedactor((chunk) => output.push(chunk));
    redact.write("https://av-123456:long-secret-");
    configureEngineUpdateNetwork({ relayUrl: "https://vibe.example.com", engineUpdateProxyUrl: "https://av-654321:another-secret-password@updates.example.com:9443" });
    redact.flush();
    expect(output.join("")).toBe("https://[redacted]");
  });

  it("bypasses the trusted relay and transfer hosts when a native repair child uses the maintenance proxy", () => {
    configureEngineUpdateNetwork({ relayUrl: "https://vibe.example.com", engineUpdateBaseUrl: "https://updates.example.com/api/agent/engine/", npmRegistryUrl: "https://updates.example.com/api/agent/npm/", engineUpdateProxyUrl: "https://av-123456:long-secret-password@proxy.example.com:9443" });
    expect(buildEngineMaintenanceNetworkEnv({}).NO_PROXY).toBe("localhost,127.0.0.1,::1,vibe.example.com,updates.example.com");
  });

  it("rejects an unauthenticated or insecure remote maintenance proxy", () => {
    for (const engineUpdateProxyUrl of ["http://av-123456:secret@45.205.27.168:8080", "https://updates.example.com:9443"]) {
      configureEngineUpdateNetwork({ relayUrl: "https://vibe.example.com", engineUpdateProxyUrl });
      expect(buildEngineMaintenanceNetworkEnv({ PATH: "tools" })).toEqual({ PATH: "tools" });
    }
  });
});
