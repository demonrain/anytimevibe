import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

/**
 * Web / monorepo product version (display + packaging).
 * Desktop agent has its own version (host.status.agentVersion); web no longer hard-requires equality.
 * Soft update prompts use the latest GitHub client release from the relay health endpoint.
 */
export const PRODUCT_VERSION = "0.4.42";
/**
 * @deprecated Not a hard gate. Kept for older clients; web uses health.latestClientVersion instead.
 */
export const MIN_AGENT_VERSION = PRODUCT_VERSION;

/** Compare dotted versions (ignores leading v). Returns negative if a < b. */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string) =>
    value.replace(/^v/i, "").split(/[.+-]/).map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const encryptedEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  messageId: z.string().uuid(),
  hostId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  sentAt: z.string().datetime(),
  keyId: z.string().min(1),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
  persist: z.boolean().default(false),
  hint: z.enum(["approval", "completed"]).optional()
});

export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1)
});

export type Workspace = z.infer<typeof workspaceSchema>;

const commandBase = z.object({ commandId: z.string().uuid() });
/** Align with Codex CLI permission labels: Read Only / Ask for approval / Approve for me / Full Access */
export const permissionModeSchema = z.enum([
  "read-only",
  "ask-for-approval",
  "approve-for-me",
  "full-access",
  // legacy values still accepted from older web clients
  "inherit",
  "workspace-write"
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

/** Local coding CLI backend used by the desktop agent. */
export const cliEngineSchema = z.enum(["codex", "claude", "grok", "cursor"]);
export type CliEngine = z.infer<typeof cliEngineSchema>;

export const cliEngineInfoSchema = z.object({
  engine: cliEngineSchema,
  ready: z.boolean(),
  version: z.string().optional(),
  detail: z.string().optional()
});
export type CliEngineInfo = z.infer<typeof cliEngineInfoSchema>;

/** Reasoning / thinking intensity — vendor labels differ; values are normalized. */
export const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/** A model selectable on the host for a given coding CLI. */
export const engineModelOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().positive().optional(),
  /**
   * Cursor (and similar): model supports a Fast variant.
   * Web/agent encode as `--model id[fast=true|false]` when set.
   */
  supportsFast: z.boolean().optional(),
  /**
   * Per-model reasoning/effort levels. When set, UI should prefer these over
   * the engine-level `reasoningEfforts` list for this model only.
   */
  reasoningEfforts: z.array(reasoningEffortSchema).optional()
});
export type EngineModelOption = z.infer<typeof engineModelOptionSchema>;

/** Host-reported model/effort catalog for one engine (from local CLI config/cache). */
export const engineCapabilitySchema = z.object({
  engine: cliEngineSchema,
  models: z.array(engineModelOptionSchema),
  reasoningEfforts: z.array(reasoningEffortSchema),
  currentModel: z.string().optional(),
  currentReasoningEffort: reasoningEffortSchema.optional()
});
export type EngineCapability = z.infer<typeof engineCapabilitySchema>;

export const contextUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
  /** Model context window size when known. */
  contextWindow: z.number().positive().optional(),
  remainingTokens: z.number().nonnegative().optional(),
  /**
   * Optional subscription / plan quota (when the local CLI reports it).
   * Display-only: engines rarely expose full billing pools.
   */
  planRemaining: z.number().nonnegative().optional(),
  planLimit: z.number().positive().optional(),
  planLabel: z.string().trim().min(1).max(80).optional()
});
export type ContextUsage = z.infer<typeof contextUsageSchema>;

/**
 * Host-level subscription / plan usage for one coding engine (queried on demand).
 * Prefer percent remaining; if monetary, use amountRemaining + currency.
 */
export const engineQuotaSchema = z.object({
  engine: cliEngineSchema,
  /** Short display label, e.g. "Pro plan" / "API credits". */
  label: z.string().trim().min(1).max(80).optional(),
  /** Remaining share of the pool, 0–100. */
  remainingPercent: z.number().min(0).max(100).optional(),
  /** Used share of the pool, 0–100. */
  usedPercent: z.number().min(0).max(100).optional(),
  /** Remaining absolute units (requests, tokens, etc.). */
  remaining: z.number().nonnegative().optional(),
  limit: z.number().positive().optional(),
  /** Remaining money when the plan is prepaid / credits-based. */
  amountRemaining: z.number().optional(),
  amountLimit: z.number().optional(),
  currency: z.string().trim().min(1).max(8).optional(),
  /** Free-form summary when structured fields are incomplete. */
  detail: z.string().trim().min(1).max(240).optional(),
  /** ISO timestamp of this sample. */
  checkedAt: z.string().datetime().optional()
});
export type EngineQuota = z.infer<typeof engineQuotaSchema>;

