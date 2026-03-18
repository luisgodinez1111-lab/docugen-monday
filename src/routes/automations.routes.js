'use strict';
const crypto     = require('crypto');
const { Router } = require('express');
const { makeError } = require('../utils/error-codes');

let enqueueBulkItem = null;
try { enqueueBulkItem = require('../queues/bulk.queue').enqueueBulkItem; } catch {}

module.exports = function makeAutomationsRouter(deps) {
  const {
    pool, requireAuth, logger, parsePagination,
    withTransaction, verifyMondayHmac,
    executeAutomation, processPendingTriggers,
    incrementDocsUsed, checkSubscription, checkDocLimit, docGenRateLimit,
    Sentry,
  } = deps;
  const router = Router();

  // ─── WEBHOOKS DE MONDAY ───────────────────────────────────
  // P1-2: HMAC verificado con allowChallenge=true para el handshake inicial
  router.post('/webhooks/monday', verifyMondayHmac({ allowChallenge: true }), async (req, res) => {
    if (req.body.challenge) return res.json({ challenge: req.body.challenge });

    const event = req.body.event;
    if (!event) return res.sendStatus(200);

    // #9 DEDUPLICATION: build a stable event_id
    const eventId = event.id != null
      ? String(event.id)
      : [event.type, event.itemId, event.boardId, event.columnId, event.timestamp]
          .filter(Boolean).join(':') || null;

    logger.info({ eventType: event.type, itemId: event.itemId, eventId }, 'Monday webhook received');

    try {
      // #2 TRANSACTION: insert event + trigger_fired atomically
      await withTransaction(pool, async (client) => {
        const insertResult = await client.query(
          `INSERT INTO webhook_events (event_id, event_type, item_id, board_id, column_id, column_value)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [eventId, event.type, event.itemId, event.boardId, event.columnId, JSON.stringify(event.value)]
        );

        if (insertResult.rows.length === 0) {
          logger.info({ eventId }, 'Duplicate webhook event — skipped');
          return; // duplicate — no further processing
        }

        // FIX-12: Invalidate board cache when board structure changes are detected
        if (event.boardId && (event.type === 'create_column' || event.type === 'delete_column' || event.type === 'update_column')) {
          try { const { invalidateBoardCache } = require('../utils/graphql'); await invalidateBoardCache(event.boardId); } catch {}
        }

        // Trigger: si columna de status cambia a valor configurado, auto-generar doc
        if (event.type === 'change_column_value') {
          const triggers = await client.query(
            'SELECT * FROM webhook_triggers WHERE board_id=$1 AND column_id=$2 AND trigger_value=$3',
            [String(event.boardId), event.columnId, event.value?.label?.text || event.value]
          );
          for (const trigger of triggers.rows) {
            logger.info({ action: trigger.action, itemId: event.itemId }, 'Webhook trigger fired');
            await client.query(
              'INSERT INTO webhook_events (event_type, item_id, board_id, column_id, column_value, account_id) VALUES ($1,$2,$3,$4,$5,$6)',
              ['trigger_fired', String(event.itemId), String(event.boardId), trigger.template_name, 'pending', trigger.account_id]
            );
          }
        }
      });
    } catch(e) {
      logger.error({ err: e.message }, 'Webhook error');
      Sentry.captureException(e, { tags: { endpoint: 'webhook-monday' } });
    }

    res.sendStatus(200);
  });

  // Configurar triggers de webhooks
  // FIX-25: CREATE TABLE removed — webhook_triggers table created in initDB()
  router.post('/webhooks/triggers', requireAuth, async (req, res) => {
    const { board_id, column_id, trigger_value, template_name, action } = req.body;
    try {
      await pool.query(
        'INSERT INTO webhook_triggers (account_id, board_id, column_id, trigger_value, template_name, action) VALUES ($1,$2,$3,$4,$5,$6)',
        [req.accountId, board_id, column_id, trigger_value, template_name, action || 'generate_doc']
      );
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/webhooks/triggers', requireAuth, async (req, res) => {
    try {
      // #7 Pagination
      const { limit, page, offset } = parsePagination(req.query);
      const [countRes, r] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM webhook_triggers WHERE account_id=$1', [req.accountId]),
        pool.query('SELECT * FROM webhook_triggers WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [req.accountId, limit, offset]),
      ]);
      const total = parseInt(countRes.rows[0].count, 10);
      res.json({ triggers: r.rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/webhooks/triggers/:id', requireAuth, async (req, res) => {
    try {
      await pool.query('DELETE FROM webhook_triggers WHERE id=$1 AND account_id=$2', [req.params.id, req.accountId]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // FIX 19 — Paginated webhook events list
  router.get('/webhooks/events', requireAuth, async (req, res) => {
    try {
      const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
      const page   = Math.max(parseInt(req.query.page) || 1, 1);
      const offset = (page - 1) * limit;
      const [countRes, r] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM webhook_events WHERE account_id=$1', [req.accountId]),
        pool.query(
          'SELECT id, event_type, item_id, board_id, column_id, column_value, attempts, last_error, next_retry_at, created_at FROM webhook_events WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
          [req.accountId, limit, offset]
        ),
      ]);
      const total = parseInt(countRes.rows[0].count, 10);
      res.json({ items: r.rows, total, page, limit, pages: Math.ceil(total / limit) });
    } catch(e) {
      try { require('../services/logger.service').error({ err: e.message }, 'webhooks events error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // ─── GENERACIÓN MASIVA ────────────────────────────────────
  router.post('/generate-bulk', requireAuth, checkDocLimit, docGenRateLimit, async (req, res) => {
    // P0-5: Use req.accountId from auth — never trust req.body/query account_id (prevents billing bypass)
    const _accountId = req.accountId;
    const _subCheck = await checkSubscription(_accountId);
    if (!_subCheck.allowed) {
      const msg = _subCheck.reason === "trial_expired"
        ? "Tu periodo de prueba ha expirado. Actualiza tu plan."
        : _subCheck.reason === "docs_limit_reached"
          ? "Limite de documentos alcanzado (" + _subCheck.docs_used + "/" + _subCheck.docs_limit + "). Actualiza tu plan."
          : "Suscripcion inactiva. Actualiza tu plan.";
      return res.status(402).json({ error: msg, reason: _subCheck.reason, plan: _subCheck.plan });
    }

    const { board_id, item_ids, template_name } = req.body;
    if (!item_ids || !item_ids.length || !template_name) return res.status(400).json(makeError('VALIDATION_ERROR', 'Faltan parámetros: item_ids, template_name'));
    if (item_ids.length > 100) return res.status(400).json(makeError('VALIDATION_ERROR', 'Máximo 100 items a la vez'));

    // ── Async path: BullMQ queue (returns immediately with job ID) ──
    if (typeof enqueueBulkItem === 'function') {
      const bulkJobId = crypto.randomBytes(8).toString('hex');
      await pool.query(
        'INSERT INTO bulk_jobs (id, account_id, total) VALUES ($1,$2,$3)',
        [bulkJobId, req.accountId, item_ids.length]
      );
      await Promise.all(
        item_ids.map(itemId =>
          enqueueBulkItem({
            bulkJobId, accountId: req.accountId, itemId,
            boardId: board_id, templateName: template_name,
            accessToken: req.accessToken,
          })
        )
      );
      return res.json({ success: true, async: true, bulk_job_id: bulkJobId, total: item_ids.length, status: 'processing' });
    }

    // ── Sync fallback: concurrent batches, no sleep ──
    const CONCURRENCY = 5;
    const allResults = [];
    for (let i = 0; i < item_ids.length; i += CONCURRENCY) {
      const batch = item_ids.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(itemId => executeAutomation(req.accountId, itemId, board_id, template_name, req.accessToken)
          .then(r => ({ item_id: itemId, ...r })))
      );
      settled.forEach((s, j) => {
        allResults.push(s.status === 'fulfilled' ? s.value : { item_id: batch[j], success: false, error: s.reason?.message });
      });
    }
    const generated = allResults.filter(r => r.success).length;
    res.json({ success: true, async: false, total: item_ids.length, generated, failed: item_ids.length - generated, results: allResults });
  });

  // ─── BULK JOB STATUS ──────────────────────────────────────
  router.get('/bulk-status/:bulkJobId', requireAuth, async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT id, total, completed, failed, status, results, created_at, updated_at FROM bulk_jobs WHERE id=$1 AND account_id=$2',
        [req.params.bulkJobId, req.accountId]
      );
      if (!r.rows.length) return res.status(404).json(makeError('ITEM_NOT_FOUND', 'Bulk job not found'));
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json(makeError('INTERNAL_ERROR', e.message)); }
  });

  // ─── AUTOMATIZACIONES PROGRAMADAS ─────────────────────────
  // FIX-25: CREATE TABLE removed — scheduled_automations table created in initDB()
  router.post('/scheduled-automations', requireAuth, async (req, res) => {
    const { name, cron_expression, board_id, template_name, condition_column, condition_value } = req.body;
    if (!cron_expression || !board_id || !template_name) return res.status(400).json({ error: 'Faltan parámetros' });
    try {
      await pool.query(
        'INSERT INTO scheduled_automations (account_id, name, cron_expression, board_id, template_name, condition_column, condition_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [req.accountId, name, cron_expression, board_id, template_name, condition_column, condition_value]
      );
      // P1-1: removed incrementDocsUsed — billing only happens when docs are generated, not when automations are created
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/scheduled-automations', requireAuth, async (req, res) => {
    try {
      // #7 Pagination
      const { limit, page, offset } = parsePagination(req.query);
      const [countRes, r] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM scheduled_automations WHERE account_id=$1', [req.accountId]),
        pool.query('SELECT * FROM scheduled_automations WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [req.accountId, limit, offset]),
      ]);
      const total = parseInt(countRes.rows[0].count, 10);
      res.json({ automations: r.rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/scheduled-automations/:id', requireAuth, async (req, res) => {
    try {
      await pool.query('DELETE FROM scheduled_automations WHERE id=$1 AND account_id=$2', [req.params.id, req.accountId]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── ESCRITURA DE COLUMNAS ────────────────────────────────
  async function updateMondayColumn(accessToken, itemId, boardId, columnId, value) {
    const { mondayQuery } = require('../utils/graphql');
    // P1-3: variables GraphQL — itemId y boardId como variables, no interpolados
    const query = `
      mutation UpdateColumn($itemId: ID!, $boardId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(item_id: $itemId, board_id: $boardId, column_id: $columnId, value: $value) { id }
      }
    `;
    return mondayQuery(accessToken, query, {
      itemId: String(parseInt(itemId, 10)),
      boardId: String(parseInt(boardId, 10)),
      columnId: String(columnId),
      value: JSON.stringify(value),
    });
  }

  async function updateMondayStatus(accessToken, itemId, boardId, columnId, label) {
    const { mondayQuery } = require('../utils/graphql');
    // P1-3: variables GraphQL
    const query = `
      mutation UpdateStatus($itemId: ID!, $boardId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(item_id: $itemId, board_id: $boardId, column_id: $columnId, value: $value) { id }
      }
    `;
    return mondayQuery(accessToken, query, {
      itemId: String(parseInt(itemId, 10)),
      boardId: String(parseInt(boardId, 10)),
      columnId: String(columnId),
      value: String(label),
    });
  }

  // Endpoint para escribir columna desde la UI
  router.post('/monday/update-column', requireAuth, async (req, res) => {
    const { item_id, board_id, column_id, value, type } = req.body;
    if (!item_id || !board_id || !column_id) return res.status(400).json({ error: 'Faltan parámetros' });
    try {
      let r;
      if (type === 'status') {
        r = await updateMondayStatus(req.accessToken, item_id, board_id, column_id, value);
      } else {
        r = await updateMondayColumn(req.accessToken, item_id, board_id, column_id, value);
      }
      res.json({ success: true, data: r.data });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
