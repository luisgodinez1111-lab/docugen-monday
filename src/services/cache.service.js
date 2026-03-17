'use strict';

/**
 * src/services/cache.service.js
 * Thin Redis cache wrapper.
 * Returns null on every operation when REDIS_URL is not set — callers fall through to DB.
 * Never throws; cache failures are non-critical.
 */

let redis = null;
if (process.env.REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    redis = new IORedis(process.env.REDIS_URL, {
      lazyConnect:          true,
      maxRetriesPerRequest: 1,
      enableReadyCheck:     false,
    });
    redis.on('error', () => { /* suppress — logged by ioredis internally */ });
  } catch {
    redis = null;
  }
}

async function cacheGet(key) {
  if (!redis) return null;
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

async function cacheSet(key, value, ttlSeconds = 60) {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch { /* non-critical */ }
}

async function cacheDel(key) {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch { /* non-critical */ }
}

module.exports = { cacheGet, cacheSet, cacheDel };
