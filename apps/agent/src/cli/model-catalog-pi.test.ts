import { describe, expect, it } from "vitest";
import { parsePiListModelsOutput, resolvePiModelForCli } from "./model-catalog";
import { buildPiSpawnArgs } from "./pi-rpc-runner";

const listModels = [
  "provider                 model                context   max-out   thinking   images",
  "anthropic                claude-opus-4-8      1M        128k      yes        yes",
  "demonrain                deepseek-v4-flash    12.8k     16.4k     no         no"
].join("\n");

describe("Pi model catalog", () => {
  it("parses the list-models table into provider/model ids", () => {
    expect(parsePiListModelsOutput(listModels)).toEqual([
      {
        id: "anthropic/claude-opus-4-8",
        label: "anthropic/claude-opus-4-8",
        contextWindow: 1_000_000,
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
      },
      {
        id: "demonrain/deepseek-v4-flash",
        label: "demonrain/deepseek-v4-flash",
        contextWindow: 12_800
      }
    ]);
  });

  it("maps a hyphenated table row back to the Pi model id", () => {
    const known = ["demonrain/deepseek-v4-flash"];
    expect(resolvePiModelForCli("demonrain-deepseek-v4-flash-12.8k-16.4k-no-no", known))
      .toBe("demonrain/deepseek-v4-flash");
    expect(resolvePiModelForCli("demonrain  deepseek-v4-flash  12.8k  16.4k  no  no", known))
      .toBe("demonrain/deepseek-v4-flash");
  });

  it("spawns a recovered custom model as provider plus model", () => {
    expect(buildPiSpawnArgs({
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "C:\\work",
      prompt: "hello",
      permissionMode: "ask-for-approval",
      model: "demonrain/deepseek-v4-flash"
    })).toEqual([
      "--mode", "rpc", "--approve",
      "--provider", "demonrain", "--model", "deepseek-v4-flash",
      "--tools", "read,grep,find,ls,bash,edit,write"
    ]);
  });
});
