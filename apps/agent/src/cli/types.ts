import type { CliEngine, ContextUsage, PermissionMode, ReasoningEffort } from "@anytimevibe/protocol";

export type StreamDeltaKind = "assistant" | "stage" | "exec" | "cli-log" | "thought";

export type BackendStreamEvent =
  | { type: "delta"; threadId: string; turnId: string; itemId: string; kind: StreamDeltaKind; delta: string }
  | { type: "turn.started"; threadId: string; turnId: string; prompt?: string }
  | { type: "turn.completed"; threadId: string; turnId: string; status: string; contextUsage?: ContextUsage }
  | { type: "session"; threadId: string; providerSessionId: string }
  | { type: "error"; threadId?: string; message: string }
  | { type: "usage"; threadId: string; contextUsage: ContextUsage };

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
  contextUsage?: ContextUsage;
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
};

export type HeadlessRunResult = {
  providerSessionId: string;
  status: "completed" | "failed" | "interrupted";
  text: string;
  contextUsage?: ContextUsage;
  /** Model actually used by the CLI when reported. */
  model?: string;
};

export function normalizeCliEngine(value: string | null | undefined): CliEngine {
  if (value === "claude" || value === "grok" || value === "codex") return value;
  return "codex";
}
