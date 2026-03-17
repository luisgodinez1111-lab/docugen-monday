'use strict';

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max:                    10,
  idleTimeoutMillis:  30_000,
  connectionTimeoutMillis: 15_000,
});

/**
 * Executes an async function inside a DB transaction.
 * Automatically commits on success, rolls back on any thrown error.
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

/**
 * Sequential migration runner.
 * Reads all *.sql files from src/migrations/ in filename order,
 * runs each one inside a transaction, and records it in schema_migrations.
 * Already-applied migrations are skipped (idempotent).
 */
async function initDB(logger) {
  const log = logger || console;
  const client = await pool.connect();
  try {
    // Bootstrap: ensure the tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const filename of files) {
      const already = await client.query(
        'SELECT 1 FROM schema_migrations WHERE filename=$1', [filename]
      );
      if (already.rows.length) {
        log.debug && log.debug({ filename }, 'Migration already applied — skipping');
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]
        );
        await client.query('COMMIT');
        log.info({ filename }, 'Migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        log.error({ err: err.message, filename }, 'Migration failed');
        throw err;
      }
    }

    log.info('Database initialised');
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction, initDB };
