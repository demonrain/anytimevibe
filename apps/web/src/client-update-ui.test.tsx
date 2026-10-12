import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent, ClientUpdateState } from "@anytimevibe/protocol";
import { applyHostConnection, reduceEvent } from "./App";
import { ClientUpdatePanel, clientUpdateCommandCanSend, reconcileClientUpdateRequest, type ClientUpdateRequest } from "./ClientUpdatePanel";

const commandId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const before = "2026-10-12T00:00:00.000Z";
const timestamp = "2026-10-12T00:01:00.000Z";
const after = "2026-10-12T00:02:00.000Z";

function updateFixture(overrides: Partial<ClientUpdateState> = {}): ClientUpdateState {
  return {
    supported: true, status: "waiting", currentVersion: "0.5.23", version: "0.5.24",
    commandId, installWhenIdle: true, updatedAt: timestamp, ...overrides
  };
}

function runtimeFixture() {
  return {
    online: true, agentVersion: "0.5.23", workspaces: [], tasks: {
      task: { threadId: "task", title: "Task", cwd: "C:/repo", status: "active",
        activeTurnId: "turn-1", updatedAt: 1, diff: "", messages: [], approvals: [] }
    }
  } as Parameters<typeof reduceEvent>[0];
}

function hostStatus(overrides: Partial<Extract<AgentEvent, { type: "host.status" }>> = {}): AgentEvent {
  return {
    type: "host.status", eventId, occurredAt: timestamp, online: true,
    name: "Desktop", platform: "win32", codexVersion: "0.158.0", workspaces: [],
    agentVersion: "0.5.23", ...overrides
  };
}

function updateEvent(update: ClientUpdateState, occurredAt = update.updatedAt): AgentEvent {
  return { type: "host.client.update.status", eventId, occurredAt, update };
}

