'use strict';
/**
 * src/services/db.service.js
 * Shared PostgreSQL pool + transaction helper.
 *
 * Exports:
 *   pool           — pg.Pool instance (singleton)
 *   withTransaction(pool, fn) — BEGIN/COMMIT/ROLLBACK wrapper
 *
 * Usage:
 *   const { pool, withTransaction } = require('./src/services/db.service');
 *   await withTransaction(pool, async (client) => {
 *     await client.query('INSERT ...');
 *     await client.query('UPDATE ...');
 *   });
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Connection pool settings optimised for Railway's single-instance deployment
  max:              10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/**
 * Executes an async function inside a DB transaction.
 * Automatically commits on success, rolls back on any thrown error.
 *
 * @template T
 * @param {import('pg').Pool} poolArg - The pg Pool to acquire a client from
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn - Work to do inside the transaction
 * @returns {Promise<T>}
 */
async function withTransaction(poolArg, fn) {
  const client = await poolArg.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function initDB(logger) {
  const log = logger || console;
  try {
    // ── FIX-10: ALL CREATE TABLE statements first, then ALL ALTER TABLE statements ──

    // ─── CREATE TABLE statements ───────────────────────────────────────────────
    await pool.query(`CREATE TABLE IF NOT EXISTS tokens (account_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, user_id TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS templates (id SERIAL PRIMARY KEY, account_id TEXT NOT NULL, filename TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(account_id, filename));`);
    await pool.query(`CREATE TABLE IF NOT EXISTS documents (id SERIAL PRIMARY KEY, account_id TEXT NOT NULL, board_id TEXT, item_id TEXT, item_name TEXT, template_name TEXT, filename TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pdf_jobs (
        job_id TEXT PRIMARY KEY,
        account_id TEXT,
        status TEXT DEFAULT 'processing',
        filename TEXT,
        item_name TEXT,
        error TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS logos (
      account_id TEXT PRIMARY KEY,
      filename TEXT,
      data BYTEA NOT NULL,
      mimetype TEXT DEFAULT 'image/png',
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      plan TEXT DEFAULT 'free',
      docs_generated INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY,
      event_type TEXT,
      item_id TEXT,
      board_id TEXT,
      column_id TEXT,
      column_value TEXT,
      account_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS webhook_triggers (
      id SERIAL PRIMARY KEY,
      account_id TEXT,
      board_id TEXT,
      column_id TEXT,
      trigger_value TEXT,
      template_name TEXT,
      action TEXT DEFAULT 'generate',
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_automations (
      id SERIAL PRIMARY KEY,
      account_id TEXT,
      name TEXT,
      cron_expression TEXT,
      board_id TEXT,
      template_name TEXT,
      condition_column TEXT,
      condition_value TEXT,
      last_run TIMESTAMP,
      next_run TIMESTAMP,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    // FIX-10: signature_requests CREATE TABLE must come before any ALTER TABLE on it
    await pool.query(`CREATE TABLE IF NOT EXISTS signature_requests (
      id SERIAL PRIMARY KEY,
      account_id TEXT,
      item_id TEXT,
      board_id TEXT,
      document_filename TEXT,
      signer_name TEXT,
      signer_email TEXT,
      token TEXT UNIQUE,
      status TEXT DEFAULT 'pending',
      signed_at TIMESTAMP,
      ip_address TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    // P3-2: additional tables in initDB to avoid CREATE TABLE in each request
    await pool.query(`CREATE TABLE IF NOT EXISTS account_settings (account_id TEXT PRIMARY KEY, settings JSONB DEFAULT '{}', updated_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS portal_logos (account_id TEXT PRIMARY KEY, filename TEXT, data BYTEA, mimetype TEXT, updated_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS lifecycle_events (id SERIAL PRIMARY KEY, event_type TEXT NOT NULL, account_id TEXT, user_id TEXT, plan_id TEXT, is_trial BOOLEAN, renewal_date TEXT, data JSONB, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (account_id TEXT PRIMARY KEY, plan_id TEXT, status TEXT DEFAULT 'active', is_trial BOOLEAN DEFAULT false, renewal_date TEXT, docs_limit INT DEFAULT 10, docs_used INT DEFAULT 0, trial_ends_at TIMESTAMP, subscribed_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS approval_requests (id SERIAL PRIMARY KEY, approval_token TEXT UNIQUE NOT NULL, signature_request_id INT, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS error_logs (id SERIAL PRIMARY KEY, account_id TEXT, error_type TEXT, message TEXT, stack TEXT, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS backups (id SERIAL PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW(), tables_backed_up INT, total_rows INT, status TEXT, error TEXT)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS backup_data (id SERIAL PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW(), data TEXT)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS deletion_queue (id SERIAL PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, scheduled_for TIMESTAMPTZ NOT NULL, executed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS document_events (
      id          BIGSERIAL PRIMARY KEY,
      document_id BIGINT NOT NULL,
      event_type  TEXT NOT NULL,
      actor_id    TEXT,
      metadata    JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ─── ALTER TABLE statements (all after CREATE TABLE) ──────────────────────
    await pool.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS user_id TEXT`);
    await pool.query(`ALTER TABLE templates ADD COLUMN IF NOT EXISTS canvas_json TEXT`);
    await pool.query(`ALTER TABLE templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    await pool.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_data BYTEA');
    await pool.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS signed_pdf BYTEA');
    await pool.query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    await pool.query('ALTER TABLE pdf_jobs ADD COLUMN IF NOT EXISTS pdf_data BYTEA');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS doc_data BYTEA');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signed_pdf BYTEA');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signature_type TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signer_order INT DEFAULT 1');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS group_id TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_code TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_verified BOOLEAN DEFAULT FALSE');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS doc_hash TEXT');
    await pool.query("ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS doc_type TEXT DEFAULT 'document'");
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS quote_response TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS quote_comment TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS quote_responded_at TIMESTAMP');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS time_on_portal INT DEFAULT 0');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signed_hash TEXT');
    await pool.query("ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS audit_log JSONB DEFAULT '[]'");
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS consent_text TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS identity_verified BOOLEAN DEFAULT FALSE');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_attempts INT DEFAULT 0');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS user_agent TEXT');
    await pool.query('ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signature_data TEXT'); // P0-4
    // #9 Webhook deduplication: event_id column + partial unique index
    await pool.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS event_id TEXT`);
    // Improvement #9: proactive token refresh — store refresh_token and expires_at
    await pool.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS refresh_token TEXT`);
    await pool.query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);

    // ── ÍNDICES CRÍTICOS (evitan full table scans en producción) ──
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tokens_account       ON tokens(account_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_templates_account    ON templates(account_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_documents_account    ON documents(account_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_documents_item       ON documents(item_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sigs_account         ON signature_requests(account_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sigs_token           ON signature_requests(token)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sigs_group           ON signature_requests(group_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sigs_status          ON signature_requests(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pdf_jobs_account     ON pdf_jobs(account_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_account ON subscriptions(account_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deletion_queue_sched  ON deletion_queue(scheduled_for) WHERE executed_at IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhook_triggers_acct ON webhook_triggers(account_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sched_autos_account   ON scheduled_automations(account_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_event_id ON webhook_events(event_id) WHERE event_id IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_document_events_document_id ON document_events(document_id)`);

    log.info('Database initialised');
  } catch (err) {
    log.error({ err: err.message }, 'Error initialising DB');
    throw err;  // P0-3: rethrow so the process fails fast on fatal schema errors
  }
}

module.exports = { pool, withTransaction, initDB };
