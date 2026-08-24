import { describe, expect, it } from "vitest";
import {
  agentEventSchema,
  base64ToBytes,
  bytesToBase64,
  createEnvelope,
  decryptPayload,
  derivePairingKey,
  encryptPayload,
  generatePairingKeyPair,
  importAesKey,
  openEnvelope,
  pageTranscriptMessagesBefore,
  parseAgentEventCompat,
  pairingClaimResponseSchema,
  randomKeyBytes,
  windowTranscriptMessages
} from "./index";

describe("protocol crypto", () => {
  it("round-trips encrypted envelopes", async () => {
    const key = await importAesKey(randomKeyBytes());
    const command = {
      type: "sync.request" as const,
      commandId: crypto.randomUUID()
    };
    const envelope = await createEnvelope(crypto.randomUUID(), 3, key, command);
    await expect(openEnvelope(key, envelope)).resolves.toEqual(command);
  });

  it("derives the same pairing key on both ends", async () => {
    const agent = await generatePairingKeyPair();
    const client = await generatePairingKeyPair();
    const agentPublic = await crypto.subtle.exportKey("jwk", agent.publicKey);
    const clientPublic = await crypto.subtle.exportKey("jwk", client.publicKey);
    const pairingId = crypto.randomUUID();
    const agentKey = await derivePairingKey(agent.privateKey, clientPublic, pairingId);
    const clientKey = await derivePairingKey(client.privateKey, agentPublic, pairingId);
    const raw = randomKeyBytes();
    const rawBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const iv = new Uint8Array(12).buffer;
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      agentKey,
      rawBuffer
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      clientKey,
      encrypted
    );
    expect(new Uint8Array(decrypted)).toEqual(raw);
  });

  it("authorizes the same host key to multiple browser devices", async () => {
    const agent = await generatePairingKeyPair();
    const hostKey = randomKeyBytes();
    for (const pairingId of [crypto.randomUUID(), crypto.randomUUID()]) {
      const browser = await generatePairingKeyPair();
      const agentPublic = await crypto.subtle.exportKey("jwk", agent.publicKey);
      const browserPublic = await crypto.subtle.exportKey("jwk", browser.publicKey);
      const agentPairingKey = await derivePairingKey(agent.privateKey, browserPublic, pairingId);
      const browserPairingKey = await derivePairingKey(browser.privateKey, agentPublic, pairingId);
      const wrapped = await encryptPayload(agentPairingKey, { syncKey: bytesToBase64(hostKey) }, pairingId);
      const unwrapped = await decryptPayload<{ syncKey: string }>(browserPairingKey, wrapped, pairingId);
      expect(unwrapped.syncKey).toBe(bytesToBase64(hostKey));
    }
  });

  it("rejects tampered ciphertext", async () => {
    const key = await importAesKey(randomKeyBytes());
    const envelope = await createEnvelope(crypto.randomUUID(), 1, key, {
      type: "sync.request",
      commandId: crypto.randomUUID()
    });
    envelope.ciphertext = envelope.ciphertext.slice(0, -2) + "AA";
    await expect(openEnvelope(key, envelope)).rejects.toThrow();
  });

  it("decodes URL-safe base64 keys", () => {
    expect(base64ToBytes("-_8")).toEqual(new Uint8Array([251, 255]));
  });

  it("normalizes legacy pairing responses that use hostId", () => {
    const hostId = crypto.randomUUID();
    const response = pairingClaimResponseSchema.parse({
      host: {
        hostId,
        name: "DEV-PC",
        platform: "win32",
        codexVersion: "0.144.1"
      }
    });
    expect(response.host.id).toBe(hostId);
  });

  it("accepts task synchronization completion events", () => {
    const event = agentEventSchema.parse({
      type: "sync.completed",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      threadCount: 12
    });
    expect(event.type).toBe("sync.completed");
    if (event.type !== "sync.completed") throw new Error("Unexpected event type");
    expect(event.threadCount).toBe(12);
  });

  it("accepts command lifecycle, usage, and heartbeat events", () => {
    const base = { eventId: crypto.randomUUID(), occurredAt: new Date().toISOString() };
    expect(agentEventSchema.parse({
      ...base,
      type: "command.status",
      commandId: crypto.randomUUID(),
      status: "accepted",
      threadId: "thread-1"
    }).type).toBe("command.status");
    expect(agentEventSchema.parse({
      ...base,
      type: "usage.updated",
      threadId: "thread-1",
      contextUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }
    }).type).toBe("usage.updated");
    const heartbeat = agentEventSchema.parse({
      ...base,
      type: "thread.heartbeat",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "active",
      lastProgressAt: 123
    });
    expect(heartbeat.type).toBe("thread.heartbeat");
  });

  it("ignores unknown forward-compatible agent event types", () => {
    expect(parseAgentEventCompat({
      type: "future.optional.event",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      value: true
    })).toBeNull();
  });

  it("still rejects malformed payloads for known agent event types", () => {
    expect(() => parseAgentEventCompat({
      type: "turn.completed",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      threadId: "thread-1"
    })).toThrow();
  });

  it("windows recent messages and pages older turns", () => {
    const messages = Array.from({ length: 120 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `turn-${index}`
    }));
    const windowed = windowTranscriptMessages(messages, 80);
    expect(windowed.messages).toHaveLength(80);
    expect(windowed.messageTotal).toBe(120);
    expect(windowed.hasOlderMessages).toBe(true);
    expect(windowed.oldestMessageId).toBe("m40");

    const page = pageTranscriptMessagesBefore(messages, windowed.oldestMessageId, 80);
    expect(page.messages).toHaveLength(40);
    expect(page.messages[0]?.id).toBe("m0");
    expect(page.messages[page.messages.length - 1]?.id).toBe("m39");
    expect(page.hasOlderMessages).toBe(false);
  });

  it("accepts windowed snapshot and history page events", () => {
    const snapshot = agentEventSchema.parse({
      type: "thread.snapshot",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      threadId: "t1",
      title: "demo",
      cwd: "/tmp",
      status: "completed",
      createdAt: 1,
      updatedAt: 2,
      messages: [{ id: "a", role: "user", text: "hi" }],
      messageTotal: 120,
      hasOlderMessages: true,
      oldestMessageId: "a"
    });
    expect(snapshot.type).toBe("thread.snapshot");
    const page = agentEventSchema.parse({
      type: "thread.history.page",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      threadId: "t1",
      messages: [{ id: "b", role: "assistant", text: "earlier" }],
      hasOlderMessages: false,
      oldestMessageId: "b",
      newestMessageId: "b"
    });
    expect(page.type).toBe("thread.history.page");
  });
});
