import { z } from "zod";

const optionalUrl = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());
const urlWithDefault = (fallback: string) => z.preprocess((value) => value === "" ? undefined : value, z.string().url().default(fallback));

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  SETUP_TOKEN: z.string().min(16),
  COOKIE_SECRET: z.string().min(24),
  PUBLIC_ORIGIN: z.string().url(),
  REGISTRATION_ENABLED: z.string().default("true").transform((value) => value === "true"),
  MAX_USERS: z.coerce.number().int().positive().default(100),
  SYNC_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  SYNC_EVENT_MAX_PER_HOST: z.coerce.number().int().positive().default(10000),
  WINDOWS_CLIENT_URL: urlWithDefault("https://github.com/demonrain/anytimevibe/releases/latest/download/AnytimeVibe-Agent-Setup.exe"),
  // Leave empty to show「敬请期待」on the web UI when no macOS package is published.
  MAC_CLIENT_URL: urlWithDefault("https://github.com/demonrain/anytimevibe/releases/latest/download/AnytimeVibe-Agent.dmg"),
  UPDATE_FEED_URL: optionalUrl,
  /** Public HTTPS origin for the standalone update transfer service. Defaults to PUBLIC_ORIGIN. */
  UPDATE_TRANSFER_URL: optionalUrl,
  /** Optional npm registry origin used only by the update metadata/artifact relay. */
  NPM_REGISTRY_ORIGIN: optionalUrl,
  /** Persistent cache volume for verified update metadata and package artifacts. */
  UPDATE_CACHE_DIR: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  /** Credential-free HTTPS CONNECT proxy URL; credentials are minted only for paired hosts. */
  UPDATE_PROXY_URL: optionalUrl,
  UPDATE_PROXY_TOKEN_SECRET: z.preprocess((value) => value === "" ? undefined : value, z.string().min(32).optional()),
  /** Optional pinned latest client semver (e.g. 0.4.31). When set, health skips GitHub lookup. */
  LATEST_CLIENT_VERSION: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().min(1).optional()
  ),
  GITHUB_RELEASES_LATEST_URL: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().url().optional()
  ),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@localhost")
});

export type RelayConfig = z.infer<typeof configSchema>;

export function loadConfig(): RelayConfig {
  return configSchema.parse(process.env);
}
