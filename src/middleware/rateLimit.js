'use strict';
/**
 * src/middleware/rateLimit.js
 * Redis-backed fixed-window rate limiter with in-memory fallback.
 *
 * Redis path: atomic Lua script (INCR + PEXPIRE in one round-trip) — no race
 * window between the two commands; safe at any concurrency level.
 * Fallback: Map-based with periodic stale-entry pruning.
 */

const Redis = require('ioredis');

// ── Redis client (optional) ────────────────────────────────────────────────
let redisClient = null;
if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, {
    lazyConnect:          true,
    maxRetriesPerRequest: 1,
    enableReadyCheck:     false,
  });
  redisClient.on('error', (err) => {
    if (redisClient) {
      try { require('../services/logger.service').warn({ err: err.message }, '[rateLimit] Redis error — falling back to in-memory'); } catch {}
      redisClient = null;
    }
  });
}

// ── Lua script: atomic INCR + PEXPIRE ─────────────────────────────────────
// Returns the new counter value. Sets TTL only on the first increment so we
// don't accidentally reset the window on every call.
const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

// ── In-memory fallback ─────────────────────────────────────────────────────
const memStore = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, entry] of memStore.entries()) {
    if (entry.windowStart < cutoff) memStore.delete(key);
  }
}, 10 * 60 * 1000).unref();

function memCheck(key, maxRequests, windowMs, res) {
  const now = Date.now();
  if (!memStore.has(key)) {
    memStore.set(key, { count: 1, windowStart: now });
    return true;
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
      error:      'Too many requests',
      message:    'Rate limit exceeded. Please wait before generating more documents.',
      retryAfter,
    });
    return false;
  }
  return true;
}

// ── Factory ────────────────────────────────────────────────────────────────
function makeRateLimiter(maxRequests, windowMs) {
  return async (req, res, next) => {
    const accountId = req.accountId
      || req.body?.accountId
      || req.body?.account_id
      || req.query?.account_id
      || 'unknown';

    if (redisClient) {
      const windowKey = Math.floor(Date.now() / windowMs);
      const key = `rl:${accountId}:${windowKey}`;
      try {
        // Single atomic round-trip via Lua — no race between INCR and PEXPIRE
        const count = await redisClient.eval(RATE_LIMIT_SCRIPT, 1, key, windowMs);
        if (count > maxRequests) {
          const ttl = await redisClient.pttl(key);
          return res.status(429).json({
            error:      'Too many requests',
            message:    'Rate limit exceeded. Please wait before generating more documents.',
            retryAfter: Math.max(1, Math.ceil(ttl / 1000)),
          });
        }
        return next();
      } catch (err) {
        try { require('../services/logger.service').warn({ err: err.message }, '[rateLimit] Redis call failed — falling back to in-memory'); } catch {}
        // fall through to in-memory
      }
    }

    const memKey = `${accountId}`;
    if (!memCheck(memKey, maxRequests, windowMs, res)) return;
    next();
  };
}

module.exports = { makeRateLimiter };
