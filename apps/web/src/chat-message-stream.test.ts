import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anytimevibe/protocol";
import { ChatMessageStream, reduceEvent } from "./App";
import { I18nProvider } from "./i18n/I18nProvider";

type StreamProps = ComponentProps<typeof ChatMessageStream>;
type Message = StreamProps["messages"][number];

function renderStream(messages: Message[], replyDetail: StreamProps["replyDetail"] = "concise") {
  const props: StreamProps = {
    messages, replyDetail, taskEngine: "codex", processLabel: "Process",
    pendingPrompt: "", showPendingBubble: false, pendingFailed: false, running: false,
    processingLabel: "Running", processingHint: "Working",
    showFailureBanner: false, failureTitle: "Failed", failureBody: "",
    canResend: false, resendTitle: "Resend", resendHint: "", resendLabel: "Resend", onResend() {},
    commandQueue: [], queueLabel: "Queue", cancelQueueLabel: "Cancel", cancelQueueAllLabel: "Cancel all",
    steerQueueLabel: "Run next", canSteerQueuedItem: false, online: true,
    onCancelQueuedItem() {}, onCancelAllQueued() {}, onSteerQueuedItem() {},
    approvals: [], actionRequiredLabel: "Approval", declineLabel: "Decline", allowOnceLabel: "Allow", onCommand() {},
    stickToBottomRef: { current: true }, messageStreamRef: { current: null }, messageEndRef: { current: null },
    hasOlderMessages: false, historyLoading: false, onLoadOlder() {},
    loadOlderLabel: "Load older", loadingOlderLabel: "Loading"
  };
  return renderToStaticMarkup(createElement(I18nProvider, null, createElement(ChatMessageStream, props)));
}

function runtimeFixture() {
  return {
    online: true,
    workspaces: [],
    tasks: {
      "thread-1": {
        threadId: "thread-1", title: "Task", cwd: "C:/repo", status: "active",
        activeTurnId: "turn-1", updatedAt: 1, diff: "", messages: [], approvals: []
      }
    }
  } as Parameters<typeof reduceEvent>[0];
}

function deltaEvent(delta: string, itemId = "native-message", threadId = "thread-1"): AgentEvent {
  return {
    type: "turn.delta", eventId: "22222222-2222-4222-8222-222222222222",
    occurredAt: "2026-10-09T00:00:00.000Z", threadId, turnId: "turn-1", itemId, delta
  };
}

describe("assistant stream display", () => {
  it.each(["concise", "detailed"] as const)("hides Codex whitespace placeholders in %s mode", (detail) => {
    const runtime = reduceEvent(runtimeFixture(), deltaEvent(" \n\t"));
    const html = renderStream(runtime.tasks["thread-1"]!.messages, detail);

    expect(html).not.toContain('class="message assistant');
    expect(html).not.toContain('class="message-head"');
  });

  it("hides empty and control-only assistant messages from historical snapshots", () => {
    const html = renderStream([
      { id: "native-empty", role: "assistant", text: "" },
      { id: "native-control", role: "assistant", text: "\u0000\u0008\u007f \n" },
      { id: "native-reply", role: "assistant", text: "The change is complete." }
    ]);

    expect(html.match(/class="message assistant/g)).toHaveLength(1);
    expect(html).toContain("The change is complete.");
  });

  it.each(["```", "```typescript\n", "~~~python\n \n~~~"])("waits for content after a streaming code fence: %j", (text) => {
    const html = renderStream([{ id: "assistant:turn-1:code", role: "assistant", text }]);
    expect(html).not.toContain('class="message assistant');
  });

  it("keeps tool output hidden in concise mode while retaining actual code replies", () => {
    const messages: Message[] = [
      { id: "assistant:turn-1:exec:command", role: "assistant", text: "private tool output" },
      { id: "assistant:turn-1:stage:command", role: "assistant", text: "Running command" },
      { id: "assistant:turn-1:native-code", role: "assistant", text: "```typescript\nconst answer = 42;\n```" }
    ];
    const concise = renderStream(messages);
    expect(concise).not.toContain("private tool output");
    expect(concise).not.toContain("Running command");
    expect(concise).toContain("const answer = 42;");
    expect(renderStream(messages, "detailed")).toContain("private tool output");
  });

  it("preserves whitespace deltas and code indentation once the body arrives", () => {
    let runtime = reduceEvent(runtimeFixture(), deltaEvent("```typescript\n"));
    runtime = reduceEvent(runtime, deltaEvent("    "));
    expect(renderStream(runtime.tasks["thread-1"]!.messages)).not.toContain('class="message assistant');

    runtime = reduceEvent(runtime, deltaEvent("const answer = 42;"));
    runtime = reduceEvent(runtime, deltaEvent("\n\n"));
    runtime = reduceEvent(runtime, deltaEvent("```"));

    expect(runtime.tasks["thread-1"]!.messages[0]?.text).toBe("```typescript\n    const answer = 42;\n\n```");
    expect(renderStream(runtime.tasks["thread-1"]!.messages)).toContain("    const answer = 42;");
  });

  it.each(["```\nconst answer = 42;\n```", "    const answer = 42;\n", "```html\n<div>hello</div>\n```"])("renders code blocks without relying on a language tag: %j", (text) => {
    const html = renderStream([{ id: "assistant:turn-1:code", role: "assistant", text }]);
    expect(html).toContain('<pre class="md-code-block">');
    expect(html).toContain(text.includes("hello") ? "&lt;div&gt;hello&lt;/div&gt;" : "const answer = 42;");
  });
});

describe("empty stream events", () => {
  it("does not create an empty reply for a zero-length delta", () => {
    const runtime = reduceEvent(runtimeFixture(), deltaEvent(""));
    expect(runtime.tasks["thread-1"]!.messages).toEqual([]);
  });

  it("does not create a task for a zero-length delta on an unknown thread", () => {
    const runtime = reduceEvent(runtimeFixture(), deltaEvent("", "native-message", "unknown-thread"));
    expect(runtime.tasks["unknown-thread"]).toBeUndefined();
  });
});
