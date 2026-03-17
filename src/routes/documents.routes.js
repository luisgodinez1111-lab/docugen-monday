'use strict';
const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const PizZip = require('pizzip');
const storageService = require('../services/storage.service');

module.exports = function makeDocumentsRouter(deps) {
  const {
    pool, requireAuth, logger, parsePagination,
    getMondayItem, GRAPHQL_COLUMN_FRAGMENT, toVarName, extractColumnValue,
    calcularTotales, injectGlobalSettings, createDocxtemplater, convertDocxToPdf,
    checkSubscription, incrementDocsUsed, checkDocLimit, docGenRateLimit,
    logError, outputsDir,
  } = deps;
  const router = Router();

  router.post('/generate-from-monday', requireAuth, checkDocLimit, docGenRateLimit, async (req, res) => {
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
      await injectGlobalSettings(data, req.accountId);

      logger.debug('Variables para plantilla:', JSON.stringify(data, null, 2));

      const zip = new PizZip(tplResult.rows[0].data);
      const doc = await createDocxtemplater(zip, req.accountId);
      await injectGlobalSettings(data, req.accountId);
      doc.render(data);

      const outputBuffer = doc.getZip().generate({ type: 'nodebuffer' });
      const outputFilename = item.name.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now() + '.docx';
      const storageKey = 'outputs/' + outputFilename;
      await storageService.uploadFile(storageKey, outputBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      await pool.query('INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename, doc_data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [req.accountId, board_id, item_id, item.name, template_name, outputFilename, outputBuffer]);

          if (_accountId) await incrementDocsUsed(_accountId); // billing
      res.json({ success: true, filename: outputFilename, data_used: data, download_url: '/download/' + outputFilename });
    } catch (error) {
      logger.error('Error:', error);
      res.status(500).json({ error: 'Error al generar', details: error.message });
    }
  });

  router.get('/documents', requireAuth, async (req, res) => {
    try {
      const { page, limit, offset } = parsePagination(req.query);
      const [result, countResult] = await Promise.all([
        pool.query(
          'SELECT id, item_name, template_name, filename, created_at FROM documents WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
          [req.accountId, limit, offset]
        ),
        pool.query('SELECT COUNT(*)::int AS total FROM documents WHERE account_id = $1', [req.accountId]),
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

  // Generar documento desde monday en formato PDF o DOCX
  router.post('/generate-from-monday-pdf', requireAuth, checkDocLimit, docGenRateLimit, async (req, res) => {
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

      await pool.query(
        'INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename, doc_data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [req.accountId, board_id, item_id, item.name, template_name, baseName + '.pdf', pdfData]
      );
      if (_accountId) await incrementDocsUsed(_accountId);

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${baseName}.pdf"`,
        'Content-Length': pdfData.length,
      });
      res.send(pdfData);
    } catch (error) {
      logger.error({ err: error.message, accountId: req.accountId }, 'Error generating PDF');
      res.status(500).json({ error: 'Error al generar PDF', details: error.message });
    }
  });

  // Jobs PDF en PostgreSQL
  logger.debug('PDF async endpoint registered');

  router.post('/generate-pdf-async', requireAuth, checkDocLimit, docGenRateLimit, async (req, res) => {
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

    const { board_id, item_id, template_name } = req.body;
    const jobId = Date.now().toString();
    const accountId = req.accountId;
    const accessToken = req.accessToken;

    logger.info({ jobId, accountId, itemId: item_id }, 'PDF async job started');

    try {
      await pool.query('INSERT INTO pdf_jobs (job_id, account_id, status) VALUES ($1,$2,$3)', [jobId, accountId, 'processing']);
      res.json({ job_id: jobId, status: 'processing' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
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

        await pool.query('UPDATE pdf_jobs SET status=$1, filename=$2, item_name=$3, pdf_data=$4 WHERE job_id=$5', ['ready', baseName + '.pdf', item.name, pdfData, jobId]);
        if (accountId) await incrementDocsUsed(accountId);
        await pool.query('INSERT INTO documents (account_id, board_id, item_id, item_name, template_name, filename, doc_data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [accountId, board_id, item_id, item.name, template_name, baseName + '.pdf', pdfData]);
        logger.info({ jobId, accountId, filename: baseName + '.pdf' }, 'PDF async job complete');

      } catch(err) {
        logger.error({ jobId, err: err.message }, 'PDF async job failed');
        await pool.query('UPDATE pdf_jobs SET status=$1, error=$2 WHERE job_id=$3', ['error', err.message, jobId]).catch(()=>{});
      }
    });
  });

  router.get('/pdf-status/:jobId', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM pdf_jobs WHERE job_id = $1', [req.params.jobId]);
      if (!result.rows.length) return res.status(404).json({ error: 'Job no encontrado' });
      res.json(result.rows[0]);
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/download-pdf/:filename', async (req, res) => {
    // P1-8: sanitize filename to prevent path traversal
    const raw = req.params.filename;
    const filename = path.basename(raw);
    if (!filename || filename !== raw || filename.includes('..')) {
      return res.status(400).json({ error: 'Nombre de archivo inválido' });
    }
    const accountId = req.headers['x-account-id'] || req.query.account_id;
    if (!accountId) return res.status(400).json({ error: 'Se requiere account_id' });
    try {
      const result = await pool.query('SELECT pdf_data FROM pdf_jobs WHERE filename=$1 AND account_id=$2', [filename, accountId]);
      if (result.rows.length && result.rows[0].pdf_data) {
        res.setHeader('Content-Disposition', 'attachment; filename="' + filename.replace(/"/g, '\\"') + '"');
        res.setHeader('Content-Type', 'application/pdf');
        return res.send(result.rows[0].pdf_data);
      }
      // Try S3 presigned URL
      const storageKey = 'outputs/' + filename;
      const presignedUrl = await storageService.getDownloadUrl(storageKey);
      if (presignedUrl) return res.redirect(presignedUrl);
      // Fallback filesystem — only serve from outputsDir
      const pdfPath = path.resolve(outputsDir, filename);
      if (!pdfPath.startsWith(path.resolve(outputsDir))) return res.status(400).json({ error: 'Ruta inválida' });
      if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'PDF no encontrado' });
      res.download(pdfPath, filename);
    } catch(err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/download/:filename', async (req, res) => {
    // P1-8: sanitize to prevent path traversal
    const raw = req.params.filename;
    const filename = path.basename(raw);
    if (!filename || filename !== raw || filename.includes('..')) {
      return res.status(400).json({ error: 'Nombre de archivo inválido' });
    }
    try {
      const storageKey = 'outputs/' + filename;
      const presignedUrl = await storageService.getDownloadUrl(storageKey);
      if (presignedUrl) return res.redirect(presignedUrl);
      // Local disk fallback
      const filePath = path.resolve(outputsDir, filename);
      if (!filePath.startsWith(path.resolve(outputsDir))) return res.status(400).json({ error: 'Ruta inválida' });
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });
      res.download(filePath, filename);
    } catch(err) { res.status(500).json({ error: err.message }); }
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
      res.status(500).json({ error: e.message });
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
      logger.error('GraphQL error:', error.message);
      res.status(500).json({ error: 'Error GraphQL', message: error.message });
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
      res.status(500).json({ error: 'Error al obtener variables', details: error.message });
    }
  });

  return router;
};
