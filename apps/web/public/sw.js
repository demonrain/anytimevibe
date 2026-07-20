self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const healthResponse = await fetch("/api/health", { credentials: "same-origin" });
    if (!healthResponse.ok) return;
    const health = await healthResponse.json();
    if (!health.vapidPublicKey) return;
    const normalized = health.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(health.vapidPublicKey.length / 4) * 4, "=");
    const binary = atob(normalized);
    const applicationServerKey = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let subscription = await self.registration.pushManager.getSubscription();
    subscription ??= await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    await fetch("/api/push/subscriptions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription.toJSON())
    });
  })());
});
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = { body: event.data?.text() || "远程任务状态已更新。" };
    }
    await self.registration.showNotification(data.title || "随码", {
      body: data.body || "远程任务状态已更新。",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" }
    });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => "focus" in client);
    if (existing) return existing.focus();
    return self.clients.openWindow(event.notification.data.url || "/");
  }));
});
