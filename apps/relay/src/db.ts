import postgres, { type Sql } from "postgres";

export type Database = Sql<Record<string, never>>;

export function createDatabase(url: string): Database {
  return postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    transform: postgres.camel
  });
}

export async function ensureSchema(sql: Database): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      username text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users(lower(username));
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS note text;

    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS hosts (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id uuid,
      name text NOT NULL,
      platform text NOT NULL,
      codex_version text NOT NULL,
      agent_public_key jsonb NOT NULL,
      agent_token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz,
      revoked_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS hosts_user_id_idx ON hosts(user_id);
    ALTER TABLE hosts ADD COLUMN IF NOT EXISTS agent_id uuid;
    ALTER TABLE hosts ADD COLUMN IF NOT EXISTS agent_version text;
    CREATE UNIQUE INDEX IF NOT EXISTS hosts_user_agent_id_idx ON hosts(user_id, agent_id) WHERE agent_id IS NOT NULL AND revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS pairings (
      id uuid PRIMARY KEY,
      code text NOT NULL UNIQUE,
      secret_hash text NOT NULL,
      agent_id uuid,
      agent_name text NOT NULL,
      platform text NOT NULL,
      codex_version text NOT NULL,
      agent_public_key jsonb NOT NULL,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      host_id uuid REFERENCES hosts(id) ON DELETE CASCADE,
      client_public_key jsonb,
      wrapped_sync_key jsonb,
      agent_token text,
      status text NOT NULL DEFAULT 'pending',
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS pairings_code_idx ON pairings(code);
    ALTER TABLE pairings ADD COLUMN IF NOT EXISTS agent_id uuid;

    CREATE TABLE IF NOT EXISTS sync_events (
      id bigserial PRIMARY KEY,
      host_id uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      sequence bigint NOT NULL,
      message_id uuid NOT NULL,
      envelope jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(host_id, sequence),
      UNIQUE(host_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS sync_events_host_sequence_idx ON sync_events(host_id, sequence);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint text NOT NULL UNIQUE,
      p256dh text NOT NULL,
      auth text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx ON push_subscriptions(user_id);

    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id uuid PRIMARY KEY,
      admin_id uuid REFERENCES users(id) ON DELETE SET NULL,
      action text NOT NULL,
      target_type text,
      target_id text,
      detail jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS admin_audit_logs_created_at_idx ON admin_audit_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS service_settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL
    );

    -- Bootstrap: first existing user becomes admin if none are marked yet.
    UPDATE users SET is_admin = true
    WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = true);
  `);
}
