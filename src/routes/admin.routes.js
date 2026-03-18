'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const storageService = require('../services/storage.service');
const { mondayBreaker, resendBreaker, tsaBreaker } = require('../utils/circuit-breaker');

// FIX-1: Module-level Redis singleton — not created per-request
let _redisClient = null;
function getRedisClient() {
  if (!_redisClient && process.env.REDIS_URL) {
    const Redis = require('ioredis');
    _redisClient = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  }
  return _redisClient;
}

module.exports = function makeAdminRouter(deps) {
  const { pool, requireAuth, logger, runBackup } = deps;
  const router = Router();

  // ─── HEALTH CHECK ─────────────────────────────────────────
  router.get('/health', async (req, res) => {
    const startTime = Date.now();
    const checks = {};

    // DB ping
    try {
      const t0 = Date.now();
      await pool.query('SELECT 1');
      checks.database = { status: 'ok', latencyMs: Date.now() - t0 };
    } catch (e) {
      checks.database = { status: 'down', error: e.message };
    }

    // Redis ping — use singleton client
    if (process.env.REDIS_URL) {
      try {
        const redisClient = getRedisClient();
        const t0 = Date.now();
        await redisClient.ping();
        checks.redis = { status: 'ok', latencyMs: Date.now() - t0 };
      } catch (e) {
        checks.redis = { status: 'down', error: e.message };
      }
    }

    // Circuit breakers
    checks.circuitBreakers = {
      monday: { state: mondayBreaker.state, failures: mondayBreaker.failureCount },
      resend: { state: resendBreaker.state, failures: resendBreaker.failureCount },
      tsa:    { state: tsaBreaker.state,    failures: tsaBreaker.failureCount },
    };

    // BullMQ queue stats — always close in finally to prevent leak
    if (process.env.REDIS_URL) {
      let emailQueue = null;
      try {
        const { Queue } = require('bullmq');
        emailQueue = new Queue('email', { connection: { url: process.env.REDIS_URL } });
        const [waiting, active, failed] = await Promise.all([
          emailQueue.getWaitingCount(),
          emailQueue.getActiveCount(),
          emailQueue.getFailedCount(),
        ]);
        checks.emailQueue = { status: 'ok', waiting, active, failed };
      } catch (e) {
        checks.emailQueue = { status: 'down', error: e.message };
      } finally {
        if (emailQueue) await emailQueue.close().catch(() => {});
      }
    }

    // S3 storage
    checks.storage = { s3: storageService.isS3Enabled };

    // Overall status
    const isDown = checks.database?.status === 'down';
    const isDegraded = checks.redis?.status === 'down' ||
      Object.values(checks.circuitBreakers || {}).some(b => b.state !== 'CLOSED');

    const status = isDown ? 'down' : isDegraded ? 'degraded' : 'ok';

    res.status(isDown ? 503 : 200).json({
      status,
      version: require('../../package.json').version,
      uptime: process.uptime(),
      responseTimeMs: Date.now() - startTime,
      checks,
    });
  });

  // ─── MÉTRICAS ─────────────────────────────────────────────
  // FIX-16: DDL removed from handler — error_logs table created in initDB()
  router.get('/metrics', requireAuth, async (req, res) => {
    try {
      const [docs, sigs, tpls, errors, docsToday, sigsToday] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM documents WHERE account_id=$1', [req.accountId]),
        pool.query('SELECT COUNT(*) FROM signature_requests WHERE account_id=$1', [req.accountId]),
        pool.query('SELECT COUNT(*) FROM templates WHERE account_id=$1', [req.accountId]),
        pool.query('SELECT COUNT(*) FROM error_logs WHERE account_id=$1 AND created_at > NOW() - INTERVAL \'7 days\'', [req.accountId]),
        pool.query('SELECT COUNT(*) FROM documents WHERE account_id=$1 AND created_at > NOW() - INTERVAL \'1 day\'', [req.accountId]),
        pool.query('SELECT COUNT(*) FROM signature_requests WHERE account_id=$1 AND created_at > NOW() - INTERVAL \'1 day\'', [req.accountId]),
      ]);
      const docsByDay = await pool.query(
        'SELECT DATE(created_at) as day, COUNT(*) as count FROM documents WHERE account_id=$1 AND created_at > NOW() - INTERVAL \'30 days\' GROUP BY DATE(created_at) ORDER BY day',
        [req.accountId]
      );
      const sigsByStatus = await pool.query(
        'SELECT status, COUNT(*) as count FROM signature_requests WHERE account_id=$1 GROUP BY status',
        [req.accountId]
      );
      res.json({
        totals: {
          documents: parseInt(docs.rows[0].count),
          signatures: parseInt(sigs.rows[0].count),
          templates: parseInt(tpls.rows[0].count),
          errors_7d: parseInt(errors.rows[0].count),
        },
        today: {
          documents: parseInt(docsToday.rows[0].count),
          signatures: parseInt(sigsToday.rows[0].count),
        },
        charts: {
          docs_by_day: docsByDay.rows,
          sigs_by_status: sigsByStatus.rows,
        },
        system: {
          uptime_seconds: Math.round(process.uptime()),
          memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          node_version: process.version,
        }
      });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // ─── BACKUP AUTOMÁTICO ────────────────────────────────────
  // FIX-18: Admin secret required for backup endpoints
  function requireAdminSecret(req, res, next) {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.headers['x-admin-secret'] !== adminSecret) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  }

  // Endpoint para ver historial de backups
  // P3-7: System-wide — admin only (requireAdminSecret applied above). No account scoping needed for system backup data.
  router.get('/backups', requireAuth, requireAdminSecret, async (req, res) => {
    try {
      const r = await pool.query('SELECT id, created_at, tables_backed_up, total_rows, status, error FROM backups ORDER BY created_at DESC LIMIT 10');
      res.json({ backups: r.rows });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Endpoint para descargar último backup
  // P3-7: System-wide — admin only (requireAdminSecret applied above). No account scoping needed for system backup data.
  router.get('/backups/latest', requireAuth, requireAdminSecret, async (req, res) => {
    try {
      const r = await pool.query('SELECT data, created_at FROM backup_data ORDER BY created_at DESC LIMIT 1');
      if (!r.rows.length) return res.status(404).json({ error: 'Sin backups' });
      res.set('Content-Type', 'application/json');
      res.set('Content-Disposition', 'attachment; filename="docugen_backup_' + new Date().toISOString().split('T')[0] + '.json"');
      res.send(r.rows[0].data);
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // ─── LOGS: ERROR LOGS ──────────────────────────────────────
  router.get('/logs/errors', requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const [rows, count] = await Promise.all([
        pool.query(
          'SELECT id, error_type, message, created_at FROM error_logs WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
          [req.accountId, limit, offset]
        ),
        pool.query('SELECT COUNT(*)::int AS total FROM error_logs WHERE account_id=$1', [req.accountId]),
      ]);
      res.json({ errors: rows.rows, total: count.rows[0].total });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // ─── LOGS: WEBHOOK EVENTS ──────────────────────────────────
  router.get('/logs/webhooks', requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const status = req.query.status; // pending, done, failed, error:*
      const where = status ? 'AND column_value=$4' : '';
      const params = status
        ? [req.accountId, limit, offset, status]
        : [req.accountId, limit, offset];
      const [rows, count] = await Promise.all([
        pool.query(
          `SELECT id, event_type, item_id, board_id, column_id AS template_name, column_value AS status, attempts, last_error, created_at
           FROM webhook_events WHERE account_id=$1 ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          params
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM webhook_events WHERE account_id=$1 ${where}`,
          status ? [req.accountId, status] : [req.accountId]
        ),
      ]);
      res.json({ events: rows.rows, total: count.rows[0].total });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // ─── LOGS: AUDIT LOG ───────────────────────────────────────
  router.get('/logs/audit', requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const [rows, count] = await Promise.all([
        pool.query(
          'SELECT id, action, actor_id, details, ip, created_at FROM audit_log WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
          [req.accountId, limit, offset]
        ),
        pool.query('SELECT COUNT(*)::int AS total FROM audit_log WHERE account_id=$1', [req.accountId]),
      ]);
      res.json({ entries: rows.rows, total: count.rows[0].total });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/migrate', async (req, res) => {
    // FIX-24: Timing-safe comparison to prevent timing attacks
    const adminSecret = process.env.ADMIN_MIGRATE_SECRET;
    if (!adminSecret) return res.status(403).json({ error: 'No autorizado' });
    const inputBuf = Buffer.from(req.body.secret || '');
    const secretBuf = Buffer.from(adminSecret);
    const valid = inputBuf.length === secretBuf.length &&
      crypto.timingSafeEqual(inputBuf, secretBuf);
    if (!valid) return res.status(403).json({ error: 'Forbidden' });
    try {
      await pool.query('ALTER TABLE tokens ADD COLUMN IF NOT EXISTS user_id TEXT');
      res.json({ success: true, message: 'Migracion completada' });
    } catch (err) {
      try { require('../services/logger.service').error({ err: err.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  return router;
};
