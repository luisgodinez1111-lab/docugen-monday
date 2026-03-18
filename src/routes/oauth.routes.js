'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

// OAuth state store — Redis when available, Map fallback.
// Map fallback: stores {value, expiresAt} and checks on get() — no per-entry setTimeout
// so there are no unbounded timer callbacks under load (no memory leak).
// A periodic sweep prunes expired entries every 5 min.
const Redis = require('ioredis');

const stateStore = (() => {
  // ── Redis client — initialised once at module load if REDIS_URL is set ──
  let _redis = null;
  if (process.env.REDIS_URL) {
    _redis = new Redis(process.env.REDIS_URL, {
      lazyConnect:          true,
      maxRetriesPerRequest: 1,
      enableReadyCheck:     false,
    });
    _redis.on('error', () => { _redis = null; }); // degrade to Map on error
  }

  // ── In-memory fallback — expiry checked at read time, not via setTimeout ──
  const _map = new Map();
  // Sweep expired entries every 5 minutes (timer doesn't prevent process exit)
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _map) { if (v.expiresAt <= now) _map.delete(k); }
  }, 5 * 60 * 1000).unref();

  return {
    async set(key, value, ttlMs) {
      if (_redis) {
        await _redis.set('oauth_state:' + key, value, 'PX', ttlMs).catch(() => {});
      } else {
        _map.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
    },
    async get(key) {
      if (_redis) return _redis.get('oauth_state:' + key).catch(() => null);
      const entry = _map.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) { _map.delete(key); return null; }
      return entry.value;
    },
    async delete(key) {
      if (_redis) await _redis.del('oauth_state:' + key).catch(() => {});
      else _map.delete(key);
    },
  };
})();

module.exports = function makeOauthRouter(deps) {
  const { saveToken, getToken, logger } = deps;
  const router = Router();

  router.get('/oauth/start', async (req, res) => {
    const clientId = process.env.MONDAY_CLIENT_ID;
    const redirectUri = encodeURIComponent(process.env.REDIRECT_URI);
    const scopes = 'boards:read boards:write me:read notifications:write';

    // P2-1: state criptográfico (crypto.randomBytes, no Math.random) — stored in Redis or Map
    const state = crypto.randomBytes(16).toString('hex');

    // B3: PKCE — generate code_verifier and code_challenge
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    // Store state mapped to verifier so callback can retrieve it
    // Format: JSON string { state, verifier }
    await stateStore.set(state, JSON.stringify({ state, verifier }), 15 * 60 * 1000);

    res.redirect(
      'https://auth.monday.com/oauth2/authorize' +
      '?client_id=' + clientId +
      '&redirect_uri=' + redirectUri +
      '&scope=' + encodeURIComponent(scopes) +
      '&state=' + state +
      '&code_challenge=' + challenge +
      '&code_challenge_method=S256'
    );
  });

  router.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).json({ error: 'No se recibio codigo' });

    // P2-1: Validar state anti-CSRF antes de usar el code
    const savedRaw = await stateStore.get(state);
    if (!state || !savedRaw) {
      return res.status(400).json({ error: 'Estado OAuth inválido o expirado. Inicia el flujo nuevamente.' });
    }
    await stateStore.delete(state); // use-once: eliminar tras validar

    // B3: Extract verifier from stored PKCE data
    let codeVerifier;
    try {
      const saved = JSON.parse(savedRaw);
      codeVerifier = saved.verifier;
    } catch {
      // Fallback: stored value is plain state (legacy, no PKCE)
      codeVerifier = undefined;
    }

    try {
      const tokenPayload = {
        client_id: process.env.MONDAY_CLIENT_ID,
        client_secret: process.env.MONDAY_CLIENT_SECRET,
        code,
        redirect_uri: process.env.REDIRECT_URI,
      };
      if (codeVerifier) tokenPayload.code_verifier = codeVerifier;

      const response = await axios.post('https://auth.monday.com/oauth2/token', tokenPayload, { timeout: 15000 });
      const { access_token, refresh_token } = response.data;
      const decoded = jwt.decode(access_token);
      const accountId = decoded?.actid?.toString() || 'default';
      const userId = decoded?.uid?.toString() || null;

      // Improvement #9: store refresh_token and expires_at for proactive refresh
      const expiresIn = response.data.expires_in || 3600;
      const expiresAt = new Date(Date.now() + expiresIn * 1000);
      // saveToken detects legacy (accountId, userId, accessToken) vs new call by
      // checking whether 2nd arg is a numeric user-id string — so we call the new
      // 4-arg form explicitly to store the refresh token and expiry.
      await saveToken(accountId, access_token, refresh_token || null, expiresAt);
      // P2-5: Redirigir solo a rutas internas conocidas
      res.redirect('/view?account_id=' + encodeURIComponent(accountId));
    } catch (error) {
      const details = error.response?.data || null;
      logger.error({ err: error.message, details }, 'OAuth callback error');
      res.status(500).json({ error: 'Error OAuth', message: error.message, details });
    }
  });

  router.get('/auth/check', async (req, res) => {
    const accountId = req.query.account_id;
    if (!accountId) return res.json({ authenticated: false });
    const token = await getToken(accountId);
    res.json({ authenticated: !!token, account_id: accountId });
  });

  return router;
};