describe("remote client update events", () => {
  it("restores a deferred install from host.status after refreshing the page", () => {
    const next = reduceEvent(runtimeFixture(), hostStatus({ clientUpdate: updateFixture() }));

    expect(next.clientUpdate).toMatchObject({ status: "waiting", installWhenIdle: true, commandId });
    expect(next.tasks.task?.status).toBe("active");
  });

  it("receives download progress without creating or changing tasks", () => {
    const next = reduceEvent(runtimeFixture(), updateEvent(updateFixture({ status: "downloading", progress: 42 })));

    expect(next.clientUpdate).toMatchObject({ status: "downloading", progress: 42 });
    expect(Object.keys(next.tasks)).toEqual(["task"]);
    expect(next.tasks.task).toMatchObject({ status: "active", activeTurnId: "turn-1" });
  });

  it("keeps a newer completion and actual version when an old host.status is replayed", () => {
    const completed = reduceEvent(runtimeFixture(), hostStatus({
      occurredAt: after, agentVersion: "0.5.24",
      clientUpdate: updateFixture({ status: "completed", currentVersion: "0.5.24", updatedAt: after })
    }));
    const next = reduceEvent(completed, hostStatus({ occurredAt: before, clientUpdate: updateFixture() }));

    expect(next.clientUpdate?.status).toBe("completed");
    expect(next.agentVersion).toBe("0.5.24");
  });

  it("does not erase a live update result with an older capability-free snapshot", () => {
    const completed = reduceEvent(runtimeFixture(), updateEvent(updateFixture({
      status: "completed", currentVersion: "0.5.24", updatedAt: after
    })));
    const next = reduceEvent(completed, hostStatus({ occurredAt: before }));

    expect(next.clientUpdate).toMatchObject({ supported: true, status: "completed", currentVersion: "0.5.24" });
  });

  it("does not roll progress back when an older live state arrives after a newer one", () => {
    const downloading = reduceEvent(runtimeFixture(), updateEvent(updateFixture({
      status: "downloading", progress: 80, updatedAt: after
    })));
    const next = reduceEvent(downloading, updateEvent(updateFixture({ status: "downloading", progress: 25 })));

    expect(next.clientUpdate?.progress).toBe(80);
  });

  it("retains an install operation in an offline snapshot that omits capabilities", () => {
    const installing = reduceEvent(runtimeFixture(), hostStatus({ clientUpdate: updateFixture({ status: "installing" }) }));
    const next = reduceEvent(installing, hostStatus({ occurredAt: after, online: false }));

    expect(next.clientUpdate).toMatchObject({ status: "installing", commandId, version: "0.5.24" });
    expect(next.online).toBe(false);
  });

  it("keeps update state and a stable disconnect deadline while the relay reconnects", () => {
    const waiting = reduceEvent(runtimeFixture(), hostStatus({ clientUpdate: updateFixture() }));
    const offline = applyHostConnection(waiting, false, Date.parse(timestamp));
    const stillOffline = applyHostConnection(offline, false, Date.parse(after));
    expect(stillOffline.clientUpdate).toMatchObject({ status: "waiting", installWhenIdle: true, commandId });
    expect(stillOffline.clientUpdateOfflineAt).toBe(Date.parse(timestamp));
    expect(stillOffline.tasks.task).toMatchObject({ status: "active", activeTurnId: "turn-1" });
    const online = applyHostConnection(stillOffline, true, Date.parse(after));
    expect(online.clientUpdate?.status).toBe("waiting");
    expect(online.clientUpdateOfflineAt).toBeUndefined();
  });

  it("rejects stale update payloads even when their enclosing snapshot was sent later", () => {
    const completed = reduceEvent(runtimeFixture(), hostStatus({
      occurredAt: timestamp, agentVersion: "0.5.24",
      clientUpdate: updateFixture({ status: "completed", currentVersion: "0.5.24" })
    }));
    const next = reduceEvent(completed, hostStatus({
      occurredAt: after, agentVersion: "0.5.23",
      clientUpdate: updateFixture({ status: "installing", updatedAt: before })
    }));

    expect(next.clientUpdate?.status).toBe("completed");
    expect(next.agentVersion).toBe("0.5.24");
  });

  it("clears remote upgrade support for a replacement client that omits the capability", () => {
    const supported = reduceEvent(runtimeFixture(), hostStatus({ clientUpdate: updateFixture({ status: "idle" }) }));
    expect(supported.clientUpdate?.supported).toBe(true);
    const next = reduceEvent(supported, hostStatus({ occurredAt: after, agentVersion: "0.5.19" }));

    expect(next.clientUpdate?.supported).not.toBe(true);
    expect(next.agentVersion).toBe("0.5.19");
  });

  it("accepts a fresh rollback error and the restored version", () => {
    const installing = reduceEvent(runtimeFixture(), hostStatus({ clientUpdate: updateFixture({ status: "installing" }) }));
    const next = reduceEvent(installing, hostStatus({
      occurredAt: after, agentVersion: "0.5.23",
      clientUpdate: updateFixture({ status: "error", installWhenIdle: false, updatedAt: after,
        message: "The new client failed to start; the previous version was restored." })
    }));

    expect(next.clientUpdate).toMatchObject({ status: "error", currentVersion: "0.5.23" });
    expect(next.clientUpdate?.message).toContain("restored");
  });

  it("records a remote update rejection without failing an active task", () => {
    const next = reduceEvent(runtimeFixture(), {
      type: "error", eventId, occurredAt: timestamp, commandId, message: "Insufficient install permissions"
    }, undefined, new Set([commandId]));

    expect(next.clientUpdateCommandErrors?.[commandId]).toBe("Insufficient install permissions");
    expect(next.tasks.task).toMatchObject({ status: "active", activeTurnId: "turn-1" });
    expect(next.tasks.task?.messages).toEqual([]);
  });
});

const now = Date.parse(timestamp);
function requestFixture(overrides: Partial<ClientUpdateRequest> = {}): ClientUpdateRequest {
  return { commandId, action: "upgrade", state: "waiting", sentAt: now, ...overrides };
}

function panelMarkup(overrides: Partial<Parameters<typeof ClientUpdatePanel>[0]> = {}): string {
  return renderToStaticMarkup(createElement(ClientUpdatePanel, {
    hostName: "Desktop", locale: "en", online: true, agentVersion: "0.5.23",
    update: updateFixture({ status: "available", installWhenIdle: false }), now,
    onAction: () => undefined, onClose: () => undefined, ...overrides
  }));
}

function buttonIsDisabled(markup: string, label: string): boolean {
  const button = [...markup.matchAll(/<button\b([^>]*)>(.*?)<\/button>/g)].find((match) => match[2] === label);
  expect(button, `Missing action: ${label}`).toBeDefined();
  return /\bdisabled(?:=|\s|$)/.test(button![1]!);
}

