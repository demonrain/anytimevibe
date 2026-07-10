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
  pairingClaimResponseSchema,
  randomKeyBytes
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
});
