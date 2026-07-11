import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.js";
import { hashPassword, hashToken } from "./security.js";

export type AdminUser = { id: string; username: string; isAdmin: boolean };

type SocketLike = {
  readyState: number;
  close(code?: number, reason?: string): void;
};

export type AdminContext = {
  sql: Database;
  agentSockets: Map<string, SocketLike>;
  clientSockets: Map<string, Set<SocketLike>>;
  envRegistrationEnabled: boolean;
  envMaxUsers: number;
  publicOrigin: string;
  windowsClientUrl: string | null | undefined;
  macClientUrl: string | null | undefined;
  updateFeedUrl: string | null | undefined;
  vapidConfigured: boolean;
};

async function writeAudit(
  sql: Database,
  adminId: string,
  action: string,
  targetType?: string,
  targetId?: string,
  detail?: Record<string, unknown>
): Promise<void> {
  await sql`
    INSERT INTO admin_audit_logs (id, admin_id, action, target_type, target_id, detail)
    VALUES (
      ${randomUUID()},
      ${adminId},
      ${action},
      ${targetType ?? null},
      ${targetId ?? null},
      ${detail ? sql.json(detail as never) : null}
    )
  `;
}

async function loadServiceSettings(sql: Database): Promise<{
  registrationEnabled: boolean | null;
  maxUsers: number | null;
}> {
  const rows = await sql<Array<{ key: string; value: unknown }>>`
    SELECT key, value FROM service_settings WHERE key IN ('registration_enabled', 'max_users')
  `;
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const registrationRaw = map.get("registration_enabled");
  const maxUsersRaw = map.get("max_users");
  return {
    registrationEnabled: typeof registrationRaw === "boolean" ? registrationRaw : null,
    maxUsers: typeof maxUsersRaw === "number" && Number.isFinite(maxUsersRaw) ? maxUsersRaw : null
  };
}

export async function resolveRegistrationPolicy(
  sql: Database,
  envRegistrationEnabled: boolean,
  envMaxUsers: number
): Promise<{ registrationEnabled: boolean; maxUsers: number; source: { registration: "db" | "env"; maxUsers: "db" | "env" } }> {
  const settings = await loadServiceSettings(sql);
  return {
    registrationEnabled: settings.registrationEnabled ?? envRegistrationEnabled,
    maxUsers: settings.maxUsers ?? envMaxUsers,
    source: {
      registration: settings.registrationEnabled === null ? "env" : "db",
      maxUsers: settings.maxUsers === null ? "env" : "db"
    }
  };
}

