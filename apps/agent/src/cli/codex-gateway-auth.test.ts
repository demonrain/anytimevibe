import { describe, expect, it } from "vitest";
import { assignCodexApiKeyEnv, pickCodexRelayKey } from "./codex-gateway";

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
  });
});
