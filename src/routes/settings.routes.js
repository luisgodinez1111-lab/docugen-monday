'use strict';
const { Router } = require('express');

module.exports = function makeSettingsRouter(deps) {
  const { pool, requireAuth } = deps;
  const router = Router();

  // FIX-2: requireAuth added — use req.accountId from auth, not query/header
  router.get('/settings', requireAuth, async (req, res) => {
    try {
      const r = await pool.query('SELECT settings FROM account_settings WHERE account_id=$1', [req.accountId]);
      res.json({ success: true, settings: r.rows.length ? r.rows[0].settings : {} });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/settings', requireAuth, async (req, res) => {
    try {
      const existing = await pool.query('SELECT settings FROM account_settings WHERE account_id=$1', [req.accountId]);
      const current = existing.rows.length ? existing.rows[0].settings : {};
      const merged = Object.assign({}, current, req.body.settings || {});
      await pool.query(
        'INSERT INTO account_settings (account_id, settings) VALUES ($1,$2) ON CONFLICT (account_id) DO UPDATE SET settings=$2, updated_at=NOW()',
        [req.accountId, JSON.stringify(merged)]
      );
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
