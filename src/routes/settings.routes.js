'use strict';
const { Router } = require('express');
const { MAX_STRING_LENGTH, MAX_SETTINGS_KEYS, MAX_FILENAME_LENGTH } = require('../utils/config');

// Whitelist of allowed settings keys and their validators.
// Any key not in this map is silently dropped — prevents arbitrary property injection.
const SETTINGS_SCHEMA = {
  empresa:       (v) => typeof v === 'string' && v.length <= MAX_STRING_LENGTH,
  rfc:           (v) => typeof v === 'string' && v.length <= 15,
  domicilio:     (v) => typeof v === 'string' && v.length <= MAX_STRING_LENGTH,
  iva:           (v) => typeof v === 'number' && v >= 0 && v <= 1,
  moneda:        (v) => typeof v === 'string' && ['MXN','USD','EUR'].includes(v),
  telefono:      (v) => typeof v === 'string' && v.length <= 20,
  email_empresa: (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254,
  date_format:   (v) => typeof v === 'string' && v.length <= 20,
  timezone:      (v) => typeof v === 'string' && v.length <= 50,
  iva_rate:      (v) => typeof v === 'number' && v >= 0 && v <= 1,
  // custom_fields: array of { key, value } objects
  custom_fields: (v) => Array.isArray(v)
    && v.length <= MAX_SETTINGS_KEYS
    && v.every(f => f && typeof f.key === 'string' && f.key.length <= 50
                       && typeof f.value === 'string' && f.value.length <= MAX_STRING_LENGTH),
};

function validateSettings(incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { valid: false, message: 'settings must be a plain object' };
  }
  const clean = {};
  for (const [key, value] of Object.entries(incoming)) {
    const validator = SETTINGS_SCHEMA[key];
    if (!validator) continue;           // unknown key — drop silently
    if (!validator(value)) {
      return { valid: false, message: `Invalid value for settings.${key}` };
    }
    clean[key] = value;
  }
  return { valid: true, clean };
}

module.exports = function makeSettingsRouter(deps) {
  const { pool, requireAuth } = deps;
  const router = Router();

  router.get('/settings', requireAuth, async (req, res) => {
    try {
      const r = await pool.query('SELECT settings FROM account_settings WHERE account_id=$1', [req.accountId]);
      res.json({ success: true, settings: r.rows.length ? r.rows[0].settings : {} });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/settings', requireAuth, async (req, res) => {
    // Validate incoming settings against whitelist schema
    const { valid, message, clean } = validateSettings(req.body.settings);
    if (!valid) return res.status(400).json({ error: message });

    try {
      const existing = await pool.query('SELECT settings FROM account_settings WHERE account_id=$1', [req.accountId]);
      const current  = existing.rows.length ? existing.rows[0].settings : {};
      const merged   = Object.assign({}, current, clean);
      await pool.query(
        'INSERT INTO account_settings (account_id, settings) VALUES ($1,$2) ON CONFLICT (account_id) DO UPDATE SET settings=$2, updated_at=NOW()',
        [req.accountId, JSON.stringify(merged)]
      );
      // I3: Audit log for settings update
      pool.query('INSERT INTO audit_log (account_id, action, details) VALUES ($1,$2,$3)',
        [req.accountId, 'settings.update', JSON.stringify({ keys: Object.keys(clean) })]).catch(err => { try { require('../services/logger.service').warn({ err: err.message }, 'audit/email fire-and-forget failed'); } catch {} });
      res.json({ success: true });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // ── Board persistence: save/get the last used boardId per account ──
  router.post('/board/save', requireAuth, async (req, res) => {
    const { board_id, board_name } = req.body;
    if (!board_id) return res.status(400).json({ error: 'board_id requerido' });
    try {
      await pool.query(
        `INSERT INTO account_boards (account_id, board_id, board_name, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (account_id) DO UPDATE SET board_id=$2, board_name=$3, updated_at=NOW()`,
        [req.accountId, String(board_id), board_name || null]
      );
      res.json({ success: true });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.get('/board/current', requireAuth, async (req, res) => {
    try {
      const r = await pool.query('SELECT board_id, board_name FROM account_boards WHERE account_id=$1', [req.accountId]);
      res.json(r.rows[0] || { board_id: null, board_name: null });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
