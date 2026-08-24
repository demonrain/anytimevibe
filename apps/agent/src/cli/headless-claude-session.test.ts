import { describe, expect, it } from "vitest";
import { isClaudeSessionNotFound, shouldAcceptClaudeSessionId } from "./headless-runner";

describe("Claude session id acceptance", () => {
  it("detects missing-session CLI errors", () => {
    expect(isClaudeSessionNotFound("No conversation found with session ID: abc")).toBe(true);
    expect(isClaudeSessionNotFound("API Error: rate limit")).toBe(false);
  });

  it("accepts parent init / result ids and rejects sidechain / nested Agent channels", () => {
    expect(shouldAcceptClaudeSessionId({
      type: "system",
      subtype: "init",
      session_id: "parent-1"
    })).toBe(true);

    expect(shouldAcceptClaudeSessionId({
      type: "result",
      session_id: "parent-1",
      is_error: false
    })).toBe(true);

    expect(shouldAcceptClaudeSessionId({
      type: "assistant",
      session_id: "parent-1",
      parent_tool_use_id: null
    })).toBe(true);

    expect(shouldAcceptClaudeSessionId({
      type: "assistant",
      session_id: "child-1",
      parent_tool_use_id: "toolu_abc"
    })).toBe(false);

    expect(shouldAcceptClaudeSessionId({
      type: "user",
      session_id: "child-1",
      isSidechain: true
    })).toBe(false);

    expect(shouldAcceptClaudeSessionId({
    type: "result",
    session_id: "parent-1",
    is_error: true,
    result: "No conversation found with session ID: parent-1"
  })).toBe(false);
  });

  it("detects session-not-found in various formats", () => {
    expect(isClaudeSessionNotFound("No conversation found with session ID: 26ceaa61-557c-4b22-be86-625d44c6a0b5")).toBe(true);
    expect(isClaudeSessionNotFound("no conversation found with session id: abc")).toBe(true);
    expect(isClaudeSessionNotFound("Connection refused")).toBe(false);
    expect(isClaudeSessionNotFound("")).toBe(false);
    expect(isClaudeSessionNotFound(null)).toBe(false);
  });
});
