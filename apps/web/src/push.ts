import { base64ToBytes } from "@anytimevibe/protocol";
import { api } from "./api";

export type PushSubscriptionStatus = "enabled" | "permission-needed" | "unsupported";

export type PushEnvironment = {
  permission: () => NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  ready: () => Promise<Pick<ServiceWorkerRegistration, "pushManager">>;
  save: (subscription: PushSubscription) => Promise<void>;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bufferSourceBytes(value: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

export function applicationServerKeyMatches(subscription: PushSubscription, expected: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const currentBytes = bufferSourceBytes(current);
  return currentBytes.length === expected.length && currentBytes.every((byte, index) => byte === expected[index]);
}

function browserPushEnvironment(): PushEnvironment | null {
  if (
    typeof window === "undefined"
    || typeof Notification === "undefined"
    || !("serviceWorker" in navigator)
    || !("PushManager" in window)
  ) {
    return null;
  }
  return {
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    ready: () => navigator.serviceWorker.ready,
    save: async (subscription) => {
      const serialized = subscription.toJSON();
      if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) {
        throw new Error("浏览器返回的通知订阅不完整，请重新开启通知。");
      }
      await api("/api/push/subscriptions", { method: "POST", body: JSON.stringify(serialized) });
    }
  };
}

export async function syncPushSubscription(
  vapidPublicKey: string | null,
  options: { requestPermission?: boolean } = {},
  environment: PushEnvironment | null = browserPushEnvironment()
): Promise<PushSubscriptionStatus> {
  if (!vapidPublicKey) throw new Error("服务端尚未配置 Web Push 密钥。");
  if (!environment) {
    if (options.requestPermission) throw new Error("当前浏览器不支持 Web Push。");
    return "unsupported";
  }

  let permission = environment.permission();
  if (options.requestPermission && permission !== "granted") {
    permission = await environment.requestPermission();
  }
  if (permission !== "granted") {
    if (options.requestPermission) throw new Error("通知权限未授予。");
    return "permission-needed";
  }

  const expectedKey = base64ToBytes(vapidPublicKey);
  const registration = await environment.ready();
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !applicationServerKeyMatches(subscription, expectedKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: toArrayBuffer(expectedKey)
  });
  await environment.save(subscription);
  return "enabled";
}
