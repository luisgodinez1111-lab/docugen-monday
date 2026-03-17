/**
 * src/queues/connection.ts
 * Redis connection for BullMQ — gracefully optional.
 *
 * If REDIS_URL is not set, exports null and queues are disabled
 * (app falls back to in-process synchronous processing).
 *
 * Note: BullMQ bundles its own ioredis. Pass the URL string
 * directly to BullMQ Queue/Worker instead of an IORedis instance
 * to avoid type conflicts between the two ioredis versions.
 */
import { logger } from '../shared/logger';

export const REDIS_URL: string | undefined = process.env['REDIS_URL'];

export const redisAvailable: boolean = !!REDIS_URL;

if (REDIS_URL) {
  logger.info({ redisUrl: REDIS_URL.replace(/:\/\/.*@/, '://***@') }, 'Redis URL configured for BullMQ');
} else {
  logger.info('REDIS_URL not set — BullMQ queues disabled (synchronous fallback active)');
}
