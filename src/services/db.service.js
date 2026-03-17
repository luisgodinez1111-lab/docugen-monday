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

module.exports = { pool, withTransaction };
