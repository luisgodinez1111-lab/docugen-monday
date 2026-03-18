'use strict';

const { pool } = require('./db.service');

// P1-5: CREATE TABLE removed — error_logs table is created in initDB()
async function logError(accountId, type, message, stack) {
  try {
    await pool.query('INSERT INTO error_logs (account_id, error_type, message, stack) VALUES ($1,$2,$3,$4)',
      [accountId, type, message, stack]);
  } catch(e) {
    // Avoid infinite loops — log to stderr only (never call logError recursively)
    console.error('[error-log] Failed to persist error log:', e.message, '| original:', type, message);
  }
}

module.exports = { logError };
