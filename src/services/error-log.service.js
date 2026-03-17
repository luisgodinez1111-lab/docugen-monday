'use strict';

const { pool } = require('./db.service');

async function logError(accountId, type, message, stack) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS error_logs (
      id SERIAL PRIMARY KEY, account_id TEXT, error_type TEXT,
      message TEXT, stack TEXT, created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query('INSERT INTO error_logs (account_id, error_type, message, stack) VALUES ($1,$2,$3,$4)',
      [accountId, type, message, stack]);
  } catch(e) {}
}

module.exports = { logError };
