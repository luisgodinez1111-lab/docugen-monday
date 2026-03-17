'use strict';
/**
 * src/middleware/rateLimit.js
 * Redis-backed sliding-window rate limiter with in-memory fallback.
 *
 * When REDIS_URL is set: uses Redis INCR + PEXPIRE (atomic enough for DocuGen's
 * traffic scale — see NOTE below).
 * When Redis is unavailable: degrades gracefully to the original Map-based limiter.
 *
 * NOTE: INCR then PEXPIRE is not 100% atomic (two round-trips). For very high
 * concurrency a Lua script would be safer, but for DocuGen's 20 req/min-per-account
 * use case the race window is inconsequential.
 */

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL;

// ── Redis client (optional) ────────────────────────────────────────────────
let redisClient = null;
if (REDIS_URL) {
  redisClient = new Redis(REDIS_URL, {
    lazyConnect:          true,
    maxRetriesPerRequest: 1,
    enableReadyCheck:     false,
  });
  redisClient.on('error', (err) => {
    // Degrade gracefully — log once, fall back to in-memory
    if (redisClient) {
      console.error('[rateLimit] Redis error — falling back to in-memory:', err.message);
      redisClient = null;
    }
  });
}

// ── In-memory fallback (original Map-based implementation) ─────────────────
const memStore = new Map();

// Prune stale entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, entry] of memStore.entries()) {
    if (entry.windowStart < cutoff) memStore.delete(key);
  }
}, 10 * 60 * 1000).unref(); // .unref() so this timer doesn't keep the process alive

function memCheck(key, maxRequests, windowMs, res) {
  const now = Date.now();
  if (!memStore.has(key)) {
    memStore.set(key, { count: 1, windowStart: now });
    return true; // allow
  }
  const entry = memStore.get(key);
  if (now - entry.windowStart > windowMs) {
    entry.count = 1;
    entry.windowStart = now;
    return true;
  }
  entry.count++;
  if (entry.count > maxRequests) {
    const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    res.status(429).json({
      error:        'Too many requests',
      message:      'Rate limit exceeded. Please wait before generating more documents.',
      retryAfter,
    });
    return false;
  }
  return true;
}

// ── Factory ────────────────────────────────────────────────────────────────
/**
 * Creates an Express middleware that rate-limits by account_id.
 * @param {number} maxRequests - Max requests per window
 * @param {number} windowMs    - Window duration in milliseconds
 * @returns {Function} Express middleware
 */
function makeRateLimiter(maxRequests, windowMs) {
  return async (req, res, next) => {
    const accountId = req.accountId
      || req.body?.accountId
      || req.body?.account_id
      || req.query?.account_id
      || 'unknown';

    // Redis path
    if (redisClient) {
      const windowKey = Math.floor(Date.now() / windowMs);
      const key = `rl:${accountId}:${windowKey}`;
      try {
        const count = await redisClient.incr(key);
        if (count === 1) await redisClient.pexpire(key, windowMs);
        if (count > maxRequests) {
          const ttl = await redisClient.pttl(key);
          return res.status(429).json({
            error:        'Too many requests',
            message:      'Rate limit exceeded. Please wait before generating more documents.',
            retryAfter:   Math.max(1, Math.ceil(ttl / 1000)),
          });
        }
        return next();
      } catch (err) {
        // Redis failed mid-request — degrade to in-memory, don't block
        console.error('[rateLimit] Redis call failed:', err.message);
      }
    }

    // In-memory fallback
    const memKey = `${accountId}`;
    if (!memCheck(memKey, maxRequests, windowMs, res)) return;
    next();
  };
}

module.exports = { makeRateLimiter };
