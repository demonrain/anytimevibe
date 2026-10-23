import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anytimevibe/protocol";
import { reduceEvent, shouldFailMissingEngineOperation } from "./App";

const operationId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-10-08T00:00:00.000Z";

function runtimeFixture() {
  return {
    online: true,
    workspaces: [],
    tasks: {
      "thread-1": {
        threadId: "thread-1",
        title: "Task",
        cwd: "C:/repo",
        status: "active",
        activeTurnId: "turn-1",
        updatedAt: 1,
        diff: "",
        messages: [],
        approvals: []
      }
    },
    engineManagement: {
      supported: true as const,
      busyEngines: [],
      operation: {
        commandId: operationId,
        action: "update" as const,
        cliEngine: "codex" as const,
        phase: "failed" as const,
        startedAt: timestamp,
        updatedAt: timestamp,
        detail: "CLI update failed"
      }
    }
  } as Parameters<typeof reduceEvent>[0];
}

function errorEvent(commandId: string, threadId?: string): AgentEvent {
  return {
    type: "error",
    eventId,
    occurredAt: timestamp,
    commandId,
    ...(threadId ? { threadId } : {}),
    message: "CLI update failed"
  };
}

describe("engine maintenance error events", () => {
  it("restores remote installation progress from host status", () => {
    const next = reduceEvent(runtimeFixture(), {
      type: "host.status", eventId, occurredAt: timestamp, online: true,
      name: "Windows", platform: "win32", codexVersion: "unknown", workspaces: [],
      engineManagement: {
        supported: true,
        busyEngines: [],
        operation: {
          commandId: operationId, action: "install", cliEngine: "pi", phase: "installing",
          startedAt: timestamp, updatedAt: timestamp, detail: "Downloading package"
        }
      }
    });

    expect(next.engineManagement?.operation).toMatchObject({
      commandId: operationId, action: "install", cliEngine: "pi", phase: "installing"
    });
  });

  it("detects a running maintenance request whose operation disappeared after Agent restart", () => {
    const runtime = runtimeFixture();
    runtime.hostStatusAt = timestamp;
    delete runtime.engineManagement!.operation;

    expect(shouldFailMissingEngineOperation({
      commandId: operationId, action: "update", state: "running"
    }, runtime)).toBe(true);
  });

  it("does not fail a request still waiting for its first confirmation", () => {
    const runtime = runtimeFixture();
    runtime.hostStatusAt = timestamp;
    delete runtime.engineManagement;

    expect(shouldFailMissingEngineOperation({
      commandId: operationId, action: "update", state: "waiting"
    }, runtime)).toBe(false);
  });

  it("does not fail an operation still reported by the Agent", () => {
    const runtime = runtimeFixture();
    runtime.hostStatusAt = timestamp;

    expect(shouldFailMissingEngineOperation({
      commandId: operationId, action: "update", state: "running"
    }, runtime)).toBe(false);
  });

  it("clears remote-maintenance support when a replacement Agent omits the capability", () => {
    const next = reduceEvent(runtimeFixture(), {
      type: "host.status", eventId, occurredAt: timestamp, online: true,
      name: "Older Agent", platform: "win32", codexVersion: "0.158.0", workspaces: [], agentVersion: "0.5.19"
    });

    expect(next.engineManagement?.supported).not.toBe(true);
  });

  it("records a matching maintenance error without mutating a task", () => {
    const next = reduceEvent(runtimeFixture(), errorEvent(operationId));

    expect(next.engineCommandErrors?.[operationId]).toBe("CLI update failed");
    expect(next.tasks["thread-1"]).toMatchObject({ status: "active", activeTurnId: "turn-1" });
  });

  it("keeps command-tagged task errors on the normal task failure path", () => {
    const next = reduceEvent(runtimeFixture(), errorEvent(operationId, "thread-1"));

    expect(next.engineCommandErrors).toBeUndefined();
    expect(next.tasks["thread-1"]).toMatchObject({ status: "failed" });
    expect(next.tasks["thread-1"]?.activeTurnId).toBeUndefined();
    expect(next.tasks["thread-1"]?.messages).toContainEqual(expect.objectContaining({
      role: "system",
      text: "错误：CLI update failed"
    }));
  });

  it("does not classify unrelated command errors as engine maintenance failures", () => {
    const next = reduceEvent(runtimeFixture(), errorEvent("33333333-3333-4333-8333-333333333333"));

    expect(next.engineCommandErrors).toBeUndefined();
    expect(next.tasks["thread-1"]).toMatchObject({ status: "active", activeTurnId: "turn-1" });
  });

  it("records a tracked maintenance rejection even before an operation status is published", () => {
    const runtime = runtimeFixture();
    delete runtime.engineManagement;
    const next = reduceEvent(runtime, errorEvent(operationId), new Set([operationId]));

    expect(next.engineCommandErrors?.[operationId]).toBe("CLI update failed");
  });
});