export const clientCommandSchema = z.discriminatedUnion("type", [
  commandBase.extend({
    type: z.literal("task.create"),
    cwd: z.string().min(1),
    prompt: z.string().min(1),
    title: z.string().min(1).max(160).optional(),
    permissionMode: permissionModeSchema.optional(),
    /** Override host default CLI engine for this task. */
    cliEngine: cliEngineSchema.optional(),
    /** Optional model id / alias for the selected engine. */
    model: z.string().trim().min(1).max(120).optional(),
    /** Optional reasoning effort (Codex/Claude/Grok naming mapped server-side). */
    reasoningEffort: reasoningEffortSchema.optional()
  }),
  commandBase.extend({
    type: z.literal("thread.resume"),
    threadId: z.string().min(1)
  }),
  commandBase.extend({
    type: z.literal("turn.start"),
    threadId: z.string().min(1),
    prompt: z.string().min(1),
    permissionMode: permissionModeSchema.optional(),
    model: z.string().trim().min(1).max(120).optional(),
    reasoningEffort: reasoningEffortSchema.optional()
  }),
  commandBase.extend({
    type: z.literal("turn.steer"),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    prompt: z.string().min(1)
  }),
  commandBase.extend({
    type: z.literal("turn.interrupt"),
    threadId: z.string().min(1),
    turnId: z.string().min(1)
  }),
  commandBase.extend({
    type: z.literal("approval.resolve"),
    requestId: z.union([z.string(), z.number()]),
    decision: z.enum(["accept", "decline", "cancel"])
  }),
  commandBase.extend({
    type: z.literal("sync.request"),
    /** Recent threads to fully load per coding engine (default 10). Ignored when query is set. */
    limit: z.number().int().positive().max(100).optional(),
    /** Fuzzy search across titles/previews; may load more than limit to find matches. */
    query: z.string().trim().max(200).optional()
  }),
  /** Ask the agent to re-publish host.status (workspaces, online, versions). Does not require Codex. */
  commandBase.extend({
    type: z.literal("host.refresh")
  }),
  /**
   * Ask the agent to query local CLI account / subscription remaining usage.
   * Optional engine filter; omit to refresh all detected engines.
   */
  commandBase.extend({
    type: z.literal("host.quota.refresh"),
    cliEngine: cliEngineSchema.optional()
  }),
  /** Set the host default coding CLI engine (persisted on the agent). */
  commandBase.extend({
    type: z.literal("host.set_cli_engine"),
    cliEngine: cliEngineSchema
  })
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;

const eventBase = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime()
});