export async function requireAdmin(
  sql: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  sessionCookie: string
): Promise<AdminUser | null> {
  const token = request.cookies[sessionCookie];
  if (!token) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  const rows = await sql<Array<{ id: string; username: string; isAdmin: boolean; disabledAt: string | null }>>`
    SELECT users.id, users.username, users.is_admin, users.disabled_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ${hashToken(token)}
      AND sessions.expires_at > now()
    LIMIT 1
  `;
  const user = rows[0];
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  if (user.disabledAt) {
    reply.code(403).send({ error: "account_disabled" });
    return null;
  }
  if (!user.isAdmin) {
    reply.code(403).send({ error: "admin_required" });
    return null;
  }
  return { id: user.id, username: user.username, isAdmin: true };
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AdminContext, sessionCookie: string): void {
  const { sql, agentSockets, clientSockets } = ctx;

  app.get("/api/admin/overview", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;

    const [usersCount] = await sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM users`;
    const [activeUsers] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM users WHERE disabled_at IS NULL
    `;
    const [disabledUsers] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM users WHERE disabled_at IS NOT NULL
    `;
    const [hostsCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM hosts WHERE revoked_at IS NULL
    `;
    const [revokedHosts] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM hosts WHERE revoked_at IS NOT NULL
    `;
    const [sessionsCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM sessions WHERE expires_at > now()
    `;
    const [eventsCount] = await sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM sync_events`;
    const [events24h] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM sync_events WHERE created_at > now() - interval '24 hours'
    `;
    const [pushCount] = await sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM push_subscriptions`;
    const [pendingPairings] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pairings WHERE status = 'pending' AND expires_at > now()
    `;
    const policy = await resolveRegistrationPolicy(sql, ctx.envRegistrationEnabled, ctx.envMaxUsers);

    let onlineClients = 0;
    for (const sockets of clientSockets.values()) onlineClients += sockets.size;

    return {
      stats: {
        users: usersCount?.count ?? 0,
        activeUsers: activeUsers?.count ?? 0,
        disabledUsers: disabledUsers?.count ?? 0,
        hosts: hostsCount?.count ?? 0,
        revokedHosts: revokedHosts?.count ?? 0,
        onlineAgents: agentSockets.size,
        onlineClients,
        activeSessions: sessionsCount?.count ?? 0,
        syncEvents: eventsCount?.count ?? 0,
        syncEvents24h: events24h?.count ?? 0,
        pushSubscriptions: pushCount?.count ?? 0,
        pendingPairings: pendingPairings?.count ?? 0
      },
      policy,
      system: {
        publicOrigin: ctx.publicOrigin,
        windowsClientUrl: ctx.windowsClientUrl ?? null,
        macClientUrl: ctx.macClientUrl ?? null,
        updateFeedUrl: ctx.updateFeedUrl ?? null,
        vapidConfigured: ctx.vapidConfigured
      }
    };
  });

  app.get("/api/admin/users", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const query = z.object({
      q: z.string().trim().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      status: z.enum(["all", "active", "disabled"]).default("all")
    }).parse(request.query);

    const offset = (query.page - 1) * query.pageSize;
    const pattern = query.q ? `%${query.q}%` : null;

    const users = await sql<Array<Record<string, unknown>>>`
      SELECT
        u.id,
        u.username,
        u.is_admin,
        u.disabled_at,
        u.note,
        u.created_at,
        (SELECT count(*)::int FROM hosts h WHERE h.user_id = u.id AND h.revoked_at IS NULL) AS host_count,
        (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS session_count,
        (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login_at
      FROM users u
      WHERE (${pattern}::text IS NULL OR u.username ILIKE ${pattern})
        AND (
          ${query.status} = 'all'
          OR (${query.status} = 'active' AND u.disabled_at IS NULL)
          OR (${query.status} = 'disabled' AND u.disabled_at IS NOT NULL)
        )
      ORDER BY u.created_at DESC
      LIMIT ${query.pageSize} OFFSET ${offset}
    `;

    const [total] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM users u
      WHERE (${pattern}::text IS NULL OR u.username ILIKE ${pattern})
        AND (
          ${query.status} = 'all'
          OR (${query.status} = 'active' AND u.disabled_at IS NULL)
          OR (${query.status} = 'disabled' AND u.disabled_at IS NOT NULL)
        )
    `;

    return {
      users,
      page: query.page,
      pageSize: query.pageSize,
      total: total?.count ?? 0
    };
  });

  app.get("/api/admin/users/:userId", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const { userId } = request.params as { userId: string };
    const users = await sql<Array<Record<string, unknown>>>`
      SELECT id, username, is_admin, disabled_at, note, created_at
      FROM users WHERE id = ${userId} LIMIT 1
    `;
    const user = users[0];
    if (!user) return reply.code(404).send({ error: "user_not_found" });

    const hosts = await sql<Array<Record<string, unknown>>>`
      SELECT id, name, platform, codex_version, created_at, last_seen_at, revoked_at
      FROM hosts WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;
    const sessions = await sql<Array<Record<string, unknown>>>`
      SELECT id, created_at, expires_at
      FROM sessions
      WHERE user_id = ${userId} AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 50
    `;
    const push = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM push_subscriptions WHERE user_id = ${userId}
    `;

    return {
      user,
      hosts: hosts.map((host) => ({ ...host, online: agentSockets.has(String(host.id)) })),
      sessions,
      pushSubscriptions: push[0]?.count ?? 0,
      onlineClients: clientSockets.get(userId)?.size ?? 0
    };
  });

  app.patch("/api/admin/users/:userId", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const { userId } = request.params as { userId: string };
    const body = z.object({
      isAdmin: z.boolean().optional(),
      disabled: z.boolean().optional(),
      note: z.string().trim().max(500).nullable().optional(),
      password: z.string().min(10).max(256).optional()
    }).parse(request.body);

    const existing = await sql<Array<{ id: string; isAdmin: boolean }>>`
      SELECT id, is_admin FROM users WHERE id = ${userId} LIMIT 1
    `;
    if (!existing[0]) return reply.code(404).send({ error: "user_not_found" });

    if (body.isAdmin === false && existing[0].isAdmin) {
      const [admins] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM users WHERE is_admin = true AND disabled_at IS NULL
      `;
      if ((admins?.count ?? 0) <= 1) {
        return reply.code(400).send({ error: "cannot_demote_last_admin" });
      }
    }

    if (body.disabled === true && existing[0].isAdmin) {
      const [admins] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM users WHERE is_admin = true AND disabled_at IS NULL AND id <> ${userId}
      `;
      if ((admins?.count ?? 0) < 1 && admin.id === userId) {
        return reply.code(400).send({ error: "cannot_disable_last_admin" });
      }
    }

    if (body.isAdmin !== undefined) {
      await sql`UPDATE users SET is_admin = ${body.isAdmin} WHERE id = ${userId}`;
    }
    if (body.disabled !== undefined) {
      if (body.disabled) {
        await sql`UPDATE users SET disabled_at = now() WHERE id = ${userId}`;
        await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
        const sockets = clientSockets.get(userId);
        if (sockets) {
          for (const socket of sockets) socket.close(4003, "disabled");
          clientSockets.delete(userId);
        }
      } else {
        await sql`UPDATE users SET disabled_at = NULL WHERE id = ${userId}`;
      }
    }
    if (body.note !== undefined) {
      await sql`UPDATE users SET note = ${body.note} WHERE id = ${userId}`;
    }
    if (body.password) {
      const passwordHash = await hashPassword(body.password);
      await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${userId}`;
      await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
    }

    await writeAudit(sql, admin.id, "user.update", "user", userId, body as Record<string, unknown>);
    const users = await sql`SELECT id, username, is_admin, disabled_at, note, created_at FROM users WHERE id = ${userId}`;
    return { user: users[0] };
  });

  app.delete("/api/admin/users/:userId", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const { userId } = request.params as { userId: string };
    if (userId === admin.id) return reply.code(400).send({ error: "cannot_delete_self" });

    const existing = await sql<Array<{ id: string; isAdmin: boolean; username: string }>>`
      SELECT id, is_admin, username FROM users WHERE id = ${userId} LIMIT 1
    `;
    if (!existing[0]) return reply.code(404).send({ error: "user_not_found" });
    if (existing[0].isAdmin) {
      const [admins] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM users WHERE is_admin = true
      `;
      if ((admins?.count ?? 0) <= 1) return reply.code(400).send({ error: "cannot_delete_last_admin" });
    }

    const hosts = await sql<Array<{ id: string }>>`SELECT id FROM hosts WHERE user_id = ${userId}`;
    for (const host of hosts) {
      agentSockets.get(host.id)?.close(4003, "user_deleted");
      agentSockets.delete(host.id);
    }
    const sockets = clientSockets.get(userId);
    if (sockets) {
      for (const socket of sockets) socket.close(4003, "user_deleted");
      clientSockets.delete(userId);
    }

    await sql`DELETE FROM users WHERE id = ${userId}`;
    await writeAudit(sql, admin.id, "user.delete", "user", userId, { username: existing[0].username });
    return { ok: true };
  });

  app.post("/api/admin/users/:userId/sessions/revoke", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const { userId } = request.params as { userId: string };
    const result = await sql`DELETE FROM sessions WHERE user_id = ${userId} RETURNING id`;
    const sockets = clientSockets.get(userId);
    if (sockets) {
      for (const socket of sockets) socket.close(4003, "sessions_revoked");
      clientSockets.delete(userId);
    }
    await writeAudit(sql, admin.id, "user.revoke_sessions", "user", userId, { revoked: result.length });
    return { ok: true, revoked: result.length };
  });

  app.get("/api/admin/hosts", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const query = z.object({
      q: z.string().trim().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      status: z.enum(["all", "active", "revoked", "online", "offline"]).default("all")
    }).parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const pattern = query.q ? `%${query.q}%` : null;

    const hosts = await sql<Array<Record<string, unknown>>>`
      SELECT
        h.id, h.name, h.platform, h.codex_version, h.created_at, h.last_seen_at, h.revoked_at,
        u.id AS user_id, u.username
      FROM hosts h
      JOIN users u ON u.id = h.user_id
      WHERE (${pattern}::text IS NULL OR h.name ILIKE ${pattern} OR u.username ILIKE ${pattern})
        AND (
          ${query.status} = 'all'
          OR (${query.status} = 'active' AND h.revoked_at IS NULL)
          OR (${query.status} = 'revoked' AND h.revoked_at IS NOT NULL)
          OR ${query.status} IN ('online', 'offline')
        )
      ORDER BY h.created_at DESC
      LIMIT ${query.pageSize * 3} OFFSET ${offset}
    `;

    let filtered = hosts.map((host) => {
      const revokedAt = host.revokedAt ?? null;
      return {
        ...host,
        online: Boolean(revokedAt) ? false : agentSockets.has(String(host.id))
      } as Record<string, unknown> & { online: boolean; revokedAt?: unknown };
    });
    if (query.status === "online") filtered = filtered.filter((host) => host.online);
    if (query.status === "offline") filtered = filtered.filter((host) => !host.online && !host.revokedAt);
    filtered = filtered.slice(0, query.pageSize);

    const [total] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM hosts h
      JOIN users u ON u.id = h.user_id
      WHERE (${pattern}::text IS NULL OR h.name ILIKE ${pattern} OR u.username ILIKE ${pattern})
        AND (
          ${query.status} = 'all'
          OR (${query.status} = 'active' AND h.revoked_at IS NULL)
          OR (${query.status} = 'revoked' AND h.revoked_at IS NOT NULL)
          OR ${query.status} IN ('online', 'offline')
        )
    `;

    return {
      hosts: filtered,
      page: query.page,
      pageSize: query.pageSize,
      total: total?.count ?? 0
    };
  });

  app.post("/api/admin/hosts/:hostId/revoke", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const { hostId } = request.params as { hostId: string };
    const result = await sql`
      UPDATE hosts SET revoked_at = now() WHERE id = ${hostId} AND revoked_at IS NULL
      RETURNING id, user_id, name
    `;
    if (!result.length) return reply.code(404).send({ error: "host_not_found" });
    agentSockets.get(hostId)?.close(4003, "revoked_by_admin");
    agentSockets.delete(hostId);
    await sql`DELETE FROM sync_events WHERE host_id = ${hostId}`;
    await writeAudit(sql, admin.id, "host.revoke", "host", hostId, {
      name: result[0]?.name,
      userId: result[0]?.userId
    });
    return { ok: true };
  });

  app.post("/api/admin/hosts/:hostId/disconnect", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const { hostId } = request.params as { hostId: string };
    const hosts = await sql`SELECT id, name FROM hosts WHERE id = ${hostId} LIMIT 1`;
    if (!hosts[0]) return reply.code(404).send({ error: "host_not_found" });
    const socket = agentSockets.get(hostId);
    if (socket) {
      socket.close(4002, "disconnected_by_admin");
      agentSockets.delete(hostId);
    }
    await writeAudit(sql, admin.id, "host.disconnect", "host", hostId, { name: hosts[0].name, wasOnline: Boolean(socket) });
    return { ok: true, wasOnline: Boolean(socket) };
  });

  app.get("/api/admin/settings", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const policy = await resolveRegistrationPolicy(sql, ctx.envRegistrationEnabled, ctx.envMaxUsers);
    const settings = await loadServiceSettings(sql);
    return {
      policy,
      overrides: settings,
      env: {
        registrationEnabled: ctx.envRegistrationEnabled,
        maxUsers: ctx.envMaxUsers
      },
      system: {
        publicOrigin: ctx.publicOrigin,
        windowsClientUrl: ctx.windowsClientUrl ?? null,
        macClientUrl: ctx.macClientUrl ?? null,
        updateFeedUrl: ctx.updateFeedUrl ?? null,
        vapidConfigured: ctx.vapidConfigured
      }
    };
  });

  app.patch("/api/admin/settings", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const body = z.object({
      registrationEnabled: z.boolean().nullable().optional(),
      maxUsers: z.number().int().positive().max(100_000).nullable().optional()
    }).parse(request.body);

    if (body.registrationEnabled !== undefined) {
      if (body.registrationEnabled === null) {
        await sql`DELETE FROM service_settings WHERE key = 'registration_enabled'`;
      } else {
        await sql`
          INSERT INTO service_settings (key, value, updated_at, updated_by)
          VALUES ('registration_enabled', ${sql.json(body.registrationEnabled as never)}, now(), ${admin.id})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
        `;
      }
    }
    if (body.maxUsers !== undefined) {
      if (body.maxUsers === null) {
        await sql`DELETE FROM service_settings WHERE key = 'max_users'`;
      } else {
        await sql`
          INSERT INTO service_settings (key, value, updated_at, updated_by)
          VALUES ('max_users', ${sql.json(body.maxUsers as never)}, now(), ${admin.id})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
        `;
      }
    }

    await writeAudit(sql, admin.id, "settings.update", "settings", "service", body as Record<string, unknown>);
    const policy = await resolveRegistrationPolicy(sql, ctx.envRegistrationEnabled, ctx.envMaxUsers);
    return { ok: true, policy, overrides: await loadServiceSettings(sql) };
  });

  app.get("/api/admin/audit", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(30)
    }).parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const logs = await sql<Array<Record<string, unknown>>>`
      SELECT
        l.id, l.action, l.target_type, l.target_id, l.detail, l.created_at,
        u.username AS admin_username
      FROM admin_audit_logs l
      LEFT JOIN users u ON u.id = l.admin_id
      ORDER BY l.created_at DESC
      LIMIT ${query.pageSize} OFFSET ${offset}
    `;
    const [total] = await sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM admin_audit_logs`;
    return { logs, page: query.page, pageSize: query.pageSize, total: total?.count ?? 0 };
  });

  app.get("/api/admin/pairings", async (request, reply) => {
    const admin = await requireAdmin(sql, request, reply, sessionCookie);
    if (!admin) return;
    const pairings = await sql<Array<Record<string, unknown>>>`
      SELECT
        p.id, p.code, p.agent_name, p.platform, p.codex_version, p.status,
        p.expires_at, p.created_at, u.username
      FROM pairings p
      LEFT JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC
      LIMIT 50
    `;
    return { pairings };
  });
}
