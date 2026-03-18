'use strict';

const { MAX_AUTOMATION_ATTEMPTS, AUTOMATION_CONCURRENCY } = require('../utils/config');
const fs     = require('fs');
const path   = require('path');
const PizZip = require('pizzip');
const logger = require('./logger.service');
const { pool }                                  = require('./db.service');
const { getMondayItem, getMondayBoard, createMondayUpdate } = require('../utils/graphql');
const { createDocxtemplater, injectGlobalSettings }        = require('./template.service');
const { calcularTotales, toVarName, extractColumnValue, GRAPHQL_COLUMN_FRAGMENT } = require('../utils/docx');
const { decryptToken }   = require('../utils/crypto');
const { getToken }       = require('./auth.service');
const { refreshMondayToken, isTokenExpiredOrExpiringSoon } = require('./token-refresh.service');
const { withRetry }      = require('../utils/retry');
const { logError }       = require('./error-log.service');

const outputsDir = path.join(__dirname, '..', '..', 'outputs');

async function executeAutomation(accountId, itemId, boardId, templateName, accessToken) {
  try {
    const tplResult = await pool.query(
      'SELECT data FROM templates WHERE account_id=$1 AND filename=$2',
      [accountId, templateName]
    );
    if (!tplResult.rows.length) throw new Error('Plantilla no encontrada: ' + templateName);

    const item = await withRetry(() => getMondayItem(accessToken, itemId, GRAPHQL_COLUMN_FRAGMENT));
    if (!item) throw new Error('Item no encontrado: ' + itemId);

    // Per-account IVA rate (configurable, default 16%)
    let ivaRate = 0.16;
    try {
      const settingsRow = await pool.query(
        'SELECT iva_rate FROM account_settings WHERE account_id=$1', [accountId]
      );
      if (settingsRow.rows.length && settingsRow.rows[0].iva_rate != null) {
        ivaRate = parseFloat(settingsRow.rows[0].iva_rate);
      }
    } catch { /* use default */ }

    const data = { nombre: item.name };
    item.column_values.forEach(col => { data[toVarName(col.column.title)] = extractColumnValue(col); });
    calcularTotales(data, item.subitems, item.column_values, ivaRate);

    const zip = new PizZip(tplResult.rows[0].data);
    const doc = await createDocxtemplater(zip, accountId);
    await injectGlobalSettings(data, accountId);
    doc.render(data);
    const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
    const outputFilename = item.name.replace(/[^a-zA-Z0-9]/g, '_') + '_auto_' + Date.now() + '.docx';
    if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });
    fs.writeFileSync(path.join(outputsDir, outputFilename), outputBuffer);

    await pool.query(
      'INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename, doc_data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [accountId, String(boardId), String(itemId), item.name, templateName, outputFilename, outputBuffer]
    );

    await createMondayUpdate(accessToken, itemId, `📄 Documento generado: ${outputFilename}`)
      .catch(e => logger.warn({ err: e.message, itemId }, 'Could not post Monday comment'));

    return { success: true, filename: outputFilename };
  } catch (e) {
    await logError(accountId, 'automation', e.message, e.stack);
    return { success: false, error: e.message };
  }
}

// ── PROCESS PENDING TRIGGERS ──
// Fixed: max 3 attempts, concurrent processing, structured logging
const MAX_ATTEMPTS = MAX_AUTOMATION_ATTEMPTS;

async function processPendingTriggers() {
  try {
    const pending = await pool.query(
      "SELECT * FROM webhook_events WHERE event_type='trigger_fired' AND column_value='pending' AND attempts < $1 LIMIT 10",
      [MAX_ATTEMPTS]
    );
    if (!pending.rows.length) return;

    await Promise.allSettled(pending.rows.map(evt => _processOneTrigger(evt)));
  } catch (e) {
    logger.error({ err: e.message }, 'processPendingTriggers query error');
  }
}

