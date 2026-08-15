import type { CliEngine, ContextUsage, PermissionMode, ReasoningEffort } from "@anytimevibe/protocol";

export type StreamDeltaKind = "assistant" | "stage" | "exec" | "cli-log" | "thought";

export type ApprovalQuestion = {
  id: string;
  prompt: string;
  options: Array<{ id: string; label: string }>;
  allowMultiple?: boolean;
};

export type ApprovalPlan = {
  name?: string;
  overview?: string;
  plan: string;
  todos?: Array<{ id: string; content: string; status?: string }>;
};

export type BackendStreamEvent =
  | { type: "delta"; threadId: string; turnId: string; itemId: string; kind: StreamDeltaKind; delta: string }
  | { type: "turn.started"; threadId: string; turnId: string; prompt?: string }
  | { type: "turn.completed"; threadId: string; turnId: string; status: string; contextUsage?: ContextUsage }
  | { type: "session"; threadId: string; providerSessionId: string }
  | { type: "error"; threadId?: string; message: string }
  | { type: "usage"; threadId: string; contextUsage: ContextUsage }
  | {
      type: "approval.requested";
      threadId: string;
      turnId: string;
      requestId: string;
      itemId: string;
      approvalType: "plan" | "question" | "command" | "file" | "permission" | "input";
      title: string;
      detail: string;
      availableDecisions: Array<"accept" | "decline" | "cancel">;
      plan?: ApprovalPlan;
      questions?: ApprovalQuestion[];
      permissionMode?: PermissionMode;
    };

export type StoredTask = {
  threadId: string;
  engine: CliEngine;
  providerSessionId: string;
  cwd: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Cursor: extended-thinking variant enabled for this thread. */
  thinking?: boolean;
  /** Last web permission mode — reused by interactive CLI handoff. */
  permissionMode?: PermissionMode;
  contextUsage?: ContextUsage;
  /** Last known unified diff / git status for the Diff tab (persisted across reconnect). */
  lastDiff?: string;
  messages: Array<{ id: string; role: "user" | "assistant" | "system"; text: string }>;
};

export type HeadlessRunOptions = {
  threadId: string;
  turnId: string;
  cwd: string;
  prompt: string;
  permissionMode: PermissionMode;
  /** Resume existing provider session when set. */
  providerSessionId?: string;
  /** Prefer creating with this session id when supported. */
  preferredSessionId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Cursor: enable the model's extended-thinking variant when the base supports it. */
  thinking?: boolean;
  /**
   * Internal: Cursor stall retry without --resume already attempted.
   * Skips a second turn.started so the web does not duplicate the user bubble.
   */
  cursorResumeRetried?: boolean;
  /**
   * Internal: Antigravity retry without --conversation already attempted
   * (bogus AnytimeVibe thread UUID / deleted brain id → trajectory not found).
   */
  agyConversationRetried?: boolean;
};

export type HeadlessRunResult = {
  /** Native CLI session id when known; empty string means "do not persist / clear". */
  providerSessionId: string;
  status: "completed" | "failed" | "interrupted";
  text: string;
  contextUsage?: ContextUsage;
  /** Model actually used by the CLI when reported. */
  model?: string;
  /** When true, caller should clear a previously stored providerSessionId. */
  clearProviderSession?: boolean;
};

export function normalizeCliEngine(value: string | null | undefined): CliEngine {
  if (value === "claude" || value === "grok" || value === "codex" || value === "cursor" || value === "antigravity") {
    return value;
  }
  return "codex";
}

export function isHeadlessCliEngine(engine: CliEngine): engine is Exclude<CliEngine, "codex"> {
  return engine !== "codex";
}

export function cliEngineDisplayName(engine: CliEngine): string {
  if (engine === "claude") return "Claude Code";
  if (engine === "grok") return "Grok Build";
  if (engine === "cursor") return "Cursor Agent";
  if (engine === "antigravity") return "Antigravity";
  return "Codex";
}
