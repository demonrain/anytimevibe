import { describe, expect, it } from "vitest";
import {
  CODEX_COMPAT_LABEL,
  CODEX_INSTALL_PACKAGE,
  codexPermissionParams,
  explainCodexUpstreamError,
  isCodexCompatibleVersion,
  normalizeUnixSeconds,
  threadResumeParams,
  threadStartParams,
  threadToSnapshot
} from "./codex-adapter";

describe("isCodexCompatibleVersion", () => {
  it("accepts 0.144+ including prereleases, rejects older minors", () => {
    expect(isCodexCompatibleVersion("0.144.0")).toBe(true);
    expect(isCodexCompatibleVersion("0.144.9")).toBe(true);
    expect(isCodexCompatibleVersion("0.145.0")).toBe(true);
    expect(isCodexCompatibleVersion("0.145.1")).toBe(true);
    expect(isCodexCompatibleVersion("0.146.0")).toBe(true);
    expect(isCodexCompatibleVersion("0.146.0-alpha.3.1")).toBe(true);
    expect(isCodexCompatibleVersion("1.0.0")).toBe(true);
    expect(isCodexCompatibleVersion("0.143.0")).toBe(false);
    expect(isCodexCompatibleVersion("0.143.9")).toBe(false);
    expect(isCodexCompatibleVersion("")).toBe(false);
    expect(CODEX_INSTALL_PACKAGE).toBe("@openai/codex@latest");
    expect(CODEX_COMPAT_LABEL).toBe("≥ 0.144.0");
  });
});

describe("threadToSnapshot", () => {
  it("maps Codex CLI permission labels to app-server settings", () => {
    expect(codexPermissionParams("read-only")).toEqual({ approvalPolicy: "on-request", sandbox: "read-only" });
    expect(codexPermissionParams("ask-for-approval")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(codexPermissionParams("approve-for-me")).toEqual({ approvalPolicy: "never", sandbox: "workspace-write" });
    expect(codexPermissionParams("full-access")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(threadStartParams("C:\\repo", "ask-for-approval")).toEqual({
      cwd: "C:\\repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write"
    });
    expect(threadResumeParams("t1", "full-access")).toEqual({ threadId: "t1", approvalPolicy: "never", sandbox: "danger-full-access" });
  });
  it("keeps legacy inherit as no-override", () => {
    expect(threadStartParams("C:\\repo", "inherit")).toEqual({ cwd: "C:\\repo" });
    expect(threadResumeParams("t1", "inherit")).toEqual({ threadId: "t1" });
  });
  it("extracts user and assistant messages", () => {
    const snapshot = threadToSnapshot({
      id: "thread-1",
      preview: "Build the feature",
      cwd: "C:\\repo",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
      turns: [{
        startedAt: 1,
        completedAt: 2,
        items: [
          { type: "userMessage", id: "u1", content: [{ type: "text", text: "hello" }] },
          { type: "agentMessage", id: "a1", text: "done" }
        ]
      }]
    });
    expect(snapshot.title).toBe("Build the feature");
    expect(snapshot.messages).toEqual([
      { id: "u1", role: "user", text: "hello", createdAt: 1 },
      { id: "a1", role: "assistant", text: "done", createdAt: 2 }
    ]);
  });

  it("includes the active turn in synchronization snapshots", () => {
    const snapshot = threadToSnapshot({
      id: "thread-active",
      status: "active",
      turns: [{ id: "turn-active", status: "inProgress", startedAt: 3, items: [] }]
    });
    expect(snapshot.activeTurnId).toBe("turn-active");
  });

  it("does not let a previous completed turn override an active thread status", () => {
    // Thread is active (new turn just started); previous turn finished as "completed".
    // The snapshot must keep status=active so the web does not show "已完成" prematurely.
    const snapshot = threadToSnapshot({
      id: "thread-multi",
      status: "active",
      turns: [
        { id: "turn-1", status: "completed", completedAt: 100, items: [] },
        { id: "turn-2", status: "inProgress", startedAt: 200, items: [] }
      ]
    });
    expect(snapshot.status).toBe("active");
    expect(snapshot.activeTurnId).toBe("turn-2");
  });

  it("overrides active thread status with last turn failure status", () => {
    const snapshot = threadToSnapshot({
      id: "thread-failed",
      status: "active",
      turns: [
        { id: "turn-1", status: "failed", completedAt: 100, items: [] }
      ]
    });
    expect(snapshot.status).toBe("failed");
  });

  it("normalizes ms timestamps and prefers last turn activity for updatedAt", () => {
    expect(normalizeUnixSeconds(1_700_000_000_000)).toBe(1_700_000_000);
    const snapshot = threadToSnapshot({
      id: "thread-2",
      createdAt: 100,
      updatedAt: 100,
      turns: [{ startedAt: 200, completedAt: 300, items: [] }]
    });
    expect(snapshot.updatedAt).toBe(300);
  });
});

describe("explainCodexUpstreamError", () => {
  it("does not claim official OpenAI when the 401 is from a custom relay", () => {
    const text = explainCodexUpstreamError(
      'unexpected status 401 Unauthorized: {"code":"INVALID_API_KEY","message":"Invalid API key"}, url: https://store.example.com/responses'
    );
    expect(text).toContain("请求已打到自定义 / 中转供应商");
    expect(text).not.toContain("https://api.openai.com，而不是");
  });

  it("explains official OpenAI host 401 separately", () => {
    const text = explainCodexUpstreamError(
      "unexpected status 401 Unauthorized: Incorrect API key provided: sk-abc, url: https://api.openai.com/v1/responses"
    );
    expect(text).toContain("请求打到了官方 https://api.openai.com");
  });
});
