/**
 * src/shared/logger.ts
 * Pino structured JSON logger — single instance for the whole app.
 *
 * Usage:
 *   const { logger } = require('./src/shared/logger');
 *   logger.info({ accountId, itemId }, 'Document generated');
 *   logger.error({ err }, 'PDF conversion failed');
 *
 * In production (NODE_ENV=production) → JSON output (structured, parseable by Railway/Datadog)
 * In development → pretty-printed colored output via pino-pretty
 */
import pino from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

export const logger = pino(
  {
    level: process.env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info'),
    base: { service: 'docugen-backend', version: process.env['npm_package_version'] ?? '2.0.0' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    redact: {
      paths: [
        'accessToken',
        'req.headers.authorization',
        'TOKEN_ENCRYPTION_KEY',
        'MONDAY_CLIENT_SECRET',
        'MONDAY_SIGNING_SECRET',
      ],
      censor: '[REDACTED]',
    },
  },
  isDev
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
        },
      })
    : pino.destination({ sync: false })
);

/** Child logger factory — attach a fixed context to every log call */
export function childLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
