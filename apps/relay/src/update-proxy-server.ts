import { readFile } from "node:fs/promises";
import { createUpdateProxyServer } from "./update-proxy.js";

const secret = process.env.UPDATE_PROXY_TOKEN_SECRET || "";
const certificate = process.env.UPDATE_PROXY_TLS_CERT;
const key = process.env.UPDATE_PROXY_TLS_KEY;
if (!!certificate !== !!key) throw new Error("UPDATE_PROXY_TLS_CERT and UPDATE_PROXY_TLS_KEY must be configured together");
const tls = certificate && key ? { cert: await readFile(certificate), key: await readFile(key) } : undefined;
const host = process.env.UPDATE_PROXY_BIND || (tls ? "0.0.0.0" : "127.0.0.1");
if (!tls && !["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Plaintext update proxy must bind only to loopback");
const port = Number(process.env.UPDATE_PROXY_PORT || 9443);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("UPDATE_PROXY_PORT must be a valid TCP port");
const server = createUpdateProxyServer({ secret, ...(tls ? { tls } : {}) });
server.listen(port, host, () => console.log(`Update maintenance proxy listening on ${host}:${port} (${tls ? "HTTPS" : "loopback HTTP"})`));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
