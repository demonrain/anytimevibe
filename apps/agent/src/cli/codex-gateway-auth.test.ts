import { describe, expect, it } from "vitest";
import { assignCodexApiKeyEnv, CODEX_AUTH_HEADER_ENV, pickCodexRelayKey, upsertProviderEnvAuthorization } from "./codex-gateway";

describe("Codex relay key injection", () => {
  it("prefers auth.json over the toml bearer", () => {
    expect(pickCodexRelayKey("from-auth", "from-bearer")).toEqual({
      key: "from-auth",
      source: "auth.json"
    });
    expect(pickCodexRelayKey("  ", "from-bearer")).toEqual({
      key: "from-bearer",
      source: "config-bearer"
    });
    expect(pickCodexRelayKey("", "")).toBeNull();
  });

  it("writes the key onto the env name Codex env_key will read", () => {
    const env: NodeJS.ProcessEnv = {};
    assignCodexApiKeyEnv(env, "from-auth", "OPENAI_API_KEY");
    expect(env.OPENAI_API_KEY).toBe("from-auth");
    assignCodexApiKeyEnv(env, "from-auth", "CUSTOM_API_KEY");
    expect(env.CUSTOM_API_KEY).toBe("from-auth");
    expect(env.OPENAI_API_KEY).toBe("from-auth");
    expect(env[CODEX_AUTH_HEADER_ENV]).toBe("Bearer from-auth");
  });

  it("adds an env_http_headers entry that names the bearer env var", () => {
    const input = [
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      'base_url = "https://store.example"',
      "supports_websockets = false",
      ""
    ].join("\n");
    const once = upsertProviderEnvAuthorization(input, "custom");
    expect(once.changed).toBe(true);
    expect(once.text).toContain("[model_providers.custom.env_http_headers]");
    expect(once.text).toContain(`Authorization = "${CODEX_AUTH_HEADER_ENV}"`);
    expect(upsertProviderEnvAuthorization(once.text, "custom").changed).toBe(false);
  });
});
