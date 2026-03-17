'use strict';
const { Router } = require('express');

module.exports = function makeSettingsRouter(deps) {
  const { pool, requireAuth } = deps;
  const router = Router();

  router.get('/settings', async (req, res) => {
    const accountId = req.query.account_id || req.headers['x-account-id'];
    if (!accountId) return res.status(400).json({ error: 'account_id required' });
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS account_settings (account_id TEXT PRIMARY KEY, settings JSONB DEFAULT '{}', updated_at TIMESTAMP DEFAULT NOW())`);
      const r = await pool.query('SELECT settings FROM account_settings WHERE account_id=$1', [accountId]);
      res.json({ success: true, settings: r.rows.length ? r.rows[0].settings : {} });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/settings', requireAuth, async (req, res) => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS account_settings (account_id TEXT PRIMARY KEY, settings JSONB DEFAULT '{}', updated_at TIMESTAMP DEFAULT NOW())`);
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
