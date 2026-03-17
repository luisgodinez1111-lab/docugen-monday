'use strict';
const { Router } = require('express');

module.exports = function makeAdminRouter(deps) {
  const { pool, requireAuth, logger, runBackup } = deps;
  const router = Router();

  // ─── HEALTH CHECK ─────────────────────────────────────────
  router.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      const uptime = process.uptime();
      const mem = process.memoryUsage();
      res.json({
        status: 'ok',
        uptime_seconds: Math.round(uptime),
        memory_mb: Math.round(mem.heapUsed / 1024 / 1024),
        db: 'connected',
        timestamp: new Date().toISOString()
      });
    } catch(e) {
      res.status(500).json({ status: 'error', db: 'disconnected', error: e.message });
    }
  });

  // ─── MÉTRICAS ─────────────────────────────────────────────
  router.get('/metrics', requireAuth, async (req, res) => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS error_logs (
        id SERIAL PRIMARY KEY, account_id TEXT, error_type TEXT, message TEXT,
        stack TEXT, created_at TIMESTAMP DEFAULT NOW()
      )`);
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
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── BACKUP AUTOMÁTICO ────────────────────────────────────
  // Endpoint para ver historial de backups
  router.get('/backups', requireAuth, async (req, res) => {
    try {
      const r = await pool.query('SELECT id, created_at, tables_backed_up, total_rows, status, error FROM backups ORDER BY created_at DESC LIMIT 10');
      res.json({ backups: r.rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Endpoint para descargar último backup
  router.get('/backups/latest', requireAuth, async (req, res) => {
    try {
      const r = await pool.query('SELECT data, created_at FROM backup_data ORDER BY created_at DESC LIMIT 1');
      if (!r.rows.length) return res.status(404).json({ error: 'Sin backups' });
      res.set('Content-Type', 'application/json');
      res.set('Content-Disposition', 'attachment; filename="docugen_backup_' + new Date().toISOString().split('T')[0] + '.json"');
      res.send(r.rows[0].data);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/migrate', async (req, res) => {
    // Secret desde env — nunca hardcodeado en el código
    const adminSecret = process.env.ADMIN_MIGRATE_SECRET;
    if (!adminSecret || req.body.secret !== adminSecret) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    try {
      await pool.query('ALTER TABLE tokens ADD COLUMN IF NOT EXISTS user_id TEXT');
      res.json({ success: true, message: 'Migracion completada' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
