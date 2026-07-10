import { z } from "zod";

const optionalUrl = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());

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
  WINDOWS_CLIENT_URL: optionalUrl,
  MAC_CLIENT_URL: optionalUrl,
  UPDATE_FEED_URL: optionalUrl,
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@localhost")
});

export type RelayConfig = z.infer<typeof configSchema>;

export function loadConfig(): RelayConfig {
  return configSchema.parse(process.env);
}