describe("remote client update command confirmation", () => {
  it("never sends an update command offline, after a delayed authorization, or after a newer request supersedes it", () => {
    const sending = requestFixture({ state: "sending" });
    expect(clientUpdateCommandCanSend(commandId, sending, true, now + 29_999)).toBe(true);
    expect(clientUpdateCommandCanSend(commandId, sending, false, now + 1000)).toBe(false);
    expect(clientUpdateCommandCanSend(commandId, sending, true, now + 30_000)).toBe(false);
    expect(clientUpdateCommandCanSend("33333333-3333-4333-8333-333333333333", sending, true, now + 1000)).toBe(false);
  });

  it("acknowledges only the status for the submitted command", () => {
    expect(reconcileClientUpdateRequest(requestFixture(), updateFixture({
      commandId: "33333333-3333-4333-8333-333333333333"
    }), undefined, now + 10_000).state).toBe("waiting");
    expect(reconcileClientUpdateRequest(requestFixture(), updateFixture(), undefined, now + 10_000).state).toBe("confirmed");
  });

  it("stops waiting after 30 seconds without claiming the install failed", () => {
    expect(reconcileClientUpdateRequest(requestFixture(), undefined, undefined, now + 29_999).state).toBe("waiting");
    expect(reconcileClientUpdateRequest(requestFixture(), undefined, undefined, now + 30_000).state).toBe("unconfirmed");
  });

  it("recovers from a confirmation timeout when the matching state arrives later", () => {
    const timedOut = requestFixture({ state: "unconfirmed" });
    expect(reconcileClientUpdateRequest(timedOut, updateFixture(), undefined, now + 45_000).state).toBe("confirmed");
  });

  it("shows a command rejection separately from the client operation", () => {
    expect(reconcileClientUpdateRequest(requestFixture(), undefined, "Install permissions denied", now + 1000))
      .toMatchObject({ state: "failed", error: "Install permissions denied" });
  });
});

describe("remote client update panel", () => {
  it.each([
    ["en", "Check for updates", "Download and install when idle"],
    ["zh-CN", "检查更新", "后台下载并在空闲时安装"]
  ] as const)("offers update actions in %s", (locale, check, upgrade) => {
    const markup = panelMarkup({ locale });
    expect(buttonIsDisabled(markup, check)).toBe(false);
    expect(buttonIsDisabled(markup, upgrade)).toBe(false);
    expect(markup).toContain('role="dialog"');
  });

  it("explains that old clients need a manual upgrade and disables remote commands", () => {
    const markup = panelMarkup({ update: undefined });
    expect(markup).toContain("Upgrade the desktop client manually to a version that supports remote updates first.");
    expect(buttonIsDisabled(markup, "Check for updates")).toBe(true);
    expect(buttonIsDisabled(markup, "Download and install when idle")).toBe(true);
  });

  it("keeps the cached download and offers canceling only the deferred install", () => {
    const markup = panelMarkup({ update: updateFixture({ status: "downloading", progress: 42.3 }) });
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="42"');
    expect(buttonIsDisabled(markup, "Cancel deferred install")).toBe(false);
    expect(markup).toContain("Downloaded files may remain cached.");
  });

  it("disables commands offline while retaining the deferred install state", () => {
    const markup = panelMarkup({ online: false, offlineAt: now, update: updateFixture() });
    expect(markup).toContain("Waiting for running tasks, approvals, queued tasks and engine maintenance to finish");
    expect(markup).toContain("Connection lost");
    expect(buttonIsDisabled(markup, "Check for updates")).toBe(true);
    expect(buttonIsDisabled(markup, "Cancel deferred install")).toBe(true);
  });

  it("replaces indefinite reconnecting with a bounded recovery hint after five minutes", () => {
    const markup = panelMarkup({ online: false, offlineAt: now, now: now + 300_000,
      update: updateFixture({ status: "installing" }) });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The client has not reconnected after 5 minutes.");
    expect(markup).toContain("Open the desktop client on the computer");
    expect(markup).not.toContain("Update completed");
    expect(markup).not.toContain("Restarting client and reconnecting…");
  });

  it("shows a confirmation timeout and enables checking again", () => {
    const markup = panelMarkup({ request: requestFixture({ action: "check", commandId: "33333333-3333-4333-8333-333333333333" }), now: now + 30_000 });
    expect(markup).toContain("No matching client confirmation after 30 seconds.");
    expect(buttonIsDisabled(markup, "Check for updates")).toBe(false);
    expect(markup).not.toContain("Waiting for client confirmation…");
  });

  it("does not claim success until the target version is actually reported", () => {
    const completed = updateFixture({ status: "completed", currentVersion: "0.5.24", installWhenIdle: false });
    const unverified = panelMarkup({ update: completed, agentVersion: "0.5.23" });
    expect(unverified).toContain("Confirming the running client version");
    expect(unverified).not.toContain("Update completed");
    const verified = panelMarkup({ update: completed, agentVersion: "0.5.24" });
    expect(verified).toContain("Update completed");
    expect(verified).toContain("v0.5.24");
  });

  it("shows the restored version and failure details when installation fails", () => {
    const markup = panelMarkup({ update: updateFixture({ status: "error", installWhenIdle: false,
      message: "Previous client restored after startup failed." }) });
    expect(markup).toContain("Previous client restored after startup failed.");
    expect(markup).toContain("v0.5.23");
    expect(markup).toContain('role="alert"');
  });
});
