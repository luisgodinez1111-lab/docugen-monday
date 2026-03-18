'use strict';

// Exponential backoff: delay * 2^i (i=0→1s, i=1→2s, i=2→4s)
// Capped at 30s per attempt to avoid thundering herd on recovery.
async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch(e) {
      if (i === retries - 1) throw e;
      const backoff = Math.min(delay * Math.pow(2, i), 30_000);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

module.exports = { withRetry };
