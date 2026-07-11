import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

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

export const clientCommandSchema = z.discriminatedUnion("type", [
  commandBase.extend({
    type: z.literal("task.create"),
    cwd: z.string().min(1),
    prompt: z.string().min(1),
    title: z.string().min(1).max(160).optional()
  }),
  commandBase.extend({
    type: z.literal("thread.resume"),
    threadId: z.string().min(1)
  }),
  commandBase.extend({
    type: z.literal("turn.start"),
    threadId: z.string().min(1),
    prompt: z.string().min(1)
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
  commandBase.extend({ type: z.literal("sync.request") })
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
    detail: z.string().optional()
  }),
  eventBase.extend({
    type: z.literal("sync.completed"),
    threadCount: z.number().int().nonnegative()
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
    status: z.string()
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
