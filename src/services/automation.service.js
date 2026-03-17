'use strict';

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const { pool } = require('./db.service');
const { getMondayItem, getMondayBoard, createMondayUpdate } = require('../utils/graphql');
const { createDocxtemplater, injectGlobalSettings } = require('./template.service');
const { calcularTotales, toVarName, extractColumnValue, GRAPHQL_COLUMN_FRAGMENT } = require('../utils/docx');
const { decryptToken } = require('../utils/crypto');
const { withRetry } = require('../utils/retry');
const { logError } = require('./error-log.service');

// P2-8: from src/services/, two levels up = project root (not three)
const outputsDir = path.join(__dirname, '..', '..', 'outputs');

async function executeAutomation(accountId, itemId, boardId, templateName, accessToken) {
  try {
    const tplResult = await pool.query('SELECT data FROM templates WHERE account_id=$1 AND filename=$2', [accountId, templateName]);
    if (!tplResult.rows.length) throw new Error('Plantilla no encontrada: ' + templateName);

    // P1-3: getMondayItem usa variables GraphQL — sin inyección
    const item = await withRetry(() => getMondayItem(accessToken, itemId, GRAPHQL_COLUMN_FRAGMENT));
    if (!item) throw new Error('Item no encontrado: ' + itemId);

    const data = { nombre: item.name };
    item.column_values.forEach(col => { data[toVarName(col.column.title)] = extractColumnValue(col); });
    calcularTotales(data, item.subitems, item.column_values);

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

    // Comentar en Monday — createMondayUpdate usa variables GraphQL
    await createMondayUpdate(accessToken, itemId, `📄 Documento generado: ${outputFilename}`)
      .catch(e => console.error('Comment error:', e.message));

    return { success: true, filename: outputFilename };
  } catch(e) {
    await logError(accountId, 'automation', e.message, e.stack);
    return { success: false, error: e.message };
  }
}

// Procesar triggers pendientes del webhook
async function processPendingTriggers() {
  try {
    const pending = await pool.query(
      "SELECT * FROM webhook_events WHERE event_type='trigger_fired' AND column_value='pending' LIMIT 10"
    );
    for (const evt of pending.rows) {
      const trigger = await pool.query(
        'SELECT * FROM webhook_triggers WHERE account_id=$1 AND template_name=$2 LIMIT 1',
        [evt.account_id, evt.column_id]
      );
      if (!trigger.rows.length) continue;
      // P1-5: tabla correcta es 'tokens', no 'accounts' (accounts no tiene access_token)
      const acc = await pool.query('SELECT access_token FROM tokens WHERE account_id=$1', [evt.account_id]);
      if (!acc.rows.length) continue;
      const decryptedToken = decryptToken(acc.rows[0].access_token);

      const result = await executeAutomation(evt.account_id, evt.item_id, evt.board_id, evt.column_id, decryptedToken);
      await pool.query("UPDATE webhook_events SET column_value=$1 WHERE id=$2", [result.success ? 'done' : 'error:' + result.error, evt.id]);
      console.info('Trigger procesado:', evt.item_id, result.success ? 'ok' : 'error');
    }
  } catch(e) { console.error('processPendingTriggers error:', e.message); }
}

// Ejecutar automatizaciones programadas (llamado por el cron de index.js cada hora)
async function runScheduledAutomations() {
  try {
    const now = new Date();
    const autos = await pool.query("SELECT * FROM scheduled_automations WHERE status='active'").catch(() => ({ rows: [] }));
    for (const auto of autos.rows) {
      // Verificar si toca ejecutar según cron_expression
      // daily = cada día, weekly = cada lunes, monthly = primer día del mes
      let shouldRun = false;
      if (auto.cron_expression === 'daily') shouldRun = now.getHours() === 8;
      else if (auto.cron_expression === 'weekly') shouldRun = now.getDay() === 1 && now.getHours() === 8;
      else if (auto.cron_expression === 'monthly') shouldRun = now.getDate() === 1 && now.getHours() === 8;

      if (!shouldRun) continue;

      // P1-5: tabla correcta es 'tokens', no 'accounts'
      const acc = await pool.query('SELECT access_token FROM tokens WHERE account_id=$1', [auto.account_id]);
      if (!acc.rows.length) continue;
      const autoToken = decryptToken(acc.rows[0].access_token);

      // P1-3: getMondayBoard usa variables GraphQL, no concatenación
      const board = await getMondayBoard(autoToken, auto.board_id, 100, 'id text').catch(() => null);
      if (!board) continue;
      const items = board.items_page?.items || [];

      for (const item of items) {
        // Aplicar condición si existe
        if (auto.condition_column && auto.condition_value) {
          const col = item.column_values.find(c => c.id === auto.condition_column);
          if (!col || col.text !== auto.condition_value) continue;
        }
        await executeAutomation(auto.account_id, item.id, auto.board_id, auto.template_name, autoToken);
        await new Promise(r => setTimeout(r, 500));
      }

      await pool.query('UPDATE scheduled_automations SET last_run=$1 WHERE id=$2', [now, auto.id]);
    }
  } catch(e) { console.error('Scheduled automation error:', e.message); }
}

module.exports = { executeAutomation, processPendingTriggers, runScheduledAutomations };
