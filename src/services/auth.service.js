'use strict';

const { pool } = require('./db.service');
const { encryptToken, decryptToken } = require('../utils/crypto');

/**
 * Persist OAuth tokens for an account.
 *
 * Signature is intentionally flexible to support both legacy callers that pass
 * (accountId, userId, accessToken) and new callers that pass
 * (accountId, accessToken, refreshToken, expiresAt).
 *
 * Legacy detection: if the third argument is a string that looks like a token
 * (not a Date / null / undefined) we treat the call as:
 *   saveToken(accountId, userId, accessToken)
 *
 * New signature:
 *   saveToken(accountId, accessToken, refreshToken, expiresAt)
 */
async function saveToken(accountId, accessTokenOrUserId, refreshTokenOrAccessToken, expiresAt = null) {
  let accessToken, refreshToken, userId;

  // Detect legacy call: saveToken(accountId, userId, accessToken)
  // In the legacy form the 4th argument is always absent (undefined / null from
  // req.onTokenRefreshed) and the 3rd argument is the actual access token string.
  if (expiresAt === null && typeof refreshTokenOrAccessToken === 'string' && refreshTokenOrAccessToken.length > 0) {
    // Could be legacy (accountId, userId, accessToken) OR new (accountId, accessToken, refreshToken)
    // Distinguish: legacy callers always pass userId as 2nd arg, which is either a
    // numeric-string or null. New callers pass an access_token (JWT, starts with "ey" or is long).
    // Safest heuristic: if accessTokenOrUserId is null or a short numeric-ish string → legacy.
    const secondArg = accessTokenOrUserId;
    if (secondArg === null || (typeof secondArg === 'string' && /^\d+$/.test(secondArg))) {
      // Legacy: (accountId, userId, accessToken)
      userId = secondArg;
      accessToken = refreshTokenOrAccessToken;
      refreshToken = null;
    } else {
      // New: (accountId, accessToken, refreshToken, expiresAt=null)
      accessToken = accessTokenOrUserId;
      refreshToken = refreshTokenOrAccessToken;
      userId = null;
    }
  } else if (typeof accessTokenOrUserId === 'string' && refreshTokenOrAccessToken == null) {
    // New style with only 2 meaningful args: saveToken(accountId, accessToken)
    accessToken = accessTokenOrUserId;
    refreshToken = null;
    userId = null;
  } else {
    // New: (accountId, accessToken, refreshToken?, expiresAt?)
    accessToken = accessTokenOrUserId;
    refreshToken = refreshTokenOrAccessToken || null;
    userId = null;
  }

  await pool.query(
    `INSERT INTO tokens (account_id, user_id, access_token, refresh_token, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (account_id) DO UPDATE
     SET access_token = $3,
         user_id      = COALESCE($2, tokens.user_id),
         refresh_token = COALESCE($4, tokens.refresh_token),
         expires_at   = $5,
         updated_at   = NOW()`,
    [
      accountId,
      userId,
      encryptToken(accessToken),
      refreshToken ? encryptToken(refreshToken) : null,
      expiresAt,
    ]
  );
}

async function getToken(accountId) {
  const res = await pool.query(
    'SELECT access_token, refresh_token, expires_at FROM tokens WHERE account_id = $1',
    [accountId]
  );
  if (!res.rows.length) return null;
  const row = res.rows[0];
  return {
    accessToken:  decryptToken(row.access_token),
    refreshToken: row.refresh_token ? decryptToken(row.refresh_token) : null,
    expiresAt:    row.expires_at || null,
  };
}

module.exports = { saveToken, getToken };
