import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import webPush from "web-push";
import { z } from "zod";
import { encryptedEnvelopeSchema, type EncryptedEnvelope } from "@anytimevibe/protocol";
import { registerAdminRoutes, resolveRegistrationPolicy } from "./admin.js";
import { loadConfig } from "./config.js";
import { createDatabase, ensureSchema, type Database } from "./db.js";
import { hashPassword, hashToken, openSecret, randomToken, safeEqual, sealSecret, verifyPassword } from "./security.js";

const SESSION_COOKIE = "av_session";
const SESSION_DAYS = 30;

type User = { id: string; username: string; isAdmin: boolean };

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "close" | "error", listener: () => void): void;
};

/** Traditional handle: letters, digits, underscore, dot, hyphen. */
const usernameHandlePattern = /^[a-zA-Z0-9_.-]+$/;
/**
 * Practical email for registration / login identity (stored in users.username).
 * Keeps validation permissive enough for common addresses without being a full RFC parser.
 */
const usernameEmailPattern =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const usernameField = z
  .string()
  .trim()
  .min(3, "用户名或邮箱至少 3 个字符")
  .max(128, "用户名或邮箱最多 128 个字符")
  .refine(
    (value) => usernameHandlePattern.test(value) || usernameEmailPattern.test(value),
    "请填写用户名（字母、数字、下划线、点、短横线）或有效邮箱"
  );

const passwordField = z
  .string()
  .min(6, "密码至少 6 位")
  .max(256, "密码过长");

function normalizeAccountName(username: string): string {
  // Email identity is case-insensitive; keep handle casing as entered.
  return username.includes("@") ? username.toLowerCase() : username;
}

const setupBody = z.object({
  setupToken: z.string().min(1, "请填写设置令牌"),
  username: usernameField,
  password: passwordField
}).transform((body) => ({ ...body, username: normalizeAccountName(body.username) }));

const loginBody = z.object({
  username: z.string().trim().min(1, "请输入用户名或邮箱"),
  password: z.string().min(1, "请输入密码")
}).transform((body) => ({ ...body, username: normalizeAccountName(body.username) }));

const registerBody = z.object({
  username: usernameField,
  password: passwordField
}).transform((body) => ({ ...body, username: normalizeAccountName(body.username) }));

const agentPairBody = z.object({
  secret: z.string().min(24),
  agentId: z.string().uuid(),
  agentName: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(80),
  codexVersion: z.string().trim().min(1).max(80),
  agentPublicKey: z.record(z.unknown())
});

const claimBody = z.object({
  clientPublicKey: z.record(z.unknown())
});

const authorizePairingBody = z.object({
  wrappedSyncKey: z.object({ nonce: z.string().min(1), ciphertext: z.string().min(1) })
});
const browserKeyAuthorizationBody = z.object({ clientPublicKey: z.record(z.unknown()) });

const pushBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) })
});

function pairingCode(): string {
  return String(Math.floor(100_000 + Math.random() * 900_000));
}

function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60
  });
}

async function userFromRequest(sql: Database, request: FastifyRequest): Promise<User | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const rows = await sql<Array<{ id: string; username: string; isAdmin: boolean; disabledAt: string | null }>>`
    SELECT users.id, users.username, users.is_admin, users.disabled_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ${hashToken(token)}
      AND sessions.expires_at > now()
    LIMIT 1
  `;
  const user = rows[0];
  if (!user || user.disabledAt) return null;
  return { id: user.id, username: user.username, isAdmin: user.isAdmin };
}

