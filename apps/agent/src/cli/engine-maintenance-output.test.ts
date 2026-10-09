import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { sanitizeEngineMaintenanceDetail } from "./engine-maintenance";

// Exercise the actual streamed upgrade-output callback, without running an installer.
const source = createSourceFile("main.ts", readFileSync(
  path.resolve("apps/agent/src/main.ts"), "utf8"
), ScriptTarget.Latest, true);
const declaration = source.statements.find((node) =>
  isFunctionDeclaration(node) && node.name?.text === "getEngineMaintenance"
);
if (!declaration) throw new Error("Could not locate the production maintenance wiring");
const maintenanceScript = new Script(`${transpileModule(declaration.getText(source), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
}).outputText}\ngetEngineMaintenance();`);

describe("streamed maintenance output redaction", () => {
  it.each(["sk-example", "Authorization: Bearer example", "Authorization: Basic example"])(
    "keeps split %s credentials redacted", async (firstChunk) => {
      let clock = 0;
      const reported: string[] = [];
      const manager = maintenanceScript.runInNewContext({
        engineMaintenanceInstance: null,
        EngineMaintenance: class {
          constructor(readonly dependencies: unknown) {}
        },
        busyCodingEngines: () => [],
        resolveEngineUpgradeTarget: async () => ({}),
        buildEngineUpgradeSteps: () => [{ command: "trusted-updater", args: [] }],
        collectLocalProxyEnv: async () => ({}),
        mergeProxyIntoEnv: () => ({}),
        process: { env: {} }, os: { homedir: () => "workdir" },
        Date: { now: () => clock += 1000 },
        sanitizeEngineMaintenanceDetail,
        updateState: () => {},
        execFileWithTreeKill: async (_command: string, _args: string[], options: { onOutput(chunk: string): void }) => {
          options.onOutput(firstChunk);
          options.onOutput("Secret123");
        }
      }) as { dependencies: { upgrade(engine: string, version: string | undefined, report: (text: string) => void): Promise<void> } };

      await manager.dependencies.upgrade("pi", undefined, (text) => reported.push(text));

      expect(reported).toHaveLength(2);
      expect(reported.join("\n")).not.toContain("example");
      expect(reported.join("\n")).not.toContain("Secret123");
      expect(reported[1]).toContain("[redacted]");
    }
  );
});
