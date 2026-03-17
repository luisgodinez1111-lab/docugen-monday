'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

module.exports = function makeOauthRouter(deps) {
  const { saveToken, getToken, logger } = deps;
  const router = Router();

  // P2-4: Mapa en memoria para validar el state CSRF del flujo OAuth
  const oauthStateStore = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000; // expirar states > 15 min
    for (const [k, v] of oauthStateStore.entries()) {
      if (v.createdAt < cutoff) oauthStateStore.delete(k);
    }
  }, 10 * 60 * 1000);

  router.get('/oauth/start', (req, res) => {
    const clientId = process.env.MONDAY_CLIENT_ID;
    const redirectUri = encodeURIComponent(process.env.REDIRECT_URI);
    const scopes = 'boards:read boards:write me:read notifications:write';

    // P2-4: state criptográfico (crypto.randomBytes, no Math.random)
    const state = crypto.randomBytes(16).toString('hex');
    oauthStateStore.set(state, { createdAt: Date.now() });

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

    // P2-4: Validar state anti-CSRF antes de usar el code
    if (!state || !oauthStateStore.has(state)) {
      return res.status(400).json({ error: 'Estado OAuth inválido o expirado. Inicia el flujo nuevamente.' });
    }
    oauthStateStore.delete(state); // use-once: eliminar tras validar

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