async function requireUser(
  sql: Database,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<User | null> {
  const user = await userFromRequest(sql, request);
  if (!user) reply.code(401).send({ error: "unauthorized" });
  return user;
}

function jsonControl(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, ...data });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const sql = createDatabase(config.DATABASE_URL);
  await ensureSchema(sql);

  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
    webPush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
  }

  const app = Fastify({ logger: { level: config.NODE_ENV === "production" ? "info" : "debug" } });
  await app.register(cookie, { secret: config.COOKIE_SECRET });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

  app.addHook("onRequest", async (request, reply) => {
    if (config.NODE_ENV !== "production") return;
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (request.url.startsWith("/api/agent/")) return;
    if (request.headers.origin !== config.PUBLIC_ORIGIN) {
      return reply.code(403).send({ error: "invalid_origin" });
    }
  });

  const agentSockets = new Map<string, SocketLike>();
  const clientSockets = new Map<string, Set<SocketLike>>();

  function broadcastToUser(userId: string, payload: string): void {
    const sockets = clientSockets.get(userId);
    if (!sockets) return;
    for (const socket of sockets) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  async function sendPush(userId: string, hint: "approval" | "completed"): Promise<void> {
    if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) return;
    const subscriptions = await sql<Array<{ endpoint: string; p256dh: string; auth: string }>>`
      SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ${userId}
    `;
    const payload = JSON.stringify({
      title: hint === "approval" ? "远程任务需要处理" : "远程任务已完成",
      body: hint === "approval" ? "打开随码查看审批请求。" : "打开随码查看结果。",
      url: "/"
    });
    await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth }
        }, payload, { TTL: 120 });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await sql`DELETE FROM push_subscriptions WHERE endpoint = ${subscription.endpoint}`;
        } else {
          app.log.warn({ error, endpoint: subscription.endpoint }, "push delivery failed");
        }
      }
    }));
  }

  app.get("/api/health", async () => {
    const rows = await sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM users`;
    const count = rows[0]?.count ?? 0;
    const policy = await resolveRegistrationPolicy(sql, config.REGISTRATION_ENABLED, config.MAX_USERS);
    const { getLatestClientVersion } = await import("./latest-client-version");
    const latestClientVersion = await getLatestClientVersion({
      ...(config.LATEST_CLIENT_VERSION ? { override: config.LATEST_CLIENT_VERSION } : {}),
      ...(config.GITHUB_RELEASES_LATEST_URL ? { releasesUrl: config.GITHUB_RELEASES_LATEST_URL } : {})
    });
    return {
      ok: true,
      needsSetup: count === 0,
      registrationEnabled: policy.registrationEnabled && count < policy.maxUsers,
      clientDownloads: {
        windows: config.WINDOWS_CLIENT_URL ?? null,
        mac: config.MAC_CLIENT_URL ?? null
      },
      /** Latest desktop agent release (for soft update prompts; not a hard web↔client bind). */
      latestClientVersion,
      vapidPublicKey: config.VAPID_PUBLIC_KEY ?? null
    };
  });

  app.get("/api/agent/config", async () => ({ updateFeedUrl: config.UPDATE_FEED_URL ?? null }));

  app.post("/api/setup", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = setupBody.parse(request.body);
    const countRows = await sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM users`;
    const count = countRows[0]?.count ?? 0;
    if (count > 0) return reply.code(409).send({ error: "already_initialized" });
    if (!safeEqual(body.setupToken, config.SETUP_TOKEN)) return reply.code(403).send({ error: "invalid_setup_token" });

    const userId = randomUUID();
    const passwordHash = await hashPassword(body.password);
    await sql`INSERT INTO users (id, username, password_hash, is_admin) VALUES (${userId}, ${body.username}, ${passwordHash}, true)`;
    const token = randomToken();
    await sql`
      INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES (${randomUUID()}, ${userId}, ${hashToken(token)}, now() + ${`${SESSION_DAYS} days`}::interval)
    `;
    setSessionCookie(reply, token, config.NODE_ENV === "production");
    return { user: { id: userId, username: body.username, isAdmin: true } };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const body = loginBody.parse(request.body);
    const rows = await sql<Array<{ id: string; username: string; passwordHash: string; isAdmin: boolean; disabledAt: string | null }>>`
      SELECT id, username, password_hash, is_admin, disabled_at FROM users WHERE lower(username) = lower(${body.username}) LIMIT 1
    `;
    const user = rows[0];
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
      return reply.code(401).send({ error: "invalid_credentials", message: "用户名/邮箱或密码错误" });
    }
    if (user.disabledAt) {
      return reply.code(403).send({ error: "account_disabled", message: "账号已被禁用" });
    }
    const token = randomToken();
    await sql`
      INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES (${randomUUID()}, ${user.id}, ${hashToken(token)}, now() + ${`${SESSION_DAYS} days`}::interval)
    `;
    setSessionCookie(reply, token, config.NODE_ENV === "production");
    return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  });

  app.post("/api/auth/register", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const policy = await resolveRegistrationPolicy(sql, config.REGISTRATION_ENABLED, config.MAX_USERS);
    if (!policy.registrationEnabled) {
      return reply.code(403).send({ error: "registration_disabled", message: "当前未开放注册" });
    }
    const body = registerBody.parse(request.body);
    const countRows = await sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM users`;
    if ((countRows[0]?.count ?? 0) >= policy.maxUsers) {
      return reply.code(403).send({ error: "user_limit_reached", message: "注册人数已达上限" });
    }
    const userId = randomUUID();
    const passwordHash = await hashPassword(body.password);
    try {
      await sql`INSERT INTO users (id, username, password_hash, is_admin) VALUES (${userId}, ${body.username}, ${passwordHash}, false)`;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "username_taken", message: "用户名或邮箱已被占用" });
      }
      throw error;
    }
    const token = randomToken();
    await sql`
      INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES (${randomUUID()}, ${userId}, ${hashToken(token)}, now() + ${`${SESSION_DAYS} days`}::interval)
    `;
    setSessionCookie(reply, token, config.NODE_ENV === "production");
    return reply.code(201).send({ user: { id: userId, username: body.username, isAdmin: false } });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/session", async (request, reply) => {
    const user = await requireUser(sql, request, reply);
    if (!user) return;
    return { user };
  });

  registerAdminRoutes(app, {
    sql,
    agentSockets,
    clientSockets,
    envRegistrationEnabled: config.REGISTRATION_ENABLED,
    envMaxUsers: config.MAX_USERS,
    publicOrigin: config.PUBLIC_ORIGIN,
    windowsClientUrl: config.WINDOWS_CLIENT_URL,
    macClientUrl: config.MAC_CLIENT_URL,
    updateFeedUrl: config.UPDATE_FEED_URL,
    vapidConfigured: Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY)
  }, SESSION_COOKIE);

  app.get("/api/hosts", async (request, reply) => {
    const user = await requireUser(sql, request, reply);
    if (!user) return;
    const hosts = await sql<Array<Record<string, unknown>>>`
      SELECT id, name, platform, codex_version, created_at, last_seen_at
      FROM hosts
      WHERE user_id = ${user.id} AND revoked_at IS NULL
      ORDER BY created_at DESC
    `;
    return { hosts: hosts.map((host) => ({ ...host, online: agentSockets.has(String(host.id)) })) };
  });

  app.delete("/api/hosts/:hostId", async (request, reply) => {
    const user = await requireUser(sql, request, reply);
    if (!user) return;
    const { hostId } = request.params as { hostId: string };
    const result = await sql`
      UPDATE hosts SET revoked_at = now() WHERE id = ${hostId} AND user_id = ${user.id} AND revoked_at IS NULL
      RETURNING id
    `;
    if (!result.length) return reply.code(404).send({ error: "host_not_found" });
    agentSockets.get(hostId)?.close(4003, "revoked");
    await sql`DELETE FROM sync_events WHERE host_id = ${hostId}`;
    return { ok: true };
  });

  app.patch("/api/hosts/:hostId", async (request, reply) => {
    const user = await requireUser(sql, request, reply);
    if (!user) return;
    const { hostId } = request.params as { hostId: string };
    const body = z.object({ name: z.string().trim().min(1).max(64) }).parse(request.body);
    const result = await sql<Array<{ id: string; name: string }>>`
      UPDATE hosts SET name = ${body.name}
      WHERE id = ${hostId} AND user_id = ${user.id} AND revoked_at IS NULL
      RETURNING id, name
    `;
    if (!result.length) return reply.code(404).send({ error: "host_not_found" });
    // Push rename to the live agent so the desktop client display name stays in sync.
    const agent = agentSockets.get(hostId);
    if (agent && agent.readyState === 1) {
      agent.send(jsonControl("relay.host_rename", { name: body.name }));
    }
    return { host: result[0] };
  });

  app.post("/api/hosts/:hostId/key-authorizations", async (request, reply) => {
    const user = await requireUser(sql, request, reply);
    if (!user) return;
    const { hostId } = request.params as { hostId: string };
    const body = browserKeyAuthorizationBody.parse(request.body);
    const hosts = await sql<Array<{ id: string; agentId: string; name: string; platform: string; codexVersion: string; agentPublicKey: JsonWebKey }>>`
      SELECT id, agent_id, name, platform, codex_version, agent_public_key
      FROM hosts WHERE id = ${hostId} AND user_id = ${user.id} AND revoked_at IS NULL LIMIT 1
    `;
    const host = hosts[0];
    if (!host) return reply.code(404).send({ error: "host_not_found" });
    const agent = agentSockets.get(hostId);
    if (!agent || agent.readyState !== 1) return reply.code(409).send({ error: "host_offline" });
    const pairingId = randomUUID();
    await sql`
      INSERT INTO pairings (
        id, code, secret_hash, agent_id, agent_name, platform, codex_version,
        agent_public_key, user_id, host_id, client_public_key, status, expires_at
      ) VALUES (
        ${pairingId}, ${`AUTO-${pairingId}`}, ${hashToken(randomToken())}, ${host.agentId},
        ${String(host.name)}, ${String(host.platform)}, ${String(host.codexVersion)},
        ${sql.json(host.agentPublicKey as never)}, ${user.id}, ${hostId},
        ${sql.json(body.clientPublicKey as never)}, 'claimed', now() + interval '10 minutes'
      )
    `;
    agent.send(jsonControl("relay.key_authorization", { pairingId, clientPublicKey: body.clientPublicKey }));
    return reply.code(201).send({ pairingId, agentPublicKey: host.agentPublicKey, expiresInSeconds: 600 });
  });

  app.post("/api/agent/pairings", async (request, reply) => {
    const body = agentPairBody.parse(request.body);
    let code = pairingCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rows = await sql`SELECT id FROM pairings WHERE code = ${code} AND expires_at > now()`;
      if (!rows.length) break;
      code = pairingCode();
    }
    const id = randomUUID();
    await sql`
      INSERT INTO pairings (
        id, code, secret_hash, agent_id, agent_name, platform, codex_version,
        agent_public_key, expires_at
      ) VALUES (
        ${id}, ${code}, ${hashToken(body.secret)}, ${body.agentId}, ${body.agentName}, ${body.platform},
        ${body.codexVersion}, ${sql.json(body.agentPublicKey as never)}, now() + interval '10 minutes'
      )
    `;
    return reply.code(201).send({ pairingId: id, code, expiresInSeconds: 600 });
  });

  app.get("/api/agent/pairings/:pairingId", async (request, reply) => {
    const { pairingId } = request.params as { pairingId: string };
    const { secret } = request.query as { secret?: string };
    if (!secret) return reply.code(401).send({ error: "missing_secret" });
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM pairings WHERE id = ${pairingId} AND expires_at > now() LIMIT 1
    `;
    const pairing = rows[0];
    if (!pairing || hashToken(secret) !== pairing.secretHash) return reply.code(404).send({ error: "pairing_not_found" });
    if (pairing.status !== "claimed") return { status: pairing.status };
    const response = {
      status: "claimed",
      hostId: pairing.hostId,
      agentToken: openSecret(String(pairing.agentToken), config.COOKIE_SECRET),
      clientPublicKey: pairing.clientPublicKey,
      wrappedSyncKey: pairing.wrappedSyncKey
    };
    return response;
  });

  app.post("/api/agent/pairings/:pairingId/authorize", async (request, reply) => {
    const { pairingId } = request.params as { pairingId: string };
    const { secret } = request.query as { secret?: string };
    if (!secret) return reply.code(401).send({ error: "missing_secret" });
    const body = authorizePairingBody.parse(request.body);
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, secret_hash, status FROM pairings WHERE id = ${pairingId} AND expires_at > now() LIMIT 1
    `;
    const pairing = rows[0];
    if (!pairing || hashToken(secret) !== pairing.secretHash || pairing.status !== "claimed") {
      return reply.code(404).send({ error: "pairing_not_found" });
    }
    await sql`
      UPDATE pairings SET wrapped_sync_key = ${sql.json(body.wrappedSyncKey as never)}, status = 'authorized'
      WHERE id = ${pairingId}
    `;
    return { ok: true };
  });

  app.get("/api/pairings/code/:code", async (request, reply) => {
    const user = await requireUser(sql, request, reply);
    if (!user) return;
    const { code } = request.params as { code: string };
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, code, agent_name, platform, codex_version, agent_public_key, expires_at
      FROM pairings
      WHERE code = ${code} AND status = 'pending' AND expires_at > now()
      LIMIT 1
    `;
    const pairing = rows[0];
    if (!pairing) return reply.code(404).send({ error: "pairing_not_found" });
    return {
      pairingId: pairing.id,
      code: pairing.code,
      agentName: pairing.agentName,
      platform: pairing.platform,
      codexVersion: pairing.codexVersion,
      agentPublicKey: pairing.agentPublicKey,
      expiresAt: pairing.expiresAt
    };
  });

  app.post("/api/pairings/:pairingId/claim", async (request, reply) => {
    const user = await requireUser(sql, request, reply);
    if (!user) return;
    const body = claimBody.parse(request.body);
    const { pairingId } = request.params as { pairingId: string };
    const agentToken = randomToken();
    const result = await sql.begin(async (transaction) => {
      const rows = await transaction<Array<Record<string, unknown>>>`
        SELECT * FROM pairings
        WHERE id = ${pairingId} AND status = 'pending' AND expires_at > now()
        FOR UPDATE
      `;
      const pairing = rows[0];
      if (!pairing) return null;
      const agentId = String(pairing.agentId);
      const owners = await transaction<Array<{ id: string; userId: string }>>`
        SELECT id, user_id FROM hosts WHERE agent_id = ${agentId} AND revoked_at IS NULL LIMIT 1 FOR UPDATE
      `;
      if (owners[0] && owners[0].userId !== user.id) return { forbidden: true as const };
      const existingHosts = await transaction<Array<{ id: string }>>`
        SELECT id FROM hosts
        WHERE user_id = ${user.id} AND agent_id = ${agentId} AND revoked_at IS NULL
        LIMIT 1
        FOR UPDATE
      `;
      const hostId = existingHosts[0]?.id ?? randomUUID();
      if (existingHosts.length) {
        await transaction`
          UPDATE hosts SET
            name = ${String(pairing.agentName)}, platform = ${String(pairing.platform)},
            codex_version = ${String(pairing.codexVersion)},
            agent_public_key = ${transaction.json(pairing.agentPublicKey as never)},
            agent_token_hash = ${hashToken(agentToken)}, revoked_at = NULL
          WHERE id = ${hostId}
        `;
      } else {
        await transaction`
          INSERT INTO hosts (
            id, user_id, agent_id, name, platform, codex_version, agent_public_key, agent_token_hash
          ) VALUES (
            ${hostId}, ${user.id}, ${agentId}, ${String(pairing.agentName)}, ${String(pairing.platform)},
            ${String(pairing.codexVersion)}, ${transaction.json(pairing.agentPublicKey as never)}, ${hashToken(agentToken)}
          )
        `;
      }
      await transaction`
        UPDATE pairings SET
          status = 'claimed', user_id = ${user.id}, host_id = ${hostId},
          client_public_key = ${transaction.json(body.clientPublicKey as never)},
          wrapped_sync_key = NULL,
          agent_token = ${sealSecret(agentToken, config.COOKIE_SECRET)}
        WHERE id = ${pairingId}
      `;
      return { forbidden: false as const,
        id: hostId,
        hostId,
        name: pairing.agentName,
        platform: pairing.platform,
        codexVersion: pairing.codexVersion
      };
    });
    if (!result) return reply.code(404).send({ error: "pairing_not_found" });
    if (result.forbidden) return reply.code(409).send({ error: "host_owned_by_another_user" });
    return { host: result };
  });

  app.get("/api/pairings/:pairingId/status", async (request, reply) => {
    const user = await requireUser(sql, request, reply);
    if (!user) return;
    const { pairingId } = request.params as { pairingId: string };
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT status, host_id, wrapped_sync_key FROM pairings
      WHERE id = ${pairingId} AND user_id = ${user.id} AND expires_at > now() LIMIT 1
    `;
    const pairing = rows[0];
    if (!pairing) return reply.code(404).send({ error: "pairing_not_found" });
    if (pairing.status !== "authorized") return { status: pairing.status };
    return { status: "authorized", hostId: pairing.hostId, wrappedSyncKey: pairing.wrappedSyncKey };
  });

  app.get("/api/sync/:hostId", async (request, reply) => {
    const user = await requireUser(sql, request, reply);
    if (!user) return;
    const { hostId } = request.params as { hostId: string };
    const after = Math.max(0, Number((request.query as { after?: string }).after ?? 0));
    const owns = await sql`SELECT id FROM hosts WHERE id = ${hostId} AND user_id = ${user.id} AND revoked_at IS NULL`;
    if (!owns.length) return reply.code(404).send({ error: "host_not_found" });
    const rows = await sql<Array<{ sequence: number; envelope: EncryptedEnvelope }>>`
      SELECT sequence, envelope
      FROM sync_events
      WHERE host_id = ${hostId} AND sequence > ${after}
      ORDER BY sequence ASC
      LIMIT 1000
    `;
    return { events: rows.map((row) => row.envelope), nextSequence: rows.at(-1)?.sequence ?? after };
  });

  app.post("/api/push/subscriptions", async (request, reply) => {
    const user = await requireUser(sql, request, reply);
    if (!user) return;
    const body = pushBody.parse(request.body);
    await sql`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (${randomUUID()}, ${user.id}, ${body.endpoint}, ${body.keys.p256dh}, ${body.keys.auth})
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
    `;
    return { ok: true };
  });

  app.delete("/api/push/subscriptions", async (request, reply) => {
    const user = await requireUser(sql, request, reply);
    if (!user) return;
    const body = z.object({ endpoint: z.string().url() }).parse(request.body);
    await sql`DELETE FROM push_subscriptions WHERE user_id = ${user.id} AND endpoint = ${body.endpoint}`;
    return { ok: true };
  });

  app.get("/ws/client", { websocket: true }, async (socket, request) => {
    if (config.NODE_ENV === "production" && request.headers.origin !== config.PUBLIC_ORIGIN) {
      return socket.close(4003, "invalid_origin");
    }
    const user = await userFromRequest(sql, request);
    if (!user) return socket.close(4001, "unauthorized");
    const clientSocket = socket as unknown as SocketLike;
    const sockets = clientSockets.get(user.id) ?? new Set<SocketLike>();
    sockets.add(clientSocket);
    clientSockets.set(user.id, sockets);

    const hosts = await sql<Array<{ id: string }>>`SELECT id FROM hosts WHERE user_id = ${user.id} AND revoked_at IS NULL`;
    for (const host of hosts) clientSocket.send(jsonControl("relay.host_status", { hostId: host.id, online: agentSockets.has(host.id) }));

    clientSocket.on("message", async (data) => {
      try {
        const envelope = encryptedEnvelopeSchema.parse(JSON.parse(data.toString()));
        const owns = await sql`SELECT id FROM hosts WHERE id = ${envelope.hostId} AND user_id = ${user.id} AND revoked_at IS NULL`;
        if (!owns.length) return clientSocket.send(jsonControl("relay.error", { hostId: envelope.hostId, error: "host_not_found" }));
        const agent = agentSockets.get(envelope.hostId);
        if (!agent || agent.readyState !== 1) return clientSocket.send(jsonControl("relay.error", { hostId: envelope.hostId, error: "host_offline" }));
        agent.send(JSON.stringify(envelope));
      } catch (error) {
        app.log.warn({ error }, "invalid client websocket message");
        clientSocket.send(jsonControl("relay.error", { error: "invalid_message" }));
      }
    });
    clientSocket.on("close", () => {
      sockets.delete(clientSocket);
      if (!sockets.size) clientSockets.delete(user.id);
    });
  });

  app.get("/ws/agent", { websocket: true }, async (socket, request) => {
    const query = request.query as { hostId?: string };
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (!query.hostId || !token) return socket.close(4001, "missing_credentials");
    const rows = await sql<Array<{ id: string; userId: string; name: string; codexVersion: string; platform: string }>>`
      SELECT id, user_id, name, codex_version, platform FROM hosts
      WHERE id = ${query.hostId} AND agent_token_hash = ${hashToken(token)} AND revoked_at IS NULL
      LIMIT 1
    `;
    const host = rows[0];
    if (!host) return socket.close(4001, "unauthorized");
    const agentSocket = socket as unknown as SocketLike;
    // Only replace an existing socket for this host (avoid flap from self-close races).
    const previous = agentSockets.get(host.id);
    if (previous && previous !== agentSocket) {
      try {
        previous.close(4002, "replaced");
      } catch {
        // ignore
      }
    }
    agentSockets.set(host.id, agentSocket);
    await sql`UPDATE hosts SET last_seen_at = now() WHERE id = ${host.id}`;
    broadcastToUser(host.userId, jsonControl("relay.host_status", { hostId: host.id, online: true }));
    // Canonical name lives in DB (may have been renamed while agent was offline).
    agentSocket.send(jsonControl("relay.host_hello", {
      name: host.name,
      codexVersion: host.codexVersion,
      platform: host.platform
    }));

    agentSocket.on("message", async (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed.type === "agent.key_authorization") {
          const pairingId = z.string().uuid().parse(parsed.pairingId);
          const wrappedSyncKey = authorizePairingBody.shape.wrappedSyncKey.parse(parsed.wrappedSyncKey);
          await sql`
            UPDATE pairings SET wrapped_sync_key = ${sql.json(wrappedSyncKey as never)}, status = 'authorized'
            WHERE id = ${pairingId} AND host_id = ${host.id} AND status = 'claimed' AND expires_at > now()
          `;
          broadcastToUser(host.userId, jsonControl("relay.key_authorized", { hostId: host.id, pairingId }));
          return;
        }
        // Unencrypted agent metadata: keep admin/web host rows in sync with live client.
        if (parsed.type === "agent.meta") {
          const meta = z.object({
            name: z.string().trim().min(1).max(64).optional(),
            codexVersion: z.string().trim().min(1).max(80).optional(),
            claudeVersion: z.string().trim().min(1).max(80).optional(),
            grokVersion: z.string().trim().min(1).max(80).optional(),
            cursorVersion: z.string().trim().min(1).max(80).optional(),
            platform: z.string().trim().min(1).max(120).optional(),
            agentVersion: z.string().trim().min(1).max(40).optional()
          }).parse(parsed);
          const nextName = meta.name?.trim();
          const nextCodex = meta.codexVersion?.trim();
          const nextClaude = meta.claudeVersion?.trim();
          const nextGrok = meta.grokVersion?.trim();
          const nextCursor = meta.cursorVersion?.trim();
          const nextPlatform = meta.platform?.trim();
          const nextAgentVersion = meta.agentVersion?.trim();
          await sql`
            UPDATE hosts SET
              name = COALESCE(${nextName ?? null}, name),
              codex_version = COALESCE(${nextCodex ?? null}, codex_version),
              claude_version = COALESCE(${nextClaude ?? null}, claude_version),
              grok_version = COALESCE(${nextGrok ?? null}, grok_version),
              cursor_version = COALESCE(${nextCursor ?? null}, cursor_version),
              platform = COALESCE(${nextPlatform ?? null}, platform),
              agent_version = COALESCE(${nextAgentVersion ?? null}, agent_version),
              last_seen_at = now()
            WHERE id = ${host.id}
          `;
          broadcastToUser(host.userId, jsonControl("relay.host_meta", {
            hostId: host.id,
            ...(nextName ? { name: nextName } : {}),
            ...(nextCodex ? { codexVersion: nextCodex } : {}),
            ...(nextClaude ? { claudeVersion: nextClaude } : {}),
            ...(nextGrok ? { grokVersion: nextGrok } : {}),
            ...(nextCursor ? { cursorVersion: nextCursor } : {}),
            ...(nextPlatform ? { platform: nextPlatform } : {}),
            ...(nextAgentVersion ? { agentVersion: nextAgentVersion } : {})
          }));
          return;
        }
        const envelope = encryptedEnvelopeSchema.parse(parsed);
        if (envelope.hostId !== host.id) throw new Error("host mismatch");
        if (envelope.persist) {
          await sql`
            INSERT INTO sync_events (host_id, sequence, message_id, envelope)
            VALUES (${host.id}, ${envelope.sequence}, ${envelope.messageId}, ${sql.json(envelope)})
            ON CONFLICT DO NOTHING
          `;
        }
        broadcastToUser(host.userId, JSON.stringify(envelope));
        if (envelope.hint) await sendPush(host.userId, envelope.hint);
      } catch (error) {
        app.log.warn({ error, hostId: host.id }, "invalid agent websocket message");
      }
    });

    const disconnected = () => {
      if (agentSockets.get(host.id) === agentSocket) {
        agentSockets.delete(host.id);
        broadcastToUser(host.userId, jsonControl("relay.host_status", { hostId: host.id, online: false }));
      }
    };
    agentSocket.on("close", disconnected);
    agentSocket.on("error", disconnected);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      const message = first?.message?.trim() || "请求参数无效";
      return reply.code(400).send({
        error: "invalid_request",
        message,
        details: error.flatten()
      });
    }
    if ((error as { code?: string }).code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      return reply.code(400).send({ error: "empty_json_body", message: "请求体不能为空" });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "服务器内部错误" });
  });

  app.addHook("onClose", async () => {
    await sql.end({ timeout: 5 });
  });

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
