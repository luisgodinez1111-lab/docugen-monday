'use strict';

const { saveToken } = require('./auth.service');

// In-flight refresh promises per account (prevent concurrent refresh storms)
const refreshInFlight = new Map();

/**
 * Refresh the OAuth token for an account.
 * Deduplicates concurrent refresh calls for the same account so that parallel
 * requests don't trigger multiple simultaneous refresh round-trips.
 *
 * @param {string} accountId
 * @param {string} refreshToken
 * @returns {Promise<string>} new access token
 */
async function refreshMondayToken(accountId, refreshToken) {
  // Deduplicate: if already refreshing for this account, wait for it
  if (refreshInFlight.has(accountId)) {
    return refreshInFlight.get(accountId);
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
    // Some providers don't rotate the refresh token; keep the old one in that case.
    const newRefreshToken = data.refresh_token || refreshToken;

    // Store expiry — Monday tokens typically expire in 1 hour (3600 s)
    const expiresIn = data.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    await saveToken(accountId, newAccessToken, newRefreshToken, expiresAt);
    return newAccessToken;
  })();

  refreshInFlight.set(accountId, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    refreshInFlight.delete(accountId);
  }
}

/**
 * Returns true if the token is already expired or will expire within the
 * proactive window (default: 10 minutes).
 * Returns false when expiresAt is unknown — the reactive 401 path handles that.
 *
 * @param {Date|string|null} expiresAt
 * @param {number} proactiveWindowMs  milliseconds before expiry to start refreshing
 */
function isTokenExpiredOrExpiringSoon(expiresAt, proactiveWindowMs = 10 * 60 * 1000) {
  if (!expiresAt) return false; // unknown expiry — let reactive 401 handle it
  return new Date(expiresAt).getTime() < Date.now() + proactiveWindowMs;
}

module.exports = { refreshMondayToken, isTokenExpiredOrExpiringSoon };
