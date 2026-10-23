import { describe, expect, it } from "vitest";
import { buildEngineInstallSteps } from "./engine-install";

describe("engine installation steps", () => {
  it("builds fixed npm installation steps for Codex, Claude and Pi", () => {
    expect(buildEngineInstallSteps({ engine: "codex", platform: "win32", npmCommand: "npm.cmd", prefix: "C:\\npm" })[0]!).toEqual({
      command: "npm.cmd",
      args: ["install", "-g", "--registry=https://registry.npmjs.org/", "--prefix=C:\\npm", "--include=optional", "--bin-links=true", "@openai/codex@latest"]
    });
    expect(buildEngineInstallSteps({ engine: "claude", platform: "darwin", npmCommand: "npm", prefix: "/tmp/npm" })[0]!.args).toContain("@anthropic-ai/claude-code@latest");
    expect(buildEngineInstallSteps({ engine: "pi", platform: "darwin", npmCommand: "npm", prefix: "/tmp/npm" })[0]!.args).toContain("@earendil-works/pi-coding-agent@latest");
  });

  it("repairs Claude's Windows native binary after npm installation", () => {
    expect(buildEngineInstallSteps({ engine: "claude", platform: "win32", npmCommand: "npm.cmd", prefix: "C:\\npm",
      nodeCommand: "node.exe", repairScript: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\install.cjs" })).toEqual([
      expect.objectContaining({ command: "npm.cmd" }),
      { command: "node.exe", args: ["C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\install.cjs"] }
    ]);
  });

  it("uses only fixed official installer URLs for vendor CLIs", () => {
    for (const engine of ["cursor", "grok", "antigravity"] as const) {
      const windows = buildEngineInstallSteps({ engine, platform: "win32" });
      const mac = buildEngineInstallSteps({ engine, platform: "darwin" });
      expect(windows[0]!.args.join(" ")).toMatch(/https:\/\//);
      expect(mac[0]!.args.join(" ")).toMatch(/https:\/\//);
      expect(windows[0]!.args.join(" ")).not.toMatch(/example|localhost|127\.0\.0\.1/i);
    }
  });

  it("rejects unsupported platforms and npm installs without npm", () => {
    expect(() => buildEngineInstallSteps({ engine: "cursor", platform: "linux" })).toThrow(/不支持|Linux/i);
    expect(() => buildEngineInstallSteps({ engine: "codex", platform: "darwin", prefix: "/tmp/npm" })).toThrow(/npm/i);
  });
});
