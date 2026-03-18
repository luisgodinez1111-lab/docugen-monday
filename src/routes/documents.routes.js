'use strict';
const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const PizZip = require('pizzip');
const storageService = require('../services/storage.service');
const { logDocumentEvent } = require('../services/audit.service');

module.exports = function makeDocumentsRouter(deps) {
  const {
    pool, requireAuth, logger, parsePagination,
    getMondayItem, mondayQuery, GRAPHQL_COLUMN_FRAGMENT, toVarName, extractColumnValue,
    calcularTotales, injectGlobalSettings, createDocxtemplater, convertDocxToPdf,
    checkSubscription, incrementDocsUsed, checkDocLimit, docGenRateLimit,
    logError, outputsDir,
  } = deps;
  const router = Router();

  router.post('/generate-from-monday', requireAuth, checkDocLimit, docGenRateLimit, async (req, res) => {
    // FIX-14: Use req.accountId from auth — not req.body.account_id (prevents billing bypass)
    const _accountId = req.accountId;
    const _subCheck = await checkSubscription(_accountId);
    if (!_subCheck.allowed) {
      const _code = _subCheck.reason === 'trial_expired' ? 'TRIAL_EXPIRED'
        : _subCheck.reason === 'docs_limit_reached' ? 'LIMIT_REACHED'
        : 'SUBSCRIPTION_INACTIVE';
      return res.status(402).json({
        error: _subCheck.reason === 'trial_expired' ? 'Tu período de prueba ha expirado'
          : _subCheck.reason === 'docs_limit_reached' ? 'Has alcanzado el límite de documentos de tu plan'
          : 'Suscripción inactiva',
        error_code: _code,
        plan: _subCheck.plan
      });
    }

    const { board_id, item_id, template_name } = req.body;
    try {
      const tplResult = await pool.query('SELECT data FROM templates WHERE account_id = $1 AND filename = $2', [req.accountId, template_name]);
      if (!tplResult.rows.length) return res.status(404).json({ error: 'Plantilla "' + template_name + '" no encontrada' });

      // P1-3 + P1-4: variables GraphQL + null-check
      const item = await getMondayItem(req.accessToken, item_id, GRAPHQL_COLUMN_FRAGMENT);
      if (!item) return res.status(404).json({ error: 'Item no encontrado en Monday.com' });

      const data = { nombre: item.name };
      item.column_values.forEach(col => {
        data[toVarName(col.column.title)] = extractColumnValue(col);
      });

      calcularTotales(data, item.subitems, item.column_values);
      // FIX-32: Remove duplicate injectGlobalSettings call — only call once before render
      await injectGlobalSettings(data, req.accountId);

      logger.debug('Variables para plantilla:', JSON.stringify(data, null, 2));

      const zip = new PizZip(tplResult.rows[0].data);
      const doc = await createDocxtemplater(zip, req.accountId);
      doc.render(data);

      const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
      const outputFilename = item.name.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now() + '.docx';
      const storageKey = 'outputs/' + outputFilename;
      await storageService.uploadFile(storageKey, outputBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      const insertResult = await pool.query('INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename, doc_data) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [req.accountId, board_id, item_id, item.name, template_name, outputFilename, outputBuffer]);
      logDocumentEvent(pool, { documentId: insertResult.rows[0].id, eventType: 'created', actorId: req.accountId }).catch(err => { try { require('../services/logger.service').warn({ err: err.message }, 'audit/email fire-and-forget failed'); } catch {} });

      await incrementDocsUsed(_accountId); // billing
      // P2-9: data_used removed from response — do not expose all template variables to client
      res.json({ success: true, filename: outputFilename, download_url: '/download/' + outputFilename });
    } catch (error) {
      try { require('../services/logger.service').error({ err: error.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  router.get('/documents', requireAuth, async (req, res) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const includeDeleted = req.query.include_deleted === 'true';
      const deletedFilter = includeDeleted ? '' : 'AND deleted_at IS NULL';
      const [result, countResult] = await Promise.all([
        pool.query(
          `SELECT id, item_name, template_name, filename, created_at, deleted_at FROM documents WHERE account_id = $1 ${deletedFilter} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [req.accountId, limit, offset]
        ),
        pool.query(`SELECT COUNT(*)::int AS total FROM documents WHERE account_id = $1 ${deletedFilter}`, [req.accountId]),
      ]);
      const total = countResult.rows[0].total;
      res.json({
        documents:  result.rows,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
      });
    } catch (err) {
      res.status(500).json({ error: 'Error al obtener historial' });
    }
  });

  router.delete('/documents/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        'UPDATE documents SET deleted_at = NOW() WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL RETURNING id',
        [id, req.accountId]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Documento no encontrado' });
      logDocumentEvent(pool, { documentId: id, eventType: 'deleted', actorId: req.accountId }).catch(err => { try { require('../services/logger.service').warn({ err: err.message }, 'audit/email fire-and-forget failed'); } catch {} });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Error al eliminar documento' });
    }
  });

  // ── BATCH SOFT-DELETE ─────────────────────────────────────────────────────
  router.delete('/documents/batch', requireAuth, async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids debe ser un array no vacío' });
    if (ids.length > 100) return res.status(400).json({ error: 'Máximo 100 documentos por lote' });
    const safeIds = ids.map(id => parseInt(id, 10)).filter(n => Number.isFinite(n) && n > 0);
    if (!safeIds.length) return res.status(400).json({ error: 'IDs inválidos' });
    try {
      const result = await pool.query(
        'UPDATE documents SET deleted_at = NOW() WHERE id = ANY($1::int[]) AND account_id = $2 AND deleted_at IS NULL RETURNING id',
        [safeIds, req.accountId]
      );
      result.rows.forEach(({ id }) => {
        logDocumentEvent(pool, { documentId: id, eventType: 'deleted', actorId: req.accountId }).catch(err => { try { require('../services/logger.service').warn({ err: err.message }, 'audit/email fire-and-forget failed'); } catch {} });
      });
      res.json({ success: true, deleted: result.rows.length });
    } catch (err) {
      res.status(500).json({ error: 'Error al eliminar documentos' });
    }
  });

  router.get('/documents/:id/events', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
      const doc = await pool.query('SELECT id FROM documents WHERE id=$1 AND account_id=$2', [id, req.accountId]);
      if (!doc.rows.length) return res.status(404).json({ error: 'Documento no encontrado' });
      const events = await pool.query(
        'SELECT * FROM document_events WHERE document_id=$1 ORDER BY created_at DESC',
        [id]
      );
      res.json({ events: events.rows });
    } catch (err) {
      res.status(500).json({ error: 'Error al obtener eventos' });
    }
  });

  // Generar documento desde monday en formato PDF o DOCX
  router.post('/generate-from-monday-pdf', requireAuth, checkDocLimit, docGenRateLimit, async (req, res) => {
    // FIX-14: Use req.accountId from auth — not req.body.account_id (prevents billing bypass)
    const _accountId = req.accountId;
    const _subCheck = await checkSubscription(_accountId);
    if (!_subCheck.allowed) {
      const _code = _subCheck.reason === 'trial_expired' ? 'TRIAL_EXPIRED'
        : _subCheck.reason === 'docs_limit_reached' ? 'LIMIT_REACHED'
        : 'SUBSCRIPTION_INACTIVE';
      return res.status(402).json({
        error: _subCheck.reason === 'trial_expired' ? 'Tu período de prueba ha expirado'
          : _subCheck.reason === 'docs_limit_reached' ? 'Has alcanzado el límite de documentos de tu plan'
          : 'Suscripción inactiva',
        error_code: _code,
        plan: _subCheck.plan
      });
    }

    const { board_id, item_id, template_name } = req.body;

    try {
      const tplResult = await pool.query(
        'SELECT data FROM templates WHERE account_id = $1 AND filename = $2',
        [req.accountId, template_name]
      );
      if (!tplResult.rows.length) return res.status(404).json({ error: 'Plantilla no encontrada' });

      // P1-3 + P1-4: variables GraphQL + null-check
      const item = await getMondayItem(req.accessToken, item_id, GRAPHQL_COLUMN_FRAGMENT);
      if (!item) return res.status(404).json({ error: 'Item no encontrado en Monday.com' });

      const data = { nombre: item.name };
      item.column_values.forEach(col => { data[toVarName(col.column.title)] = extractColumnValue(col); });
      calcularTotales(data, item.subitems, item.column_values);

      const zip = new PizZip(tplResult.rows[0].data);
      const doc = await createDocxtemplater(zip, req.accountId);
      await injectGlobalSettings(data, req.accountId);
      doc.render(data);

      const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
      const baseName = item.name.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now();

      logger.info({ accountId: req.accountId, itemId: item_id, baseName }, 'Converting DOCX→PDF');
      // convertDocxToPdf: in-process, no shell, no temp file
      const pdfData = await convertDocxToPdf(outputBuffer);

      const pdfInsertResult = await pool.query(
        'INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename, doc_data) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [req.accountId, board_id, item_id, item.name, template_name, baseName + '.pdf', pdfData]
      );
      logDocumentEvent(pool, { documentId: pdfInsertResult.rows[0].id, eventType: 'created', actorId: req.accountId }).catch(err => { try { require('../services/logger.service').warn({ err: err.message }, 'audit/email fire-and-forget failed'); } catch {} });
      await incrementDocsUsed(_accountId);

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${baseName}.pdf"`,
        'Content-Length': pdfData.length,
      });
      res.send(pdfData);
    } catch (error) {
      try { require('../services/logger.service').error({ err: error.message, accountId: req.accountId }, 'Error generating PDF'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // Jobs PDF en PostgreSQL
  router.post('/generate-pdf-async', requireAuth, checkDocLimit, docGenRateLimit, async (req, res) => {
    // FIX-14: Use req.accountId from auth — not req.body.account_id (prevents billing bypass)
    const _accountId = req.accountId;
    const _subCheck = await checkSubscription(_accountId);
    if (!_subCheck.allowed) {
      const _code = _subCheck.reason === 'trial_expired' ? 'TRIAL_EXPIRED'
        : _subCheck.reason === 'docs_limit_reached' ? 'LIMIT_REACHED'
        : 'SUBSCRIPTION_INACTIVE';
      return res.status(402).json({
        error: _subCheck.reason === 'trial_expired' ? 'Tu período de prueba ha expirado'
          : _subCheck.reason === 'docs_limit_reached' ? 'Has alcanzado el límite de documentos de tu plan'
          : 'Suscripción inactiva',
        error_code: _code,
        plan: _subCheck.plan
      });
    }

    const { board_id, item_id, template_name } = req.body;
    // FIX-15: Use crypto.randomBytes for unique jobId — Date.now() is not unique under concurrency
    const jobId = require('crypto').randomBytes(8).toString('hex');
    const accountId = req.accountId;
    const accessToken = req.accessToken;

    logger.info({ jobId, accountId, itemId: item_id }, 'PDF async job started');

    try {
      await pool.query('INSERT INTO pdf_jobs (job_id, account_id, status) VALUES ($1,$2,$3)', [jobId, accountId, 'processing']);
      res.json({ job_id: jobId, status: 'processing' });
    } catch(e) {
      try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      return res.status(500).json({ error: 'Error interno del servidor' });
    }

    // Usar setImmediate para ejecutar fuera del ciclo del request
    setImmediate(async () => {
      try {
        const tplResult = await pool.query('SELECT data FROM templates WHERE account_id = $1 AND filename = $2', [accountId, template_name]);
        if (!tplResult.rows.length) {
          await pool.query('UPDATE pdf_jobs SET status=$1, error=$2 WHERE job_id=$3', ['error', 'Plantilla no encontrada', jobId]);
          return;
        }

        // P1-3: variables GraphQL — sin concatenación
        const item = await getMondayItem(accessToken, item_id, GRAPHQL_COLUMN_FRAGMENT).catch(() => null);
        if (!item) {
          await pool.query('UPDATE pdf_jobs SET status=$1, error=$2 WHERE job_id=$3', ['error', 'Item no encontrado', jobId]);
          return;
        }

        const data = { nombre: item.name };
        item.column_values.forEach(col => { data[toVarName(col.column.title)] = extractColumnValue(col); });
        calcularTotales(data, item.subitems, item.column_values);

        const zip = new PizZip(tplResult.rows[0].data);
        const doc = await createDocxtemplater(zip, accountId);
        await injectGlobalSettings(data, accountId);
        doc.render(data);

        const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
        const baseName = item.name.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now();

        logger.debug({ jobId, baseName }, 'PDF async - converting DOCX→PDF');
        const pdfData = await convertDocxToPdf(outputBuffer);

        // P2-4: Update pdf_jobs to 'ready' first, then insert document, then increment billing.
        // This ensures that if the DB write fails, billing is not incremented.
        await pool.query('UPDATE pdf_jobs SET status=$1, filename=$2, item_name=$3, pdf_data=$4 WHERE job_id=$5', ['ready', baseName + '.pdf', item.name, pdfData, jobId]);
        const asyncInsertResult = await pool.query('INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename, doc_data) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [accountId, board_id, item_id, item.name, template_name, baseName + '.pdf', pdfData]);
        if (accountId) await incrementDocsUsed(accountId);
        logDocumentEvent(pool, { documentId: asyncInsertResult.rows[0].id, eventType: 'created', actorId: accountId }).catch(err => { try { require('../services/logger.service').warn({ err: err.message }, 'audit/email fire-and-forget failed'); } catch {} });
        logger.info({ jobId, accountId, filename: baseName + '.pdf' }, 'PDF async job complete');

      } catch(err) {
        logger.error({ jobId, err: err.message }, 'PDF async job failed');
        try { const Sentry = require('@sentry/node'); if (Sentry.captureException) Sentry.captureException(err); } catch {}
        await pool.query('UPDATE pdf_jobs SET status=$1, error=$2 WHERE job_id=$3', ['error', err.message, jobId]).catch(()=>{});
      }
    });
  });

  // FIX-3: requireAuth + account scoping to prevent cross-account access
  router.get('/pdf-status/:jobId', requireAuth, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM pdf_jobs WHERE job_id = $1 AND account_id = $2', [req.params.jobId, req.accountId]);
      if (!result.rows.length) return res.status(404).json({ error: 'Job no encontrado' });
      res.json(result.rows[0]);
    } catch(err) {
      try { require('../services/logger.service').error({ err: err.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // P0-2: requireAuth added — download-pdf must be authenticated; accountId from req.accountId
  router.get('/download-pdf/:filename', requireAuth, async (req, res) => {
    // P1-8: sanitize filename to prevent path traversal
    const raw = req.params.filename;
    const filename = path.basename(raw);
    if (!filename || filename !== raw || filename.includes('..')) {
      return res.status(400).json({ error: 'Nombre de archivo inválido' });
    }
    const accountId = req.accountId;
    try {
      const result = await pool.query('SELECT pdf_data FROM pdf_jobs WHERE filename=$1 AND account_id=$2', [filename, accountId]);
      if (result.rows.length && result.rows[0].pdf_data) {
        res.setHeader('Content-Disposition', 'attachment; filename="' + filename.replace(/"/g, '\\"') + '"');
        res.setHeader('Content-Type', 'application/pdf');
        pool.query('SELECT id FROM documents WHERE filename=$1 AND account_id=$2 LIMIT 1', [filename, accountId])
          .then(dr => { if (dr.rows.length) logDocumentEvent(pool, { documentId: dr.rows[0].id, eventType: 'downloaded', actorId: accountId }).catch(err => { try { require('../services/logger.service').warn({ err: err.message }, 'audit/email fire-and-forget failed'); } catch {} }); })
          .catch(err => { try { require('../services/logger.service').warn({ err: err.message }, 'audit/email fire-and-forget failed'); } catch {} });
        return res.send(result.rows[0].pdf_data);
      }
      // Try S3 presigned URL
      const storageKey = 'outputs/' + filename;
      const presignedUrl = await storageService.getDownloadUrl(storageKey);
      if (presignedUrl) return res.redirect(presignedUrl);
      // Fallback filesystem — only serve from outputsDir (scoped to account via pdf_jobs check above)
      const pdfPath = path.resolve(outputsDir, filename);
      if (!pdfPath.startsWith(path.resolve(outputsDir))) return res.status(400).json({ error: 'Ruta inválida' });
      if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'PDF no encontrado' });
      res.download(pdfPath, filename);
    } catch(err) {
      try { require('../services/logger.service').error({ err: err.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // FIX-4: requireAuth + account scoping to prevent unauthorized file downloads
  router.get('/download/:filename', requireAuth, async (req, res) => {
    // P1-8: sanitize to prevent path traversal
    const raw = req.params.filename;
    const filename = path.basename(raw);
    if (!filename || filename !== raw || filename.includes('..')) {
      return res.status(400).json({ error: 'Nombre de archivo inválido' });
    }
    try {
      // Verify this file belongs to the authenticated account
      const docCheck = await pool.query(
        'SELECT id FROM documents WHERE filename=$1 AND account_id=$2 LIMIT 1',
        [filename, req.accountId]
      );
      if (!docCheck.rows.length) return res.status(404).json({ error: 'Archivo no encontrado' });

      const storageKey = 'outputs/' + filename;
      const presignedUrl = await storageService.getDownloadUrl(storageKey);
      if (presignedUrl) return res.redirect(presignedUrl);
      // Local disk fallback
      const filePath = path.resolve(outputsDir, filename);
      if (!filePath.startsWith(path.resolve(outputsDir))) return res.status(400).json({ error: 'Ruta inválida' });
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });
      res.download(filePath, filename);
    } catch(err) {
      try { require('../services/logger.service').error({ err: err.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // ─── EXPORTAR A XLSX ──────────────────────────────────────
  router.post('/export-xlsx', requireAuth, async (req, res) => {
    const { board_id, item_id } = req.body;
    try {
      const ExcelJS = require('exceljs');
      // P1-3 + P1-4: getMondayItem usa variables GraphQL + null-check
      const item = await getMondayItem(req.accessToken, item_id, GRAPHQL_COLUMN_FRAGMENT);
      if (!item) return res.status(404).json({ error: 'Item no encontrado en Monday.com' });
      const data = { nombre: item.name };
      item.column_values.forEach(col => { data[toVarName(col.column.title)] = extractColumnValue(col); });
      calcularTotales(data, item.subitems, item.column_values);

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'DocuGen';
      const sheet = workbook.addWorksheet('Cotizacion');

      sheet.mergeCells('A1:E1');
      sheet.getCell('A1').value = 'COTIZACION — ' + data.nombre;
      sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF2D5BE3' } };
      sheet.getCell('A1').alignment = { horizontal: 'center' };
      sheet.getRow(1).height = 30;
      sheet.addRow([]);
      sheet.addRow(['Cliente:', data.nombre, '', 'Fecha:', data.fecha_hoy || new Date().toLocaleDateString('es-MX')]);
      sheet.addRow([]);

      const headerRow = sheet.addRow(['#', 'Producto/Servicio', 'Cantidad', 'Precio Unit.', 'Subtotal']);
      headerRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D5BE3' } };
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'center' };
      });

      if (item.subitems && item.subitems.length) {
        item.subitems.forEach((sub, i) => {
          const s = { nombre: sub.name };
          sub.column_values.forEach(col => { s[toVarName(col.column.title)] = extractColumnValue(col); });
          const row = sheet.addRow([i+1, s.nombre, s.cantidad || 1, parseFloat(s.precio || 0), parseFloat(s.subtotal_linea || 0)]);
          row.getCell(4).numFmt = '"$"#,##0.00';
          row.getCell(5).numFmt = '"$"#,##0.00';
          if (i % 2 === 0) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } }; });
        });
      }

      sheet.addRow([]);
      [['Subtotal:', data.subtotal_fmt||''], ['IVA (16%):', data.iva_fmt||''], ['TOTAL:', data.total_fmt||'']].forEach(([k,v], i) => {
        const row = sheet.addRow(['','','',k,v]);
        row.getCell(4).font = { bold: true, color: i===2 ? { argb: 'FF2D5BE3' } : undefined };
        row.getCell(5).font = { bold: true, color: i===2 ? { argb: 'FF2D5BE3' } : undefined };
      });

      sheet.columns = [{ width: 5 },{ width: 35 },{ width: 12 },{ width: 14 },{ width: 14 }];

      const buffer = await workbook.xlsx.writeBuffer();
      const name = (item.name||'cotizacion').replace(/[^a-zA-Z0-9]/g,'_') + '.xlsx';
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', 'attachment; filename="' + name + '"');
      res.send(buffer);
    } catch(e) {
      await logError(req.accountId, 'xlsx-export', e.message, e.stack);
      try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // Board items and variables routes (helper routes for UI)
  router.post('/board-items', requireAuth, async (req, res) => {
    const { board_id } = req.body;
    try {
      const { getMondayBoard } = require('../utils/graphql');
      // P1-3: usa getMondayBoard — variables GraphQL, sin concatenación
      const board = await getMondayBoard(req.accessToken, board_id, 50, GRAPHQL_COLUMN_FRAGMENT);
      if (!board) return res.status(404).json({ error: 'Board no encontrado' });
      res.json({ data: { boards: [board] } });
    } catch (error) {
      try { require('../services/logger.service').error({ err: error.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  router.post('/item-variables', requireAuth, async (req, res) => {
    const { item_id } = req.body;
    try {
      // P1-3: getMondayItem usa variables GraphQL — sin inyección posible
      const item = await getMondayItem(req.accessToken, item_id, GRAPHQL_COLUMN_FRAGMENT);
      // P1-4: null-check antes de acceder a propiedades
      if (!item) return res.status(404).json({ error: 'Item no encontrado en Monday.com' });
      const variables = [{ variable: 'nombre', value: item.name, type: 'name' }];
      item.column_values.forEach(col => {
        variables.push({ variable: toVarName(col.column.title), original_title: col.column.title, value: extractColumnValue(col) || '(vacio)', type: col.column.type });
      });
      if (item.subitems?.length) {
        variables.push({ variable: 'subelementos', value: 'Lista de ' + item.subitems.length + ' subelementos', type: 'subitems', note: 'Usar {{#subelementos}}...{{/subelementos}}' });
        variables.push({ variable: 'subtotal', value: 'Calculado automaticamente', type: 'formula' });
        variables.push({ variable: 'iva', value: 'Calculado automaticamente (16%)', type: 'formula' });
        variables.push({ variable: 'total', value: 'Calculado automaticamente', type: 'formula' });
        variables.push({ variable: 'total_letras', value: 'Total en letras', type: 'formula' });
      }
      const montoCol = item.column_values.find(col => { const k = toVarName(col.column.title); return col.column.type === 'numbers' && (k.includes('monto') || k.includes('total') || k.includes('precio')); });
      if (montoCol && !item.subitems?.length) {
        variables.push({ variable: 'iva', value: 'Calculado automaticamente (16%)', type: 'formula' });
        variables.push({ variable: 'total_con_iva', value: 'Calculado automaticamente', type: 'formula' });
        variables.push({ variable: 'total_letras', value: 'Total en letras', type: 'formula' });
      }
      res.json({ variables, item_name: item.name });
    } catch (error) {
      try { require('../services/logger.service').error({ err: error.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // ── GET /board-columns — columnas del tablero mapeadas a variables {{...}} ──
  // Usado por el editor para mostrar las variables disponibles del tablero instalado.
  router.post('/board-columns', requireAuth, async (req, res) => {
    const boardId = req.body.board_id || req.query.board_id;
    if (!boardId) return res.status(400).json({ error: 'board_id requerido' });

    try {
      const query = `
        query GetBoardColumns($ids: [ID!]!) {
          boards(ids: $ids) {
            id
            name
            columns {
              id
              title
              type
            }
          }
        }
      `;
      const data = await mondayQuery(req.accessToken, query, { ids: [String(boardId)] });
      const board = data?.boards?.[0];
      if (!board) return res.status(404).json({ error: 'Tablero no encontrado' });

      // Exclude system/internal column types that don't carry useful text values
      const SKIP_TYPES = new Set(['subtasks', 'button', 'dependency', 'board_relation']);

      const columns = (board.columns || [])
        .filter(col => !SKIP_TYPES.has(col.type))
        .map(col => ({
          id:       col.id,
          title:    col.title,
          type:     col.type,
          variable: toVarName(col.title),   // exact name used in {{...}} at generation time
        }));

      res.json({ board_id: boardId, board_name: board.name, columns });
    } catch (e) {
      try { require('../services/logger.service').error({ err: e.message, boardId }, 'board-columns error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // ─── PDF JOBS HISTORY ─────────────────────────────────────
  router.get('/pdf-jobs', requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const r = await pool.query(
        'SELECT job_id, item_name, filename, status, error, created_at, updated_at FROM pdf_jobs WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [req.accountId, limit, offset]
      );
      const c = await pool.query('SELECT COUNT(*)::int AS total FROM pdf_jobs WHERE account_id=$1', [req.accountId]);
      res.json({ jobs: r.rows, total: c.rows[0].total });
    } catch(e) {
      try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // ─── BULK JOBS HISTORY ────────────────────────────────────
  router.get('/bulk-jobs', requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const r = await pool.query(
        'SELECT id, total, completed, failed, status, created_at, updated_at FROM bulk_jobs WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [req.accountId, limit, offset]
      );
      const c = await pool.query('SELECT COUNT(*)::int AS total FROM bulk_jobs WHERE account_id=$1', [req.accountId]);
      res.json({ jobs: r.rows, total: c.rows[0].total });
    } catch(e) {
      try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // ─── ZIP EXPORT — download multiple documents as a single ZIP ──
  router.post('/export/zip', requireAuth, async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids debe ser un array no vacío' });
    if (ids.length > 50) return res.status(400).json({ error: 'Máximo 50 documentos por ZIP' });
    const safeIds = ids.map(id => parseInt(id, 10)).filter(n => Number.isFinite(n) && n > 0);
    if (!safeIds.length) return res.status(400).json({ error: 'IDs inválidos' });
    try {
      const result = await pool.query(
        'SELECT filename, doc_data, item_name FROM documents WHERE id = ANY($1::int[]) AND account_id=$2 AND deleted_at IS NULL AND doc_data IS NOT NULL',
        [safeIds, req.accountId]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'No se encontraron documentos' });
      const PizZip = require('pizzip');
      const zip = new PizZip();
      result.rows.forEach(row => {
        zip.file(row.filename, row.doc_data);
      });
      const zipBuffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
      const zipName = 'docugen_export_' + new Date().toISOString().split('T')[0] + '.zip';
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', 'attachment; filename="' + zipName + '"');
      res.send(zipBuffer);
    } catch(e) {
      try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  return router;
};
