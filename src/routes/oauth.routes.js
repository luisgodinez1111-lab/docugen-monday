'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

// P2-1: OAuth state store — persisted in Redis when REDIS_URL is set, fallback to Map otherwise
const stateStore = {
  async set(key, value, ttlMs) {
    if (process.env.REDIS_URL) {
      const Redis = require('ioredis');
      if (!stateStore._redis) stateStore._redis = new Redis(process.env.REDIS_URL, { lazyConnect: false });
      await stateStore._redis.set('oauth_state:' + key, value, 'PX', ttlMs);
    } else {
      stateStore._map = stateStore._map || new Map();
      stateStore._map.set(key, value);
      setTimeout(() => stateStore._map.delete(key), ttlMs);
    }
  },
  async get(key) {
    if (process.env.REDIS_URL) {
      if (!stateStore._redis) stateStore._redis = new Redis(process.env.REDIS_URL, { lazyConnect: false });
      return stateStore._redis.get('oauth_state:' + key);
    }
    return stateStore._map?.get(key) ?? null;
  },
  async delete(key) {
    if (process.env.REDIS_URL) {
      if (!stateStore._redis) return;
      await stateStore._redis.del('oauth_state:' + key);
    } else {
      stateStore._map?.delete(key);
    }
  }
};

module.exports = function makeOauthRouter(deps) {
  const { saveToken, getToken, logger } = deps;
  const router = Router();

  router.get('/oauth/start', async (req, res) => {
    const clientId = process.env.MONDAY_CLIENT_ID;
    const redirectUri = encodeURIComponent(process.env.REDIRECT_URI);
    const scopes = 'boards:read boards:write me:read notifications:write';

    // P2-1: state criptográfico (crypto.randomBytes, no Math.random) — stored in Redis or Map
    const state = crypto.randomBytes(16).toString('hex');
    await stateStore.set(state, state, 15 * 60 * 1000);

    res.redirect(
      'https://auth.monday.com/oauth2/authorize' +
      '?client_id=' + clientId +
      '&redirect_uri=' + redirectUri +
      '&scope=' + encodeURIComponent(scopes) +
      '&state=' + state
    );
  });

  router.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).json({ error: 'No se recibio codigo' });

    // P2-1: Validar state anti-CSRF antes de usar el code
    const savedState = await stateStore.get(state);
    if (!state || !savedState) {
      return res.status(400).json({ error: 'Estado OAuth inválido o expirado. Inicia el flujo nuevamente.' });
    }
    await stateStore.delete(state); // use-once: eliminar tras validar

    try {
      const response = await axios.post('https://auth.monday.com/oauth2/token', {
        client_id: process.env.MONDAY_CLIENT_ID,
        client_secret: process.env.MONDAY_CLIENT_SECRET,
        code,
        redirect_uri: process.env.REDIRECT_URI
      }, { timeout: 15000 });
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
      logger.error('Error OAuth:', error.response?.data || error.message);
      res.status(500).json({ error: 'Error OAuth', details: error.response?.data });
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
