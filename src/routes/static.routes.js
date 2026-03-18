'use strict';
const { Router } = require('express');
const path = require('path');

module.exports = function makeStaticRouter(deps) {
  const { pool, mondayBreaker, resendBreaker, tsaBreaker } = deps;
  const router = Router();

  // Health check — includes DB pool metrics and circuit breaker states
  router.get('/', async (req, res) => {
    // Pool metrics (pg exposes these on the Pool object)
    const poolStats = pool
      ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
      : null;

    const breakers = [mondayBreaker, resendBreaker, tsaBreaker]
      .filter(Boolean)
      .map(b => b.status);

    res.json({
      status:   'ok',
      message:  'DocuGen for monday',
      version:  '3.0.0',
      pool:     poolStats,
      breakers,
    });
  });

  // P3-2: MONDAY_APP_ID is validated by env.js at startup — no hardcoded fallback needed
  router.get('/.well-known/monday-app-association.json', (req, res) => {
    if (!process.env.MONDAY_APP_ID) {
      return res.status(503).json({ error: 'MONDAY_APP_ID not configured' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.json({ apps: [{ clientID: process.env.MONDAY_APP_ID }] });
  });

  // Convenience redirect: GET /docs → /api-docs
  router.get('/docs', (req, res) => {
    res.redirect(301, '/api-docs');
  });

  return router;
};
