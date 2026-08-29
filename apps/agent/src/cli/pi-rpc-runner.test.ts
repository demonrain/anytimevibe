import { describe, expect, it } from "vitest";
import { buildPiSpawnArgs, contextUsageFromPi, parsePiModelRef } from "./pi-rpc-runner";
import { parsePiSessionFile } from "./import-sessions";

describe("Pi model and spawn arguments", () => {
  it("parses provider/model and thinking suffixes", () => {
    expect(parsePiModelRef("anthropic/claude-sonnet-4")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4"
    });
    expect(parsePiModelRef("gpt-5:high")).toEqual({ modelId: "gpt-5", thinking: "high" });
  });

  it("resumes a native session and maps read-only tools", () => {
    expect(buildPiSpawnArgs({
      threadId: "thread-1",
      turnId: "turn-1",
      cwd: "C:\\work",
      prompt: "hello",
      permissionMode: "read-only",
      providerSessionId: "pi-session-1",
      model: "anthropic/claude-sonnet-4",
      reasoningEffort: "medium"
    })).toEqual([
      "--mode", "rpc", "--approve", "--session", "pi-session-1",
      "--provider", "anthropic", "--model", "claude-sonnet-4", "--thinking", "medium",
      "--tools", "read,grep,find,ls"
    ]);
  });
});

describe("Pi RPC usage", () => {
  it("accepts Pi usage field names and ignores empty samples", () => {
    expect(contextUsageFromPi({ usage: { input: 120, output: 30, totalTokens: 150 } })).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150
    });
    expect(contextUsageFromPi({ usage: { input: 0, output: 0 } })).toBeUndefined();
  });
});

describe("Pi session import", () => {
  it("uses the JSONL header cwd and native id instead of the encoded folder name", () => {
    const metadata = parsePiSessionFile([
      JSON.stringify({ type: "session", version: 3, id: "native-id", timestamp: "2026-08-28T12:00:00.000Z", cwd: "C:\\work\\app" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Fix the login flow" }] } })
    ].join("\n"), "file-id", 1_000);
    expect(metadata).toMatchObject({
      id: "native-id",
      cwd: "C:\\work\\app",
      timestamp: Date.parse("2026-08-28T12:00:00.000Z") / 1000,
      title: "Fix the login flow"
    });
  });

  it("rejects transcripts without an absolute working directory", () => {
    expect(parsePiSessionFile(JSON.stringify({ type: "session", id: "id", cwd: "--home-user-project" }), "id", 100)).toBeUndefined();
  });
});
