'use strict';

const Sentry = require('@sentry/node');
const { getToken, saveToken } = require('../services/auth.service');
const { refreshMondayToken, isTokenExpiredOrExpiringSoon } = require('../services/token-refresh.service');

async function requireAuth(req, res, next) {
  const accountId = (req.headers['x-account-id'] || req.query.account_id || '').trim();
  if (!accountId) return res.status(401).json({ error: 'Se requiere account_id' });

  const tokenData = await getToken(accountId);
  if (!tokenData) {
    return res.status(401).json({
      error:      'No hay sesión OAuth. Por favor conecta tu cuenta de Monday.',
      needs_auth: true,
    });
  }

  let { accessToken, refreshToken, expiresAt } = tokenData;

  // Proactive refresh: if the token expires within 10 minutes, refresh now
  // before the request reaches any downstream handler.
  if (isTokenExpiredOrExpiringSoon(expiresAt) && refreshToken) {
    try {
      accessToken = await refreshMondayToken(accountId, refreshToken);
    } catch (refreshErr) {
      // Refresh failed — instruct the client to re-authenticate
      return res.status(401).json({
        error:      'Sesión expirada. Por favor reconecta tu cuenta de Monday.',
        needs_auth: true,
      });
    }
  }

  req.accountId   = accountId;
  req.accessToken = accessToken;

  // #10 Sentry: attach account context so errors are tagged per-account
  Sentry.setUser({ id: accountId });

  // Reactive token refresh helper: called by graphql.js when Monday returns 401.
  // Stores the new token in the DB and updates req.accessToken for retry logic.
  req.onTokenRefreshed = async (newToken) => {
    await saveToken(accountId, newToken, null, null);
    req.accessToken = newToken;
  };

  next();
}

module.exports = { requireAuth };
