'use strict';

const { saveToken } = require('./auth.service');
const { REFRESH_IN_FLIGHT_TTL_MS, PROACTIVE_REFRESH_WINDOW_MS } = require('../utils/config');

// In-flight refresh promises per account (prevent concurrent refresh storms).
// Each entry: { promise, insertedAt } — stale entries (> TTL) are evicted to
// prevent leaks if the process never crashes but entries somehow get orphaned.
const refreshInFlight = new Map();

// Stale-entry sweep — runs every TTL interval, doesn't block process exit
setInterval(() => {
  const cutoff = Date.now() - REFRESH_IN_FLIGHT_TTL_MS;
  for (const [id, entry] of refreshInFlight) {
    if (entry.insertedAt < cutoff) refreshInFlight.delete(id);
  }
}, REFRESH_IN_FLIGHT_TTL_MS).unref();

async function refreshMondayToken(accountId, refreshToken) {
  if (refreshInFlight.has(accountId)) {
    return refreshInFlight.get(accountId).promise;
  }

  const refreshPromise = (async () => {
    const clientId     = process.env.MONDAY_CLIENT_ID;
    const clientSecret = process.env.MONDAY_CLIENT_SECRET;

    const response = await fetch('https://auth.monday.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const newAccessToken  = data.access_token;
    const newRefreshToken = data.refresh_token || refreshToken;
    const expiresIn       = data.expires_in || 3600;
    const expiresAt       = new Date(Date.now() + expiresIn * 1000);

    await saveToken(accountId, newAccessToken, newRefreshToken, expiresAt);
    return newAccessToken;
  })();

  refreshInFlight.set(accountId, { promise: refreshPromise, insertedAt: Date.now() });

  try {
    return await refreshPromise;
  } finally {
    refreshInFlight.delete(accountId);
  }
}

function isTokenExpiredOrExpiringSoon(expiresAt, proactiveWindowMs = PROACTIVE_REFRESH_WINDOW_MS) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now() + proactiveWindowMs;
}

module.exports = { refreshMondayToken, isTokenExpiredOrExpiringSoon };
