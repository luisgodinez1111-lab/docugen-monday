'use strict';
const { Router } = require('express');
const multer = require('multer');
const path = require('path');

module.exports = function makeTemplatesRouter(deps) {
  const { pool, requireAuth, logger, parsePagination } = deps;
  const router = Router();

  // P4-5 + P1-8: Límite de tamaño en uploads
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB máximo
  });

  router.post('/templates/upload', requireAuth, upload.single('template'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibio archivo' });
    // MIME validation: DOCX magic bytes = PK\x03\x04 (ZIP-based format)
    const buf = req.file.buffer;
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B || buf[2] !== 0x03 || buf[3] !== 0x04) {
      return res.status(400).json({ error: 'El archivo debe ser un .docx válido' });
    }
    const accountId = req.accountId; // from requireAuth — never trust body/query
    // P2-6: Sanitize filename to prevent path traversal and special character injection
    const safeName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._\-]/g, '_');

    // FIX 9 — extract template variables from DOCX
    let templateVars = [];
    try {
      const PizZip = require('pizzip');
      const Docxtemplater = require('docxtemplater');
      const zip = new PizZip(buf);
      const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
      const fullText = doc.getFullText();
      templateVars = [...new Set([...fullText.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1].trim()))];
    } catch (_) { templateVars = []; }

    try {
      // FIX 2 — versioning: if template already exists, preserve previous version
      const existing = await pool.query(
        'SELECT version, previous_versions, data FROM templates WHERE account_id=$1 AND filename=$2',
        [accountId, safeName]
      );
      if (existing.rows.length) {
        const old = existing.rows[0];
        const prevVersions = Array.isArray(old.previous_versions) ? old.previous_versions : [];
        prevVersions.push({
          version: old.version || 1,
          filename: safeName,
          archived_at: new Date().toISOString(),
        });
        const newVersion = (old.version || 1) + 1;
        await pool.query(
          'UPDATE templates SET data=$1, version=$2, previous_versions=$3, variables=$4, updated_at=NOW() WHERE account_id=$5 AND filename=$6',
          [buf, newVersion, JSON.stringify(prevVersions), JSON.stringify(templateVars), accountId, safeName]
        );
      } else {
        await pool.query(
          'INSERT INTO templates (account_id, filename, data, version, previous_versions, variables) VALUES ($1,$2,$3,$4,$5,$6)',
          [accountId, safeName, buf, 1, '[]', JSON.stringify(templateVars)]
        );
      }
      // I3: Audit log for template upload
      pool.query('INSERT INTO audit_log (account_id, action, details) VALUES ($1,$2,$3)',
        [accountId, 'template.upload', JSON.stringify({ filename: safeName, variables: templateVars.length })]).catch(err => { try { require('../services/logger.service').warn({ err: err.message }, 'audit/email fire-and-forget failed'); } catch {} });
      res.json({ success: true, filename: safeName, variables: templateVars, variables_found: templateVars.length });
    } catch (err) {
      try { require('../services/logger.service').error({ err: err.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  router.get('/templates', requireAuth, async (req, res) => {
    const accountId = req.accountId;
    try {
      // #7 Pagination
      const { limit, page, offset } = parsePagination(req.query);
      const [countRes, result] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM templates WHERE account_id=$1', [accountId]),
        pool.query('SELECT filename, created_at, updated_at, (canvas_json IS NOT NULL) as has_editor, version, variables FROM templates WHERE account_id=$1 ORDER BY COALESCE(updated_at, created_at) DESC LIMIT $2 OFFSET $3', [accountId, limit, offset]),
      ]);
      const total = parseInt(countRes.rows[0].count, 10);
      res.json({ templates: result.rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (err) {
      res.status(500).json({ error: 'Error al listar plantillas' });
    }
  });

  // FIX 2 — template version history endpoint — MUST be before /:filename routes
  router.get('/templates/:filename/versions', requireAuth, async (req, res) => {
    try {
      const filename = path.basename(req.params.filename);
      const r = await pool.query(
        'SELECT version, previous_versions FROM templates WHERE account_id=$1 AND filename=$2',
        [req.accountId, filename]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Plantilla no encontrada' });
      const row = r.rows[0];
      const versions = Array.isArray(row.previous_versions) ? row.previous_versions : [];
      res.json({ filename, current_version: row.version || 1, versions });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Subir logo de cuenta
  // P1-9: requireAuth — account_id from token, not body
  router.post('/logo/upload', requireAuth, upload.single('logo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
    const accountId = req.accountId;
    try {
      await pool.query(
        'INSERT INTO logos (account_id, filename, data, mimetype) VALUES ($1,$2,$3,$4) ON CONFLICT (account_id) DO UPDATE SET data=$3, filename=$2, mimetype=$4',
        [accountId, req.file.originalname, req.file.buffer, req.file.mimetype]
      );
      res.json({ success: true, filename: req.file.originalname });
    } catch(err) {
      try { require('../services/logger.service').error({ err: err.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // Obtener logo de cuenta — requireAuth: account_id desde token, nunca desde query param
  router.get('/logo', requireAuth, async (req, res) => {
    try {
      const result = await pool.query('SELECT data, mimetype, filename FROM logos WHERE account_id = $1', [req.accountId]);
      if (!result.rows.length) return res.status(404).json({ error: 'No hay logo' });
      res.set('Content-Type', result.rows[0].mimetype);
      res.send(result.rows[0].data);
    } catch(err) {
      try { require('../services/logger.service').error({ err: err.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // ── LOGO DELETE ──
  router.delete('/logo/delete', requireAuth, async (req, res) => {
    try {
      await pool.query('DELETE FROM logos WHERE account_id=$1', [req.accountId]);
      res.json({ success: true });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/editor/save-template', requireAuth, async (req, res) => {
    const { canvasJson, templateName } = req.body;
    if (!canvasJson || !templateName) return res.status(400).json({ error: 'Faltan datos' });

    try {
      const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
              AlignmentType, WidthType, BorderStyle, ShadingType, HeadingLevel,
              UnderlineType } = require('docx');

      const objects = canvasJson.objects || [];
      const expandHex = c => { if(!c||typeof c!=='string') return '000000'; const h = c.replace('#',''); return h.length === 3 ? h.split('').map(x=>x+x).join('') : h.padEnd(6,'0'); };
      const PAGE_W_PT = 9360; // ~6.5 inches in twips (1/20 pt)
      const PAGE_H = 1123;
      const PAGE_W_PX = 794;

      // Sort by top position
      objects.sort((a, b) => (a.top || 0) - (b.top || 0));

      const children = [];

      for (const obj of objects) {
        if (obj.isGrid) continue;

        if (obj.type === 'i-text' || obj.type === 'text') {
          const text = obj.text || '';
          const fontSize = Math.round((obj.fontSize || 12) * 1.1);
          const align = obj.textAlign === 'center' ? AlignmentType.CENTER
                      : obj.textAlign === 'right' ? AlignmentType.RIGHT
                      : AlignmentType.LEFT;

          children.push(new Paragraph({
            alignment: align,
            spacing: { before: 40, after: 40 },
            children: [new TextRun({
              text,
              size: fontSize * 2,
              bold: obj.fontWeight === 'bold',
              italics: obj.fontStyle === 'italic',
              underline: obj.underline ? { type: UnderlineType.SINGLE } : undefined,
              color: expandHex(obj.fill || '#000000'),
              font: obj.fontFamily || 'Arial',
            })]
          }));

        } else if (obj.type === 'rect') {
          // Colored block as table cell
          const fillColor = (obj.fill || '#ffffff').replace('#', '');
          const strokeColor = (obj.stroke || '#000000').replace('#', '');
          const widthPct = Math.round((obj.width * (obj.scaleX || 1) / PAGE_W_PX) * 100 * 50);
          children.push(new Table({
            width: { size: widthPct, type: WidthType.PERCENTAGE },
            rows: [new TableRow({ children: [
              new TableCell({
                shading: { fill: fillColor, type: ShadingType.CLEAR },
                borders: {
                  top: { style: BorderStyle.SINGLE, size: Math.round((obj.strokeWidth || 0) * 8), color: strokeColor },
                  bottom: { style: BorderStyle.SINGLE, size: Math.round((obj.strokeWidth || 0) * 8), color: strokeColor },
                  left: { style: BorderStyle.SINGLE, size: Math.round((obj.strokeWidth || 0) * 8), color: strokeColor },
                  right: { style: BorderStyle.SINGLE, size: Math.round((obj.strokeWidth || 0) * 8), color: strokeColor },
                },
                children: [new Paragraph({ children: [] })]
              })
            ]})]
          }));
          children.push(new Paragraph({ children: [] }));

        } else if (obj.type === 'line') {
          const strokeColor = (obj.stroke || '#000000').replace('#', '');
          children.push(new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: Math.round((obj.strokeWidth || 1) * 8), color: strokeColor, space: 1 } },
            children: []
          }));

        } else if (obj.type === 'image') {
          // Image stored as base64 in src
          if (obj.src && obj.src.startsWith('data:')) {
            const matches = obj.src.match(/^data:([^;]+);base64,(.+)$/);
            if (matches) {
              const mimeType = matches[1];
              const imgData = Buffer.from(matches[2], 'base64');
              const imgW = Math.round(obj.width * (obj.scaleX || 1));
              const imgH = Math.round(obj.height * (obj.scaleY || 1));
              // Convert px to EMU (1px = 9525 EMU)
              children.push(new Paragraph({
                children: [new ImageRun({
                  data: imgData,
                  transformation: { width: imgW, height: imgH },
                  type: mimeType.includes('png') ? 'png' : 'jpg',
                })]
              }));
            }
          }

        } else if (obj.type === 'group') {
          if (obj.tableType === 'products' && obj.tableCols) {
            // Real table with loop
            const cols = obj.tableCols;
            const expandHex = c => { const h = c.replace('#',''); return h.length === 3 ? h.split('').map(x=>x+x).join('') : h; };
          const headerColor = expandHex(obj.tableHeaderColor || '#2D5BE3');
            const loopName = obj.tableLoop || 'subelementos';
            const colWidthPct = Math.floor(100 / cols.length);

            // Header row
            const headerCells = cols.map(col => new TableCell({
              shading: { fill: headerColor, type: ShadingType.CLEAR },
              borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
              width: { size: colWidthPct, type: WidthType.PERCENTAGE },
              children: [new Paragraph({
                alignment: AlignmentType.LEFT,
                children: [new TextRun({ text: col.header, bold: true, color: 'FFFFFF', size: 20, font: 'Arial' })]
              })]
            }));

            // Data row with loop variables
            const dataCells = cols.map((col, i) => {
              const isFirst = i === 0;
              const isLast = i === cols.length - 1;
              const cellText = (isFirst ? '{#' + loopName + '}' : '') + col.variable + (isLast ? '{/' + loopName + '}' : '');
              return new TableCell({
                shading: { fill: 'F8F9FF', type: ShadingType.CLEAR },
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 4, color: 'E0E4FF' },
                  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E0E4FF' },
                  left: { style: BorderStyle.SINGLE, size: 4, color: 'E0E4FF' },
                  right: { style: BorderStyle.SINGLE, size: 4, color: 'E0E4FF' },
                },
                width: { size: colWidthPct, type: WidthType.PERCENTAGE },
                children: [new Paragraph({
                  children: [new TextRun({ text: cellText, size: 20, font: 'Arial' })]
                })]
              });
            });

            const table = new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: [
                new TableRow({ children: headerCells }),
                new TableRow({ children: dataCells })
              ]
            });
            children.push(table);
            children.push(new Paragraph({ children: [] }));

          } else if (obj.objects) {
            // Other groups - extract text
            const texts = obj.objects
              .filter(o => o.type === 'text' || o.type === 'i-text')
              .map(o => o.text || '')
              .join(' ');
            if (texts) {
              children.push(new Paragraph({
                children: [new TextRun({ text: texts, size: 22, font: 'Arial' })]
              }));
            }
          }
        }
      }

      if (!children.length) children.push(new Paragraph({ children: [] }));

      const doc = new Document({
        sections: [{
          properties: {
            page: {
              size: { width: 12240, height: 15840 },
              margin: { top: 1080, right: 1440, bottom: 1440, left: 1440 }
            }
          },
          children
        }]
      });

      const buffer = await Packer.toBuffer(doc);

      // Save to DB as template
      const filename = templateName.replace(/[^a-zA-Z0-9\-_]/g, '_') + '.docx';
      await pool.query(
        'INSERT INTO templates (account_id, filename, data, canvas_json, updated_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (account_id, filename) DO UPDATE SET data=$3, canvas_json=$4, updated_at=NOW()',
        [req.accountId, filename, buffer, JSON.stringify(canvasJson)]
      );

      res.json({ success: true, filename });
    } catch(err) {
      logger.error('Editor save error:', err.message);
      try { require('../services/logger.service').error({ err: err.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  });

  // ─── TEMPLATE MANAGEMENT ──────────────────────────────────
  router.get('/templates/:filename/canvas', requireAuth, async (req, res) => {
    try {
      const r = await pool.query('SELECT canvas_json FROM templates WHERE account_id=$1 AND filename=$2', [req.accountId, req.params.filename]);
      if (!r.rows.length) return res.status(404).json({ error: 'No encontrada' });
      res.json({ canvas_json: r.rows[0].canvas_json ? JSON.parse(r.rows[0].canvas_json) : null });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.delete('/templates/:filename', requireAuth, async (req, res) => {
    try {
      await pool.query('DELETE FROM templates WHERE account_id=$1 AND filename=$2', [req.accountId, req.params.filename]);
      // I3: Audit log for template delete
      pool.query('INSERT INTO audit_log (account_id, action, details) VALUES ($1,$2,$3)',
        [req.accountId, 'template.delete', JSON.stringify({ filename: req.params.filename })]).catch(err => { try { require('../services/logger.service').warn({ err: err.message }, 'audit/email fire-and-forget failed'); } catch {} });
      res.json({ success: true });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/templates/:filename/duplicate', requireAuth, async (req, res) => {
    try {
      const { newName } = req.body;
      const r = await pool.query('SELECT data, canvas_json FROM templates WHERE account_id=$1 AND filename=$2', [req.accountId, req.params.filename]);
      if (!r.rows.length) return res.status(404).json({ error: 'No encontrada' });
      const newFilename = (newName || req.params.filename.replace('.docx','') + '_copia') + '.docx';
      await pool.query(
        'INSERT INTO templates (account_id, filename, data, canvas_json) VALUES ($1,$2,$3,$4) ON CONFLICT (account_id, filename) DO UPDATE SET data=$3, canvas_json=$4',
        [req.accountId, newFilename, r.rows[0].data, r.rows[0].canvas_json]
      );
      res.json({ success: true, filename: newFilename });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/templates/:filename/rename', requireAuth, async (req, res) => {
    try {
      const { newName } = req.body;
      if (!newName) return res.status(400).json({ error: 'Nuevo nombre requerido' });
      const newFilename = newName.endsWith('.docx') ? newName : newName + '.docx';
      await pool.query('UPDATE templates SET filename=$1, updated_at=NOW() WHERE account_id=$2 AND filename=$3', [newFilename, req.accountId, req.params.filename]);
      // I3: Audit log for template rename
      pool.query('INSERT INTO audit_log (account_id, action, details) VALUES ($1,$2,$3)',
        [req.accountId, 'template.rename', JSON.stringify({ from: req.params.filename, to: newFilename })]).catch(err => { try { require('../services/logger.service').warn({ err: err.message }, 'audit/email fire-and-forget failed'); } catch {} });
      res.json({ success: true, filename: newFilename });
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // ── TEMPLATE EXPORT — download .docx binary for backup / version control ──
  router.get('/templates/:filename/export', requireAuth, async (req, res) => {
    try {
      const filename = path.basename(req.params.filename);
      const r = await pool.query('SELECT data, filename FROM templates WHERE account_id=$1 AND filename=$2', [req.accountId, filename]);
      if (!r.rows.length) return res.status(404).json({ error: 'Plantilla no encontrada' });
      const dl = r.rows[0].filename;
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.set('Content-Disposition', 'attachment; filename="' + dl.replace(/"/g, '\\"') + '"');
      res.send(r.rows[0].data);
    } catch(e) { try { require('../services/logger.service').error({ err: e.message }, 'request error'); } catch {}
      res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
