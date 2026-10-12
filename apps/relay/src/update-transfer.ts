import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { registerUpdateRelayRoutes } from "./update-relay.js";

// The transfer service has no database, pairing, task, or model/API responsibilities.
const app = Fastify({ logger: { level: "info" } });
await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
registerUpdateRelayRoutes(app, {
  publicOrigin: process.env.UPDATE_TRANSFER_URL || process.env.PUBLIC_ORIGIN || "http://127.0.0.1:8788",
  ...(process.env.UPDATE_FEED_URL ? { feedUrl: process.env.UPDATE_FEED_URL } : {}),
  ...(process.env.NPM_REGISTRY_ORIGIN ? { npmRegistryOrigin: process.env.NPM_REGISTRY_ORIGIN } : {}),
  ...(process.env.UPDATE_CACHE_DIR ? { cacheDir: process.env.UPDATE_CACHE_DIR } : {})
});
app.get("/api/health", async () => ({ ok: true, service: "update-transfer" }));
const port = Number(process.env.PORT || 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
await app.listen({ host: process.env.HOST || "127.0.0.1", port });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  void app.close().then(() => process.exit(0), () => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
});
