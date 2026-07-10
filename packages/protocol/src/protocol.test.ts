import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  createEnvelope,
  derivePairingKey,
  generatePairingKeyPair,
  importAesKey,
  openEnvelope,
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
});
