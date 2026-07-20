import { describe, expect, it, vi } from "vitest";
import { syncPushSubscription, type PushEnvironment } from "./push";

function subscriptionFor(key: Uint8Array, endpoint: string): PushSubscription {
  return {
    endpoint,
    options: { applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) },
    toJSON: () => ({ endpoint, keys: { p256dh: "p256dh", auth: "auth" } }),
    unsubscribe: vi.fn(async () => true)
  } as unknown as PushSubscription;
}

function environmentFor(options: {
  permission?: NotificationPermission;
  existing?: PushSubscription | null;
  created?: PushSubscription;
}) {
  const save = vi.fn(async () => undefined);
  const subscribe = vi.fn(async () => options.created ?? subscriptionFor(new Uint8Array([1, 2, 3]), "https://push/new"));
  const environment: PushEnvironment = {
    permission: () => options.permission ?? "granted",
    requestPermission: vi.fn(async (): Promise<NotificationPermission> => "granted"),
    ready: vi.fn(async () => ({
      pushManager: {
        getSubscription: vi.fn(async () => options.existing ?? null),
        subscribe
      } as unknown as PushManager
    })),
    save
  };
  return { environment, save, subscribe };
}

describe("syncPushSubscription", () => {
  it("re-registers an existing matching subscription with the relay", async () => {
    const key = new Uint8Array([1, 2, 3]);
    const existing = subscriptionFor(key, "https://push/existing");
    const { environment, save, subscribe } = environmentFor({ existing });

    await expect(syncPushSubscription("AQID", {}, environment)).resolves.toBe("enabled");
    expect(subscribe).not.toHaveBeenCalled();
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(existing);
  });

  it("replaces a subscription created with an old VAPID key", async () => {
    const existing = subscriptionFor(new Uint8Array([9, 9, 9]), "https://push/old");
    const created = subscriptionFor(new Uint8Array([1, 2, 3]), "https://push/new");
    const { environment, save, subscribe } = environmentFor({ existing, created });

    await expect(syncPushSubscription("AQID", {}, environment)).resolves.toBe("enabled");
    expect(existing.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(save).toHaveBeenCalledWith(created);
  });

  it("does not request permission during automatic login repair", async () => {
    const { environment } = environmentFor({ permission: "default" });

    await expect(syncPushSubscription("AQID", {}, environment)).resolves.toBe("permission-needed");
    expect(environment.requestPermission).not.toHaveBeenCalled();
    expect(environment.ready).not.toHaveBeenCalled();
  });
});
