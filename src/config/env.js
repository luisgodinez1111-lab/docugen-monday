'use strict';
// FIX-29: CJS env validation — zod schema validated at startup so missing vars
// cause a clear error message instead of silent failures at runtime.
const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(64).optional(),
  ENCRYPTION_KEYS: z.string().optional(),
  MONDAY_SIGNING_SECRET: z.string().min(1),
  MONDAY_CLIENT_ID: z.string().min(1),
  MONDAY_CLIENT_SECRET: z.string().min(1),
  MONDAY_APP_ID: z.string().min(1),
  REDIRECT_URI: z.string().url(),
  APP_URL: z.string().url(),
  RESEND_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().url().optional(),
  REDIS_URL: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  ADMIN_SECRET: z.string().optional(),
  ADMIN_MIGRATE_SECRET: z.string().optional(),
  ENCRYPTION_KEY_VERSION: z.string().optional(),
}).refine(
  (d) => d.NODE_ENV === 'test' || !!(d.TOKEN_ENCRYPTION_KEY || d.ENCRYPTION_KEYS),
  { message: 'Either TOKEN_ENCRYPTION_KEY or ENCRYPTION_KEYS must be set' }
);

const result = schema.safeParse(process.env);
if (!result.success) {
  console.error('Invalid environment variables:');
  result.error.issues.forEach(i => console.error(' -', i.path.join('.'), i.message));
  process.exit(1);
}

module.exports = { env: result.data };
