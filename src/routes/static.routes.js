'use strict';
const { Router } = require('express');
const path = require('path');

module.exports = function makeStaticRouter(deps) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'DocuGen for monday', version: '3.0.0' });
  });

  // FIX-26: Use env var instead of hardcoded client ID
  router.get('/.well-known/monday-app-association.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({ apps: [{ clientID: process.env.MONDAY_APP_ID || '10969075' }] });
  });

  // Convenience redirect: GET /docs → /api-docs
  router.get('/docs', (req, res) => {
    res.redirect(301, '/api-docs');
  });

  return router;
};