async function _processOneTrigger(evt) {
  // Increment attempts first so a crash still counts
  await pool.query('UPDATE webhook_events SET attempts = attempts + 1 WHERE id=$1', [evt.id]);

  const trigger = await pool.query(
    'SELECT * FROM webhook_triggers WHERE account_id=$1 AND template_name=$2 LIMIT 1',
    [evt.account_id, evt.column_id]
  );
  if (!trigger.rows.length) {
    await pool.query("UPDATE webhook_events SET column_value='error:no_trigger', last_error='No matching trigger' WHERE id=$1", [evt.id]);
    return;
  }

  const tokenData = await getToken(evt.account_id);
  if (!tokenData) {
    await pool.query("UPDATE webhook_events SET column_value='error:no_token', last_error='No token for account' WHERE id=$1", [evt.id]);
    return;
  }

  // Proactive token refresh — prevents automation failures on expired tokens
  let accessToken = tokenData.accessToken;
  if (isTokenExpiredOrExpiringSoon(tokenData.expiresAt) && tokenData.refreshToken) {
    try {
      accessToken = await refreshMondayToken(evt.account_id, tokenData.refreshToken);
    } catch (e) {
      logger.warn({ accountId: evt.account_id, err: e.message }, 'Token refresh failed in automation — using existing token');
    }
  }

  const result = await executeAutomation(evt.account_id, evt.item_id, evt.board_id, evt.column_id, accessToken);

  if (result.success) {
    await pool.query("UPDATE webhook_events SET column_value='done' WHERE id=$1", [evt.id]);
    logger.info({ itemId: evt.item_id, accountId: evt.account_id }, 'Trigger processed successfully');
  } else {
    const isFinal = (evt.attempts + 1) >= MAX_ATTEMPTS;
    await pool.query(
      "UPDATE webhook_events SET column_value=$1, last_error=$2 WHERE id=$3",
      [isFinal ? 'failed' : 'pending', result.error, evt.id]
    );
    if (isFinal) {
      logger.warn({ itemId: evt.item_id, accountId: evt.account_id, error: result.error }, 'Trigger permanently failed after max attempts');
    }
  }
}

// ── RUN SCHEDULED AUTOMATIONS ──
// Fixed: concurrent batches (max 5), no 500ms sleep
const CONCURRENCY = AUTOMATION_CONCURRENCY;

async function runScheduledAutomations() {
  try {
    const now   = new Date();
    const autos = await pool.query("SELECT * FROM scheduled_automations WHERE status='active'")
      .catch(() => ({ rows: [] }));

    for (const auto of autos.rows) {
      let shouldRun = false;
      if      (auto.cron_expression === 'daily')   shouldRun = now.getHours() === 8;
      else if (auto.cron_expression === 'weekly')  shouldRun = now.getDay() === 1 && now.getHours() === 8;
      else if (auto.cron_expression === 'monthly') shouldRun = now.getDate() === 1 && now.getHours() === 8;
      if (!shouldRun) continue;

      const tokenData = await getToken(auto.account_id);
      if (!tokenData) continue;
      let autoToken = tokenData.accessToken;
      if (isTokenExpiredOrExpiringSoon(tokenData.expiresAt) && tokenData.refreshToken) {
        try { autoToken = await refreshMondayToken(auto.account_id, tokenData.refreshToken); }
        catch (e) { logger.warn({ accountId: auto.account_id, err: e.message }, 'Token refresh failed in scheduled automation'); }
      }

      const board = await getMondayBoard(autoToken, auto.board_id, 100, 'id text column_values { id text }').catch(() => null);
      if (!board) continue;
      let items = board.items_page?.items || [];

      if (auto.condition_column && auto.condition_value) {
        items = items.filter(item => {
          const col = item.column_values?.find(c => c.id === auto.condition_column);
          return col && col.text === auto.condition_value;
        });
      }

      // Process in concurrent batches — no sleep
      for (let i = 0; i < items.length; i += CONCURRENCY) {
        const batch = items.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
          batch.map(item =>
            executeAutomation(auto.account_id, item.id, auto.board_id, auto.template_name, autoToken)
          )
        );
      }

      await pool.query('UPDATE scheduled_automations SET last_run=$1 WHERE id=$2', [now, auto.id]);
      logger.info({ autoId: auto.id, accountId: auto.account_id, processed: items.length }, 'Scheduled automation complete');
    }
  } catch (e) {
    logger.error({ err: e.message }, 'runScheduledAutomations error');
  }
}

module.exports = { executeAutomation, processPendingTriggers, runScheduledAutomations };