export const agentEventSchema = z.discriminatedUnion("type", [
  eventBase.extend({
    type: z.literal("host.status"),
    online: z.boolean(),
    name: z.string(),
    platform: z.string(),
    codexVersion: z.string(),
    workspaces: z.array(workspaceSchema),
    detail: z.string().optional(),
    /** Preferred coding CLI on this host. */
    cliEngine: cliEngineSchema.optional(),
    /** Detected engines and readiness. */
    availableEngines: z.array(cliEngineInfoSchema).optional(),
    /** Per-engine model/effort catalogs from the host machine. */
    engineCapabilities: z.array(engineCapabilitySchema).optional(),
    /** Desktop agent app version (AnytimeVibe client). */
    agentVersion: z.string().optional(),
    /** Latest subscription / plan quotas from local CLIs (if available). */
    engineQuotas: z.array(engineQuotaSchema).optional()
  }),
  eventBase.extend({
    type: z.literal("host.quota"),
    engineQuotas: z.array(engineQuotaSchema),
    /** Optional human-readable summary when a query partially fails. */
    detail: z.string().optional()
  }),
  eventBase.extend({
    type: z.literal("sync.completed"),
    threadCount: z.number().int().nonnegative(),
    /** True when only a recent window was loaded (not a full history dump). */
    partial: z.boolean().optional(),
    query: z.string().optional()
  }),
  eventBase.extend({
    type: z.literal("sync.progress"),
    current: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    title: z.string().optional()
  }),
  eventBase.extend({
    type: z.literal("thread.snapshot"),
    threadId: z.string(),
    title: z.string(),
    cwd: z.string(),
    status: z.string(),
    activeTurnId: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    /** Which coding CLI owns this thread. */
    cliEngine: cliEngineSchema.optional(),
    /** Provider-native session id (Claude/Grok); used to collapse import duplicates on web. */
    providerSessionId: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    contextUsage: contextUsageSchema.optional(),
    /** Unified diff / git status for the task Diff tab (optional; may be large). */
    diff: z.string().max(500_000).optional(),
    messages: z.array(z.object({
      id: z.string(),
      role: z.enum(["user", "assistant", "system"]),
      text: z.string(),
      createdAt: z.number().optional()
    }))
  }),
  eventBase.extend({
    type: z.literal("turn.started"),
    threadId: z.string(),
    turnId: z.string(),
    prompt: z.string().optional()
  }),
  eventBase.extend({
    type: z.literal("turn.delta"),
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    delta: z.string()
  }),
  eventBase.extend({
    type: z.literal("turn.completed"),
    threadId: z.string(),
    turnId: z.string(),
    status: z.string(),
    contextUsage: contextUsageSchema.optional(),
    /** Failure reason when status is failed / systemerror / error. */
    errorMessage: z.string().max(4000).optional()
  }),
  eventBase.extend({
    type: z.literal("diff.updated"),
    threadId: z.string(),
    turnId: z.string(),
    diff: z.string()
  }),
  eventBase.extend({
    type: z.literal("approval.requested"),
    requestId: z.union([z.string(), z.number()]),
    threadId: z.string(),
    turnId: z.string(),
    itemId: z.string(),
    approvalType: z.enum(["command", "file", "permission", "input"]),
    title: z.string(),
    detail: z.string(),
    availableDecisions: z.array(z.enum(["accept", "decline", "cancel"]))
  }),
  eventBase.extend({
    type: z.literal("request.resolved"),
    requestId: z.union([z.string(), z.number()]),
    threadId: z.string().optional()
  }),
  eventBase.extend({
    type: z.literal("error"),
    message: z.string(),
    commandId: z.string().uuid().optional(),
    threadId: z.string().optional()
  })
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;

export type PairingPublicInfo = {
  pairingId: string;
  code: string;
  agentName: string;
  platform: string;
  codexVersion: string;
  agentPublicKey: JsonWebKey;
  expiresAt: string;
};

export type PairingClaim = {
  clientPublicKey: JsonWebKey;
  wrappedSyncKey: WrappedPayload;
};

export const pairingClaimResponseSchema = z.object({
  host: z.object({
    id: z.string().uuid().optional(),
    hostId: z.string().uuid().optional(),
    name: z.string().min(1),
    platform: z.string().min(1),
    codexVersion: z.string().min(1)
  }).refine((host) => Boolean(host.id ?? host.hostId), {
    message: "Pairing response is missing a host identifier"
  }).transform((host) => ({ ...host, id: host.id ?? host.hostId! }))
});

export type PairingClaimResponse = z.infer<typeof pairingClaimResponseSchema>;

export type WrappedPayload = {
  nonce: string;
  ciphertext: string;
};

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(normalized, "base64"));
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), "AES-GCM", extractable, ["encrypt", "decrypt"]);
}

export function randomKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function encryptPayload(
  key: CryptoKey,
  payload: unknown,
  additionalData?: string
): Promise<WrappedPayload> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: additionalData ? new TextEncoder().encode(additionalData) : undefined
    },
    key,
    encoded
  );
  return { nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}

export async function decryptPayload<T>(
  key: CryptoKey,
  payload: WrappedPayload,
  additionalData?: string
): Promise<T> {
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(base64ToBytes(payload.nonce)),
      additionalData: additionalData ? new TextEncoder().encode(additionalData) : undefined
    },
    key,
    toArrayBuffer(base64ToBytes(payload.ciphertext))
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

export async function generatePairingKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
}

export async function derivePairingKey(
  privateKey: CryptoKey,
  remotePublicKey: JsonWebKey,
  pairingId: string
): Promise<CryptoKey> {
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    remotePublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(pairingId),
      info: new TextEncoder().encode("anytimevibe/pairing/v1")
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function createEnvelope(
  hostId: string,
  sequence: number,
  key: CryptoKey,
  payload: ClientCommand | AgentEvent,
  options: { persist?: boolean; hint?: "approval" | "completed" } = {}
): Promise<EncryptedEnvelope> {
  const messageId = crypto.randomUUID();
  const encrypted = await encryptPayload(key, payload, `${PROTOCOL_VERSION}:${messageId}:${hostId}`);
  return {
    v: PROTOCOL_VERSION,
    messageId,
    hostId,
    sequence,
    sentAt: new Date().toISOString(),
    keyId: "sync-v1",
    ...encrypted,
    persist: options.persist ?? false,
    ...(options.hint ? { hint: options.hint } : {})
  };
}

export async function openEnvelope<T>(key: CryptoKey, envelope: EncryptedEnvelope): Promise<T> {
  return decryptPayload<T>(key, envelope, `${envelope.v}:${envelope.messageId}:${envelope.hostId}`);
}
