'use strict';
const { Router } = require('express');
const jwt = require('jsonwebtoken');
const PizZip = require('pizzip');

module.exports = function makeWorkflowsRouter(deps) {
  const {
    pool, logger, docGenRateLimit,
    getMondayItem, createDocxtemplater, injectGlobalSettings,
    toVarName, extractColumnValue, calcularTotales,
    verifyWorkflowJWT, severityError,
    checkSubscription, incrementDocsUsed,
    sendEmail, sendSignatureEmail, escapeHtml, decryptToken,
    createMondayUpdate,
  } = deps;
  const router = Router();

  // ── WORKFLOW PRIMITIVE FIELDS - REMOTE OPTIONS ──
  // Devuelve lista de plantillas de la cuenta para dropdown en workflow builder
  router.post('/workflows/fields/templates', async (req, res) => {
    try {
      // P1-2: JWT required — no fallback to body payload (prevents unauthenticated template listing)
      const auth = req.headers['authorization'] || '';
      const token = auth.replace('Bearer ', '');
      let verified;
      try {
        const secret = process.env.MONDAY_SIGNING_SECRET || process.env.MONDAY_CLIENT_SECRET;
        verified = jwt.verify(token, secret);
      } catch (e) {
        return res.status(401).json({ error: 'Token inválido' });
      }
      const accountId = verified.accountId || verified.account_id;

      if (!accountId) return res.status(401).json({ error: 'Token inválido' });

      const r = await pool.query(
        'SELECT id, name FROM templates WHERE account_id=$1 AND deleted_at IS NULL ORDER BY name ASC',
        [accountId]
      );

      if (!r.rows.length) {
        return res.status(200).json([{ title: 'No hay plantillas disponibles', value: '' }]);
      }

      const options = r.rows.map(t => ({
        title: t.name,
        value: t.id.toString()
      }));

      res.status(200).json(options);
    } catch(e) {
      logger.error('Workflow fields/templates error:', e.message);
      res.status(200).json([{ title: 'Error al cargar plantillas', value: '' }]);
    }
  });

  // ── MONDAY WORKFLOWS - ACTION BLOCKS ──

  // ACTION BLOCK 1: Generar documento desde workflow
  router.post('/workflows/generate-document', docGenRateLimit, async (req, res) => {
    // FIX-6: verifyWorkflowJWT runs FIRST — before any business logic
    const verified = verifyWorkflowJWT(req);
    if (!verified) return res.status(401).json(severityError(4000, 'Auth error', 'Invalid token', 'JWT verification failed'));

    // FIX-6: accountId derived from JWT, not from req.body
    const accountId = verified.accountId || verified.account_id;

    // Subscription check using accountId from JWT
    const _subCheck = await checkSubscription(accountId);
    if (!_subCheck.allowed) {
      const msg = _subCheck.reason === "trial_expired"
        ? "Tu periodo de prueba ha expirado. Actualiza tu plan."
        : _subCheck.reason === "docs_limit_reached"
          ? "Limite de documentos alcanzado (" + _subCheck.docs_used + "/" + _subCheck.docs_limit + "). Actualiza tu plan."
          : "Suscripcion inactiva. Actualiza tu plan.";
      return res.status(402).json({ error: msg, reason: _subCheck.reason, plan: _subCheck.plan });
    }

    const { payload } = req.body;
    const fields = payload?.inboundFieldValues || payload?.inputFields || {};

    const itemId    = fields.itemId    || fields.item_id;
    const boardId   = fields.boardId   || fields.board_id;
    const templateId = fields.templateId || fields.template_id;

    if (!itemId || !boardId || !templateId) {
      return res.status(400).json(severityError(4000, 'Campos requeridos', 'Faltan itemId, boardId o templateId', 'Missing required input fields'));
    }

    try {
      // Obtener token del account
      const tokenRow = await pool.query('SELECT access_token FROM tokens WHERE account_id=$1 LIMIT 1', [accountId]);
      if (!tokenRow.rows.length) return res.status(401).json(severityError(6000, 'No autenticado', 'La cuenta no tiene token', 'No token found for account'));
      const accessToken = decryptToken(tokenRow.rows[0].access_token);

      // P1-3: getMondayItem usa variables GraphQL
      const item = await getMondayItem(accessToken, itemId, 'id text value').catch(() => null);
      if (!item) return res.status(404).json(severityError(4000, 'Item no encontrado', 'El item no existe o no es accesible', 'Item not found'));

      // FIX-23: templateId is the numeric DB id (from fields/templates dropdown which returns t.id.toString())
      // Use WHERE id=$1 — not WHERE filename=$1
      const tmplRow = await pool.query('SELECT * FROM templates WHERE id=$1 AND account_id=$2', [parseInt(templateId, 10), accountId]);
      if (!tmplRow.rows.length) return res.status(404).json(severityError(6000, 'Template no encontrado', 'El template fue eliminado. Reconfigura la automatización.', 'Template not found in DB'));

      // Construir rowData desde column_values
      const rowData = { item_name: item.name, nombre: item.name };
      item.column_values.forEach(cv => {
        rowData[cv.id] = cv.text || '';
        try { const v = JSON.parse(cv.value); if (v && typeof v === 'object') rowData[cv.id + '_raw'] = v; } catch(e){}
      });

      const templateBuf = tmplRow.rows[0].data;
      const zip = new PizZip(templateBuf);
      const doc = await createDocxtemplater(zip, accountId);
      doc.render(rowData);
      const docBuf = doc.getZip().generate({ type: 'nodebuffer' });

      // Guardar en documents
      const docRow = await pool.query(
        'INSERT INTO documents (account_id, item_id, board_id, item_name, template_name, filename, doc_data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id',
        [accountId, itemId, boardId, item.name, templateId, `${item.name}_${Date.now()}.docx`, docBuf]
      );
      const docId = docRow.rows[0].id;

      logger.info('Workflow generate-document: doc', docId, 'item', itemId, 'account', accountId);

      await incrementDocsUsed(accountId); // billing
      res.status(200).json({
        outputFields: {
          documentId: docId.toString(),
          itemName: item.name,
          success: true,
          generatedAt: new Date().toISOString()
        }
      });
    } catch(e) {
      logger.error('Workflow generate-document error:', e.message);
      res.status(500).json(severityError(4000, 'Error al generar', 'Ocurrió un error al generar el documento', e.message));
    }
  });

  // ACTION BLOCK 2: Enviar documento a firma desde workflow
  router.post('/workflows/send-for-signature', async (req, res) => {
    const verified = verifyWorkflowJWT(req);
    if (!verified) return res.status(401).json(severityError(4000, 'Auth error', 'Invalid token', 'JWT verification failed'));

    const { payload } = req.body;
    const fields = payload?.inboundFieldValues || payload?.inputFields || {};
    const accountId = verified.accountId || verified.account_id;

    // FIX-7: Check signature limit before creating signature request
    try {
      const { getAccountPlanLimits, getMonthlyUsage } = require('../services/billing.service');
      const limits = await getAccountPlanLimits(accountId);
      if (limits && limits.sigs !== -1) {
        const usage = await getMonthlyUsage(accountId);
        if (usage.sigs >= limits.sigs) {
          return res.status(402).json(severityError(4000, 'Límite de firmas alcanzado', 'Has alcanzado el límite de firmas de tu plan. Actualiza tu plan para continuar.', 'sig_limit_reached'));
        }
      }
    } catch(e) {
      return res.status(500).json(severityError(4000, 'Error verificando límite', 'Error verificando suscripción.', e.message));
    }

    const documentId   = fields.documentId || fields.document_id;
    const signerName   = fields.signerName  || fields.signer_name  || '';
    const signerEmail  = fields.signerEmail || fields.signer_email || '';
    const itemId       = fields.itemId      || fields.item_id;

    if (!documentId) {
      return res.status(400).json(severityError(4000, 'Campo requerido', 'Falta documentId', 'Missing documentId'));
    }

    try {
      // Verificar que el documento existe
      const docRow = await pool.query('SELECT * FROM documents WHERE id=$1 AND account_id=$2', [documentId, accountId]);
      if (!docRow.rows.length) return res.status(404).json(severityError(4000, 'Documento no encontrado', 'El documento no existe', 'Document not found'));

      // Crear signature request
      const token = require('crypto').randomBytes(32).toString('hex');
      const sigRow = await pool.query(
        `INSERT INTO signature_requests (document_id, account_id, item_id, signer_name, signer_email, token, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW()) RETURNING id`,
        [documentId, accountId, itemId || null, signerName, signerEmail, token]
      );
      const sigId = sigRow.rows[0].id;
      const portalUrl = `${process.env.APP_URL || 'https://docugen-monday-production.up.railway.app'}/portal.html?token=${token}`;

      // Enviar email si hay email del firmante
      if (signerEmail) {
        await sendSignatureEmail(signerEmail, signerName, portalUrl, docRow.rows[0].filename || 'Documento');
      }

      logger.info('Workflow send-for-signature: sig', sigId, 'doc', documentId, 'account', accountId);

      res.status(200).json({
        outputFields: {
          signatureRequestId: sigId.toString(),
          portalUrl,
          signerEmail,
          success: true,
          sentAt: new Date().toISOString()
        }
      });
    } catch(e) {
      logger.error('Workflow send-for-signature error:', e.message);
      res.status(500).json(severityError(4000, 'Error al enviar', 'Ocurrió un error al enviar a firma', e.message));
    }
  });

  // Remind desde Workflow Action Block
  // FIX-8: verifyWorkflowJWT added — unauthenticated reminder endpoint allows email spam
  router.post('/workflows/send-reminder', async (req, res) => {
    try {
      const verified = verifyWorkflowJWT(req);
      if (!verified) return res.status(401).json(severityError(4000, 'Auth error', 'Invalid token', 'JWT verification failed'));
      const verifiedAccountId = verified.accountId || verified.account_id;

      const { inputFields } = req.body;
      const documentId = inputFields?.documentId;
      if (!documentId) return res.status(400).json({ error: 'documentId requerido' });

      // FIX-8: scope query to verified account to prevent cross-account access
      const r = await pool.query('SELECT * FROM signature_requests WHERE id=$1 AND account_id=$2', [documentId, verifiedAccountId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Documento no encontrado' });
      const sig = r.rows[0];

      if (sig.status === 'signed') return res.json({ outputFields: { success: false, reason: 'Ya firmado' } });
      if (!sig.signer_email) return res.json({ outputFields: { success: false, reason: 'Sin email' } });

      const portalUrl = (process.env.APP_URL || 'https://docugen-monday-production.up.railway.app') + '/sign/' + sig.token;
      const expiresText = sig.expires_at ? new Date(sig.expires_at).toLocaleDateString('es-MX') : 'pronto';

      await sendEmail({
        to:      sig.signer_email,
        subject: 'Recordatorio: documento pendiente de tu firma',
        html:    '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px"><h2>Tienes un documento pendiente de firma</h2><p>Hola <strong>' + escapeHtml(sig.signer_name) + '</strong>,</p><p>El documento <strong>' + escapeHtml(sig.document_filename) + '</strong> sigue pendiente de tu firma. Expira el ' + escapeHtml(expiresText) + '.</p><div style="margin:32px 0;text-align:center"><a href="' + escapeHtml(portalUrl) + '" style="background:#1a1a1a;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px">Firmar ahora</a></div></div>',
        type: 'reminder',
      });

      if (sig.item_id && sig.account_id) {
        const tokenRow = await pool.query('SELECT access_token FROM tokens WHERE account_id=$1 LIMIT 1', [sig.account_id]);
        if (tokenRow.rows.length) {
          // P1-3: createMondayUpdate usa variables GraphQL
        await createMondayUpdate(
          decryptToken(tokenRow.rows[0].access_token),
          sig.item_id,
          `Recordatorio de firma enviado a ${sig.signer_name}.`
        );
        }
      }

      res.json({ outputFields: { success: true, sentTo: sig.signer_email, documentName: sig.document_filename } });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
