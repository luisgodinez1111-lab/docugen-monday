/**
 * src/config/env.ts
 * Zod-validated environment variables — fail fast on startup if misconfigured.
 * Import `env` everywhere instead of reading process.env directly.
 */
import { z } from 'zod';

const schema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Monday.com OAuth + API
  MONDAY_CLIENT_ID: z.string().min(1, 'MONDAY_CLIENT_ID is required'),
  MONDAY_CLIENT_SECRET: z.string().min(1, 'MONDAY_CLIENT_SECRET is required'),
  MONDAY_SIGNING_SECRET: z.string().min(1, 'MONDAY_SIGNING_SECRET is required'),
  MONDAY_APP_ID: z.string().min(1, 'MONDAY_APP_ID is required'),

  // App URLs
  REDIRECT_URI: z.string().url('REDIRECT_URI must be a valid URL'),
  APP_URL: z.string().url('APP_URL must be a valid URL'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Security
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
    .optional(),
  ENCRYPTION_KEYS: z.string().optional(),         // JSON {"1":"hex64...","2":"hex64..."} for key rotation
  ENCRYPTION_KEY_VERSION: z.string().optional(),  // which version to use for new encryptions

  // Email (Resend)
  RESEND_API_KEY: z.string().startsWith('re_').optional(),
  SMTP_FROM: z.string().email().optional(),

  // Time Stamp Authority (RFC 3161 / NOM-151)
  TSA_URL: z.string().url().default('http://timestamp.sectigo.com'),

  // Admin
  ADMIN_MIGRATE_SECRET: z.string().min(16, 'ADMIN_MIGRATE_SECRET must be ≥16 chars').optional(),

  // Redis (optional — queues gracefully degrade without it)
  REDIS_URL: z.string().url().optional(),

  // Sentry (optional — error tracking disabled when not set)
  SENTRY_DSN: z.string().url().optional(),
});

type Env = z.infer<typeof schema>;

function loadEnv(): Env {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`[env] Invalid environment variables:\n${issues}`);
  }
  return result.data;
}

// Singleton — parsed once at module load time
export const env: Env = loadEnv();
