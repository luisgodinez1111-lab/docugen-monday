'use strict';
const { Router } = require('express');

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

  // ─── GENERACIÓN MASIVA ────────────────────────────────────
  router.post('/generate-bulk', requireAuth, checkDocLimit, docGenRateLimit, async (req, res) => {
    // -- SUBSCRIPTION CHECK --
    const _accountId = req.body.account_id || req.query.account_id;
    if (_accountId) {
      const _subCheck = await checkSubscription(_accountId);
      if (!_subCheck.allowed) {
        const msg = _subCheck.reason === "trial_expired"
          ? "Tu periodo de prueba ha expirado. Actualiza tu plan."
          : _subCheck.reason === "docs_limit_reached"
            ? "Limite de documentos alcanzado (" + _subCheck.docs_used + "/" + _subCheck.docs_limit + "). Actualiza tu plan."
            : "Suscripcion inactiva. Actualiza tu plan.";
        return res.status(402).json({ error: msg, reason: _subCheck.reason, plan: _subCheck.plan });
      }
    }

    const { board_id, item_ids, template_name } = req.body;
    if (!item_ids || !item_ids.length || !template_name) return res.status(400).json({ error: 'Faltan parámetros' });
    if (item_ids.length > 50) return res.status(400).json({ error: 'Máximo 50 items a la vez' });

    const results = [];
    for (const itemId of item_ids) {
      const r = await executeAutomation(req.accountId, itemId, board_id, template_name, req.accessToken);
      results.push({ item_id: itemId, ...r });
      await new Promise(resolve => setTimeout(resolve, 300)); // rate limit
    }
    const success = results.filter(r => r.success).length;
    res.json({ success: true, total: item_ids.length, generated: success, failed: item_ids.length - success, results });
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
      // P1-7: _accountId no estaba definido en este scope — usar req.accountId
      if (req.accountId) await incrementDocsUsed(req.accountId);
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
