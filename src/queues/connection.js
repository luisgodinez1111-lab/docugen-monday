'use strict';
/**
 * src/queues/connection.js
 * Redis connection config for BullMQ — gracefully optional.
 */
const { logger } = require('../shared/logger');

const REDIS_URL = process.env.REDIS_URL;
const redisAvailable = !!REDIS_URL;

if (REDIS_URL) {
  logger.info({ redisUrl: REDIS_URL.replace(/:\/\/.*@/, '://***@') }, 'Redis URL configured for BullMQ');
} else {
  logger.info('REDIS_URL not set — BullMQ queues disabled (synchronous fallback active)');
}

module.exports = { REDIS_URL, redisAvailable };
