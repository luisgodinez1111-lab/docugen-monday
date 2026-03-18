'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const PizZip = require('pizzip');
// P3-5: multer moved to module top level (was inside factory function)
const multer = require('multer');

module.exports = function makeSignaturesRouter(deps) {
  const {
    pool, requireAuth, logger, parsePagination,
    withTransaction, sendEmail, sendApprovalEmails,
    escapeHtml, emailSignRequest, generateDocHash,
    generateOtp, hashOtp, verifyOtp, decryptToken,
    createMondayUpdate, mondayQuery,
    checkSigLimit, outputsDir, convertDocxToPdf,
    generateAuditCertificate,
  } = deps;
  const router = Router();

  // FIX-9: XML escape helper for OOXML injection prevention
  function xmlEscape(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  }

  // P0-1: getAccountAdmins — fetches admin emails for legal doc approval flow
  async function getAccountAdmins(accountId) {
    const result = await pool.query(
      "SELECT settings FROM account_settings WHERE account_id=$1",
      [accountId]
    );
    if (!result.rows.length) return [];
    try {
      const admins = result.rows[0].settings?.admin_emails;
      if (Array.isArray(admins)) return admins;
      if (typeof admins === 'string') return JSON.parse(admins);
      return [];
    } catch { return []; }
  }

  // ─── FIRMA DIGITAL ────────────────────────────────────────
  // FIX-11: All ALTER TABLE statements removed — they are in initDB()
  router.post('/signatures/request', requireAuth, checkSigLimit, async (req, res) => {
    const { document_filename, signer_name, signer_email, item_id, board_id, doc_type } = req.body;
    if (!document_filename || !signer_name) return res.status(400).json({ error: 'Faltan datos' });
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 días
      // Hash del PDF para cadena de custodia legal
      let docHashVal = null;
      try {
        if (item_id) {
          const pdfForHash = await pool.query(
            "SELECT doc_data FROM documents WHERE item_id=$1 AND filename LIKE '%.pdf' AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1",
            [String(item_id)]
          );
          if (pdfForHash.rows.length) docHashVal = generateDocHash(pdfForHash.rows[0].doc_data);
        }
      } catch(e) {}
      const auditInit = JSON.stringify([{
        event: 'created',
        timestamp: new Date().toISOString(),
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
        user_agent: req.headers['user-agent'] || '',
        details: 'Solicitud de firma creada por cuenta ' + req.accountId
      }]);
      const consentText = 'Al firmar este documento, el firmante acepta que su firma electronica tiene plena validez legal conforme a la legislacion mexicana (Codigo de Comercio Art. 89-114, NOM-151-SCFI-2016). IP: ' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') + '. Fecha: ' + new Date().toISOString();
      // Guardar doc_data directamente en la solicitud de firma
      let signDocData = null;
      logger.debug({ itemId: item_id, accountId: req.accountId, filename: document_filename }, 'Signature request');
      try {
        if (item_id) {
          const docQ = await pool.query(
            "SELECT doc_data FROM documents WHERE item_id=$1 AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1",
            [String(item_id)]
          );
          logger.debug({ count: docQ.rows.length }, 'FIRMA docs by item_id');
          if (docQ.rows.length) signDocData = docQ.rows[0].doc_data;
        }
        if (!signDocData) {
          const docQ2 = await pool.query(
            "SELECT doc_data FROM documents WHERE account_id=$1 AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1",
            [req.accountId]
          );
          logger.debug({ count: docQ2.rows.length }, 'FIRMA docs by account');
          if (docQ2.rows.length) signDocData = docQ2.rows[0].doc_data;
        }
      } catch(e) {}

      // #2 TRANSACTION: insert signature_request + optional approval_request atomically
      const finalDocType = doc_type || 'document';
      const signUrl      = process.env.APP_URL + '/sign/' + token;
      let approvalToken  = null;
      let adminsNotified = 0;

      await withTransaction(pool, async (client) => {
        await client.query(
          'INSERT INTO signature_requests (token, account_id, document_filename, signer_name, signer_email, item_id, board_id, expires_at, doc_hash, audit_log, consent_text, doc_data, doc_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
          [token, req.accountId, document_filename, signer_name, signer_email, item_id, board_id, expiresAt, docHashVal, auditInit, consentText, signDocData, finalDocType]
        );
        logger.debug({ bytes: signDocData ? signDocData.length : 0 }, 'FIRMA signDocData saved');

        if (finalDocType === 'legal') {
          approvalToken = crypto.randomBytes(32).toString('hex');
          const sigRow = await client.query('SELECT id FROM signature_requests WHERE token=$1', [token]);
          if (!sigRow.rows.length) throw new Error('Signature request not found after insert');
          await client.query(
            'INSERT INTO approval_requests (approval_token, signature_request_id) VALUES ($1,$2)',
            [approvalToken, sigRow.rows[0].id]
          );
          await client.query('UPDATE signature_requests SET status=$1 WHERE token=$2', ['pending_approval', token]);
        }
      });

      // Post-transaction: send emails (outside TX — email failures don't roll back the record)
      if (finalDocType === 'legal') {
        const admins = await getAccountAdmins(req.accountId);
        await sendApprovalEmails(admins, approvalToken, document_filename, signer_name, req.accountId);
        adminsNotified = admins.length;
        res.json({ success: true, token, sign_url: signUrl, status: 'pending_approval', admins_notified: adminsNotified });
      } else {
        // #6 Email queue: send via BullMQ when Redis available, direct Resend otherwise
        if (signer_email) {
          sendEmail({
            to:      signer_email,
            subject: 'Documento pendiente de tu firma — ' + escapeHtml(document_filename),
            html:    emailSignRequest(escapeHtml(signer_name), escapeHtml(document_filename), signUrl, expiresAt),
            type:    'sign_request',
            accountId: req.accountId,
            token,
          }).catch(emailErr => logger.error({ err: emailErr.message }, 'Email error'));
        }
        res.json({ success: true, token, sign_url: signUrl });
      }
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // PDF on-demand para portal viewer
  router.get('/sign/:token/preview-pdf', async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1', [req.params.token]);
      if (!r.rows.length) return res.status(404).send('No encontrado');
      const sig = r.rows[0];
      const filename = sig.document_filename;
      const pdfFilename = filename.replace(/\.docx$/i, '.pdf');

      // 0. Usar doc_data guardado directamente en la solicitud (más confiable)
      if (sig.doc_data) {
        const fname = sig.document_filename || '';
        if (fname.endsWith('.pdf')) {
          res.set('Content-Type', 'application/pdf');
          res.set('Content-Disposition', 'inline; filename="documento.pdf"');
          return res.send(sig.doc_data);
        } else {
          // Es DOCX — convertir con mammoth
          try {
            const mammoth = require('mammoth');
            const result = await mammoth.convertToHtml({ buffer: sig.doc_data });
            res.set('Content-Type', 'text/html; charset=utf-8');
            return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Georgia,serif;max-width:750px;margin:40px auto;padding:20px;font-size:14px;line-height:1.8;color:#111}h1,h2,h3{font-family:Georgia,serif}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px}img{max-width:100%}p{margin-bottom:10px}</style></head><body>' + result.value + '</body></html>');
          } catch(e) {}
        }
      }

      // 1. Buscar PDF generado por item_id (el real, no la plantilla)
      let pdfData = null;
      if (sig.item_id) {
        const pdfR = await pool.query(
          "SELECT doc_data FROM documents WHERE item_id=$1 AND filename LIKE '%.pdf' AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1",
          [String(sig.item_id)]
        );
        if (pdfR.rows.length) pdfData = pdfR.rows[0].doc_data;
      }
      if (pdfData) {
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'inline; filename="documento.pdf"');
        return res.send(pdfData);
      }

      // 2. Buscar DOCX generado por item_id (no la plantilla)
      const docR = { rows: [] };
      if (sig.item_id) {
        const docR2 = await pool.query(
          "SELECT doc_data, filename FROM documents WHERE item_id=$1 AND doc_data IS NOT NULL AND filename != $2 AND filename NOT LIKE '%.pdf' ORDER BY created_at DESC LIMIT 1",
          [String(sig.item_id), filename]
        );
        if (docR2.rows.length) docR.rows.push(docR2.rows[0]);
      }
      if (!docR.rows.length && sig.account_id) {
        const docR3 = await pool.query(
          "SELECT doc_data, filename FROM documents WHERE account_id=$1 AND doc_data IS NOT NULL AND filename != $2 AND filename NOT LIKE '%.pdf' ORDER BY created_at DESC LIMIT 1",
          [sig.account_id, filename]
        );
        if (docR3.rows.length) docR.rows.push(docR3.rows[0]);
      }

      if (!docR.rows.length) return res.status(404).send('Documento no encontrado');

      // P3-3: tmpDocx cleanup wrapped in finally to ensure cleanup on exception
      let tmpDocx = null;
      try {
        tmpDocx = path.join(outputsDir, 'tmp_preview_' + Date.now() + '.docx');
        fs.writeFileSync(tmpDocx, docR.rows[0].doc_data);

        // Convertir DOCX a HTML con mammoth y devolver como HTML embebible
        const mammoth = require('mammoth');
        const result = await mammoth.convertToHtml({ buffer: docR.rows[0].doc_data });
        const html = result.value;
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Georgia,serif;max-width:750px;margin:40px auto;padding:20px;font-size:14px;line-height:1.8;color:#111}h1,h2,h3{font-family:Georgia,serif}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px}img{max-width:100%}p{margin-bottom:10px}</style></head><body>' + html + '</body></html>');
      } catch(mammothErr) {
        logger.error('Mammoth error:', mammothErr.message);
        res.status(500).send('Error convirtiendo documento');
      } finally {
        if (tmpDocx) try { fs.unlinkSync(tmpDocx); } catch {}
      }
    } catch(e) { res.status(500).send('Error: ' + e.message); }
  });

  // INFO endpoint - debe ir ANTES del portal
  // Enviar OTP al firmante
  router.post('/sign/:token/send-otp', async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1 AND status=$2', [req.params.token, 'pending']);
      if (!r.rows.length) return res.status(404).json({ error: 'Link no válido' });
      const sig = r.rows[0];
      if (!sig.signer_email) return res.status(400).json({ error: 'No hay email registrado para este firmante' });

      // P2-2: crypto.randomInt — criptográficamente seguro (no Math.random)
      // P2-3: almacenar HASH del OTP, no el código en claro
      const otp = generateOtp();
      const otpHash = hashOtp(otp, req.params.token);

      await pool.query(
        'UPDATE signature_requests SET otp_code=$1, otp_verified=FALSE, otp_attempts=0 WHERE token=$2',
        [otpHash, req.params.token]
      );

      // #6 Enviar OTP vía sendEmail (queue-first, direct-send fallback)
      await sendEmail({
        to:      sig.signer_email,
        subject: 'Código de verificación para firma de documento',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px">
            <div style="background:#0f1e3d;color:white;padding:20px;border-radius:8px 8px 0 0;text-align:center">
              <h2 style="margin:0">DocuGen · Verificación de Firma</h2>
            </div>
            <div style="background:#f9f9f9;padding:24px;border:1px solid #e0e0e0;border-radius:0 0 8px 8px">
              <p>Hola <b>${escapeHtml(sig.signer_name) || 'firmante'}</b>,</p>
              <p>Tu código de verificación para firmar el documento <b>${escapeHtml(sig.document_filename)}</b> es:</p>
              <div style="background:white;border:2px solid #0f1e3d;border-radius:8px;padding:20px;text-align:center;margin:20px 0">
                <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#0f1e3d">${otp}</span>
              </div>
              <p style="color:#666;font-size:13px">Este código expira en <b>15 minutos</b>. No lo compartas con nadie.</p>
              <p style="color:#666;font-size:12px">Si no solicitaste esta firma, ignora este mensaje.</p>
            </div>
          </div>
        `,
        type: 'otp',
      });
      logger.info('OTP enviado a:', sig.signer_email);
      res.json({ ok: true, email: sig.signer_email.replace(/(.{2}).*(@.*)/, '$1***$2') });
    } catch(e) {
      logger.error('OTP send error:', e.message);
      res.status(500).json({ error: 'Error enviando OTP: ' + e.message });
    }
  });

  // Verificar OTP
  router.post('/sign/:token/verify-otp', async (req, res) => {
    try {
      const { otp } = req.body;
      const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1', [req.params.token]);
      if (!r.rows.length) return res.status(404).json({ error: 'Token no válido' });
      const sig = r.rows[0];

      // P2-3: máximo 3 intentos (más conservador que los 5 anteriores)
      if (sig.otp_attempts >= 3) {
        return res.status(400).json({ error: 'Demasiados intentos fallidos. Solicita un nuevo código OTP.' });
      }

      // P2-2/P2-3: verifyOtp usa hashOtp + timingSafeEqual (sin comparación de string directo)
      if (!verifyOtp(otp, sig.otp_code, req.params.token)) {
        await pool.query('UPDATE signature_requests SET otp_attempts=otp_attempts+1 WHERE token=$1', [req.params.token]);
        return res.status(400).json({ error: 'Código incorrecto', attempts: (sig.otp_attempts || 0) + 1 });
      }

      await pool.query('UPDATE signature_requests SET otp_verified=TRUE, identity_verified=TRUE WHERE token=$1', [req.params.token]);
      res.json({ ok: true, verified: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/sign/:token/info', async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1', [req.params.token]);
      if (!r.rows.length) return res.status(404).json({ success: false, error: 'Token no válido' });
      const sig = r.rows[0];
      const expired = sig.expires_at && new Date(sig.expires_at) < new Date();
      res.json({
        success: true,
        document_filename: sig.document_filename,
        signer_name: sig.signer_name,
        signer_email: sig.signer_email ? sig.signer_email.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
        doc_type: sig.doc_type || 'document',
        quote_response: sig.quote_response || null,
        status: sig.status || 'pending',
        signed_at: sig.signed_at,
        created_at: sig.created_at,
        expires_at: sig.expires_at,
        expired,
        needs_otp: !!(sig.signer_email && !sig.otp_verified),
        group_id: sig.group_id,
        account_id: sig.account_id
      });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // DOWNLOAD endpoint — siempre sirve PDF
  router.get('/sign/:token/download', async (req, res) => {
    try {
      // P1-8: single query fetches all needed columns — eliminates 2 redundant follow-up queries
      const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1', [req.params.token]);
      if (!r.rows.length) return res.status(404).send('No encontrado');
      const sig = r.rows[0];
      const sigRow = sig; // sig already contains signature_data, signer_name, signed_at, signer_ip, signed_pdf
      const filename = sig.document_filename;
      const PDFDocument = require('pdf-lib').PDFDocument;
      const { rgb } = require('pdf-lib');

      // 1. Si tiene signed_pdf generado al firmar, servirlo
      const signedPdfSize = sig.signed_pdf?.length || 0;
      logger.debug('signed_pdf size:', signedPdfSize, 'token:', req.params.token.substring(0,10));
      if (signedPdfSize > 10000) {
        const outName = filename.replace(/\.\w+$/, '') + '_firmado.pdf';
        res.set('Content-Disposition', 'attachment; filename="' + outName + '"');
        res.set('Content-Type', 'application/pdf');
        return res.send(sig.signed_pdf);
      }

      // 2. Buscar PDF real del documento (preferir PDF sobre DOCX)
      let docData = null;
      let docFilename = filename;
      const pdfFilename = filename.replace(/\.docx$/i, '.pdf');

      // Primero buscar PDF convertido
      const pdfR = await pool.query(
        'SELECT doc_data, filename FROM documents WHERE filename=$1 AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        [pdfFilename]
      );
      if (pdfR.rows.length) { docData = pdfR.rows[0].doc_data; docFilename = pdfFilename; }

      // Si no hay PDF, buscar DOCX
      if (!docData) {
        const docR = await pool.query(
          'SELECT doc_data, filename FROM documents WHERE (filename=$1 OR template_name=$1) AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1',
          [filename]
        );
        if (docR.rows.length) { docData = docR.rows[0].doc_data; docFilename = docR.rows[0].filename || filename; }
      }

      // Fallback por account
      if (!docData && sig.account_id) {
        const docR2 = await pool.query(
          "SELECT doc_data, filename FROM documents WHERE account_id=$1 AND filename LIKE '%.pdf' AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1",
          [sig.account_id]
        );
        if (docR2.rows.length) { docData = docR2.rows[0].doc_data; docFilename = docR2.rows[0].filename; }
      }
      if (!docData && sig.account_id) {
        const docR3 = await pool.query(
          'SELECT doc_data, filename FROM documents WHERE account_id=$1 AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1',
          [sig.account_id]
        );
        if (docR3.rows.length) { docData = docR3.rows[0].doc_data; docFilename = docR3.rows[0].filename; }
      }

      // 3. Si tenemos PDF real y está firmado, incrustar firma en él
      if (docData && docFilename.endsWith('.pdf') && sig.status === 'signed' && sigRow?.signature_data) {
        try {
          const existingPdf = await PDFDocument.load(docData);
          const pages = existingPdf.getPages();
          const lastPage = pages[pages.length - 1];
          const { width, height } = lastPage.getSize();
          const b64 = sigRow.signature_data.replace(/^data:image\/\w+;base64,/, '');
          const imgBytes = Buffer.from(b64, 'base64');
          let sigImg;
          try { sigImg = sigRow.signature_data.includes('png') ? await existingPdf.embedPng(imgBytes) : await existingPdf.embedJpg(imgBytes); } catch(e) {}
          if (sigImg) {
            const dims = sigImg.scaleToFit(200, 80);
            lastPage.drawLine({ start:{x:40,y:120}, end:{x:width-40,y:120}, thickness:0.5, color:rgb(0.7,0.7,0.7) });
            lastPage.drawText('Firmado por: ' + (sigRow.signer_name || ''), { x:40, y:108, size:9, color:rgb(0.4,0.4,0.4) });
            lastPage.drawText('Fecha: ' + (sigRow.signed_at ? new Date(sigRow.signed_at).toLocaleString('es-MX') : ''), { x:40, y:96, size:9, color:rgb(0.4,0.4,0.4) });
            lastPage.drawText('IP: ' + (sigRow.signer_ip || ''), { x:40, y:84, size:9, color:rgb(0.4,0.4,0.4) });
            lastPage.drawImage(sigImg, { x:width-dims.width-40, y:80, width:dims.width, height:dims.height });
          }
          const signedBytes = await existingPdf.save();
          const outName = docFilename.replace('.pdf', '_firmado.pdf');
          res.set('Content-Disposition', 'attachment; filename="' + outName + '"');
          res.set('Content-Type', 'application/pdf');
          return res.send(Buffer.from(signedBytes));
        } catch(e) { logger.error('PDF embed error:', e.message); }
      }

      // Si tenemos PDF real sin firma, servirlo directo
      if (docData && docFilename.endsWith('.pdf')) {
        res.set('Content-Disposition', 'attachment; filename="' + docFilename + '"');
        res.set('Content-Type', 'application/pdf');
        return res.send(docData);
      }

      // 3. Generar PDF con info del documento + firma si existe
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595, 842]);
      const { width, height } = page.getSize();

      // Header
      page.drawRectangle({ x:0, y:height-80, width, height:80, color:rgb(0.11,0.27,0.53) });
      page.drawText('DOCUMENTO DIGITAL', { x:40, y:height-35, size:20, color:rgb(1,1,1) });
      page.drawText(filename, { x:40, y:height-58, size:10, color:rgb(0.8,0.9,1) });

      // Info
      let y = height - 110;
      const info = [
        ['Documento', filename],
        ['Destinatario', sig.signer_name || '—'],
        ['Email', sig.signer_email || '—'],
        ['Estado', sig.status === 'signed' ? 'FIRMADO' : 'PENDIENTE'],
        ['Generado', sig.created_at ? new Date(sig.created_at).toLocaleString('es-MX') : '—'],
      ];
      if (sig.status === 'signed') {
        info.push(['Fecha de firma', sigRow?.signed_at ? new Date(sigRow.signed_at).toLocaleString('es-MX') : '—']);
        info.push(['IP del firmante', sigRow?.signer_ip || '—']);
      }
      for (const [label, val] of info) {
        page.drawText(label + ':', { x:40, y, size:10, color:rgb(0.4,0.4,0.4) });
        page.drawText(String(val), { x:160, y, size:10, color:rgb(0.1,0.1,0.1) });
        y -= 22;
      }

      // Firma
      if (sig.status === 'signed' && sigRow?.signature_data) {
        y -= 10;
        page.drawLine({ start:{x:40,y}, end:{x:555,y}, thickness:1, color:rgb(0.85,0.85,0.85) });
        y -= 25;
        page.drawText('FIRMA DEL FIRMANTE', { x:40, y, size:10, color:rgb(0.4,0.4,0.4) });
        y -= 15;
        try {
          const b64 = sigRow.signature_data.replace(/^data:image\/\w+;base64,/, '');
          const imgBytes = Buffer.from(b64, 'base64');
          const sigImg = sigRow.signature_data.includes('png')
            ? await pdfDoc.embedPng(imgBytes)
            : await pdfDoc.embedJpg(imgBytes);
          const dims = sigImg.scaleToFit(280, 100);
          page.drawImage(sigImg, { x:40, y:y-dims.height, width:dims.width, height:dims.height });
          y -= dims.height + 20;
        } catch(e) { logger.error('Sig embed:', e.message); }
      }

      // Footer
      page.drawLine({ start:{x:40,y:60}, end:{x:555,y:60}, thickness:1, color:rgb(0.85,0.85,0.85) });
      page.drawText('Documento generado y gestionado por DocuGen · ' + new URL(process.env.APP_URL || 'https://docugen-monday-production.up.railway.app').hostname, {
        x:40, y:45, size:8, color:rgb(0.6,0.6,0.6)
      });

      const pdfBytes = await pdfDoc.save();
      const pdfName = filename.replace(/\.\w+$/, '') + (sig.status === 'signed' ? '_firmado' : '') + '.pdf';
      res.set('Content-Disposition', 'attachment; filename="' + pdfName + '"');
      res.set('Content-Type', 'application/pdf');
      res.send(Buffer.from(pdfBytes));
    } catch(e) { logger.error('Download error:', e); res.status(500).send('Error: ' + e.message); }
  });

  // PORTAL - debe ir DESPUÉS de /info y /download
  router.get('/sign/:token', async (req, res) => {
    return res.sendFile(require('path').join(__dirname, '../..', 'public', 'portal.html'));
  });

  router.post('/sign/:token', async (req, res) => {
    const { signature_data, signer_name } = req.body;
    if (!signature_data) return res.status(400).json({ error: 'Firma requerida' });
    // P0-4: reject oversized signature_data to prevent DB abuse
    if (signature_data && signature_data.length > 300000) {
      return res.status(400).json({ error: 'Firma demasiado grande' });
    }
    try {
      const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1 AND status=$2', [req.params.token, 'pending']);
      if (!r.rows.length) return res.status(404).json({ error: 'Link no válido o ya firmado' });
      const sig = r.rows[0];
      if (sig.expires_at && new Date() > new Date(sig.expires_at)) return res.status(400).json({ error: 'Link expirado' });

      const signerIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
      const userAgent = req.headers['user-agent'] || '';
      const finalName = signer_name || sig.signer_name || '';

      // Audit log
      const existingAudit = sig.audit_log || [];
      const auditEntry = { event: 'signed', timestamp: new Date().toISOString(), ip: signerIp, user_agent: userAgent, signer_name: finalName, consent_accepted: true };
      const updatedAudit = JSON.stringify([...existingAudit, auditEntry]);

      await pool.query(
        'UPDATE signature_requests SET status=$1, signature_data=$2, signer_name=$3, signed_at=NOW(), signer_ip=$4, user_agent=$5, audit_log=$6 WHERE token=$7',
        ['signed', signature_data, finalName, signerIp, userAgent, updatedAudit, req.params.token]
      );

      // Responder inmediatamente
      const downloadUrl = (process.env.APP_URL || 'https://docugen-monday-production.up.railway.app') + '/sign/' + req.params.token + '/download';
      res.json({ success: true, message: 'Documento firmado exitosamente', download_url: downloadUrl });

      // Generar PDF firmado en background
      setImmediate(async () => {
        try {
          const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

          // Buscar PDF de LibreOffice
          let pdfData = null;
          if (sig.item_id) {
            const pdfR = await pool.query(
              "SELECT doc_data FROM documents WHERE item_id=$1 AND filename LIKE '%.pdf' AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1",
              [String(sig.item_id)]
            );
            if (pdfR.rows.length) pdfData = pdfR.rows[0].doc_data;
          }
          if (!pdfData && sig.account_id) {
            const pdfR2 = await pool.query(
              "SELECT doc_data FROM documents WHERE account_id=$1 AND filename LIKE '%.pdf' AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1",
              [sig.account_id]
            );
            if (pdfR2.rows.length) pdfData = pdfR2.rows[0].doc_data;
          }

          if (pdfData) {
            const pdfDoc = await PDFDocument.load(pdfData);
            const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const certPage = pdfDoc.addPage([595, 842]);
            const { width, height } = certPage.getSize();
            const sigDate = new Date().toLocaleString('es-MX');
            const signedHash = crypto.createHash('sha256').update(pdfData).digest('hex');

            // Header
            certPage.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: rgb(0.06, 0.12, 0.24) });
            certPage.drawText('CERTIFICADO DE FIRMA DIGITAL', { x: 30, y: height - 38, size: 18, font: helveticaBold, color: rgb(1,1,1) });
            certPage.drawText('Documento firmado electronicamente via DocuGen', { x: 30, y: height - 58, size: 10, font: helvetica, color: rgb(0.8,0.8,0.8) });

            // Badge
            certPage.drawRectangle({ x: 30, y: height - 110, width: 220, height: 22, color: rgb(0.82, 0.97, 0.9) });
            certPage.drawText('DOCUMENTO FIRMADO DIGITALMENTE', { x: 38, y: height - 103, size: 9, font: helveticaBold, color: rgb(0.02, 0.37, 0.25) });

            // Datos
            const rows = [
              ['Documento:', sig.document_filename || ''],
              ['Firmante:', finalName],
              ['Fecha y hora:', sigDate],
              ['Direccion IP:', signerIp],
              ['Metodo:', req.body.signature_type || 'drawn'],
              ['Token:', req.params.token.substring(0,20) + '...'],
            ];
            let rowY = height - 145;
            for (const [label, value] of rows) {
              certPage.drawRectangle({ x: 30, y: rowY - 4, width: 160, height: 22, color: rgb(0.96, 0.96, 0.96) });
              certPage.drawRectangle({ x: 190, y: rowY - 4, width: 375, height: 22, color: rgb(1,1,1) });
              certPage.drawText(label, { x: 36, y: rowY + 4, size: 10, font: helveticaBold, color: rgb(0.3,0.3,0.3) });
              certPage.drawText(String(value).substring(0, 55), { x: 196, y: rowY + 4, size: 10, font: helvetica, color: rgb(0.1,0.1,0.1) });
              rowY -= 26;
            }

            // Firma imagen
            if (signature_data && signature_data.startsWith('data:image')) {
              try {
                const b64 = signature_data.replace(/^data:image\/\w+;base64,/, '');
                const imgBytes = Buffer.from(b64, 'base64');
                const sigImg = signature_data.includes('image/png') ? await pdfDoc.embedPng(imgBytes) : await pdfDoc.embedJpg(imgBytes);
                certPage.drawText('FIRMA:', { x: 30, y: rowY - 10, size: 10, font: helveticaBold, color: rgb(0.3,0.3,0.3) });
                certPage.drawImage(sigImg, { x: 30, y: rowY - 100, width: 200, height: 80 });
                certPage.drawRectangle({ x: 30, y: rowY - 102, width: 204, height: 84, borderColor: rgb(0.8,0.8,0.8), borderWidth: 0.5 });
                rowY -= 120;
              } catch(imgErr) { logger.error('Sig image error:', imgErr.message); }
            }

            // Legal
            rowY -= 20;
            const legalText = 'Firma electronica con validez legal conforme al Codigo de Comercio de Mexico (Art. 89-114) y NOM-151-SCFI-2016.';
            certPage.drawText(legalText, { x: 30, y: rowY, size: 8, font: helvetica, color: rgb(0.4,0.4,0.4) });
            rowY -= 16;
            certPage.drawText('Hash SHA-256: ' + signedHash.substring(0, 48), { x: 30, y: rowY, size: 7, font: helvetica, color: rgb(0.5,0.5,0.5) });

            // Footer
            certPage.drawLine({ start: { x: 30, y: 40 }, end: { x: width - 30, y: 40 }, thickness: 0.5, color: rgb(0.8,0.8,0.8) });
            certPage.drawText('Generado por DocuGen · ' + new Date().toISOString(), { x: 30, y: 26, size: 7, font: helvetica, color: rgb(0.6,0.6,0.6) });

            const pdfBuffer = await pdfDoc.save();
            await pool.query('UPDATE signature_requests SET signed_pdf=$1, signed_hash=$2 WHERE token=$3', [Buffer.from(pdfBuffer), signedHash, req.params.token]);
            logger.debug('PDF firmado generado:', pdfBuffer.length, 'bytes con', pdfDoc.getPageCount(), 'paginas');
          }

          // #6 Email confirmación vía sendEmail
          if (sig.signer_email) {
            sendEmail({
              to:      sig.signer_email,
              subject: 'Documento firmado: ' + escapeHtml(sig.document_filename),
              html:    '<h2>Documento firmado exitosamente</h2><p>Hola <b>' + escapeHtml(finalName) + '</b>, has firmado el documento <b>' + escapeHtml(sig.document_filename) + '</b>.</p><p><a href="' + escapeHtml(downloadUrl) + '">Descargar documento firmado</a></p><p style="color:#666;font-size:12px">Fecha: ' + new Date().toLocaleString('es-MX') + ' · IP: ' + escapeHtml(signerIp) + '</p>',
              type:    'sign_confirm',
            }).catch(emailErr => logger.error('Email confirm error:', emailErr.message));
          }

          // Monday: notificaciones al firmar (usando variables GraphQL — sin injection)
          try {
            const tokenR = await pool.query('SELECT access_token FROM tokens WHERE account_id=$1', [sig.account_id]);
            if (tokenR.rows.length && sig.item_id) {
              const accessToken = decryptToken(tokenR.rows[0].access_token);

              // 1. Crear update con detalles de firma — sin concatenación
              const updateBody = `Documento firmado.\nFirmante: ${finalName}\nFecha: ${new Date().toLocaleString('es-MX')}\nIP: ${signerIp}`;
              await createMondayUpdate(accessToken, sig.item_id, updateBody).catch(e => logger.error({ err: e.message }, 'Monday update error'));

              // 2. Cambiar columna de status si existe — variables GraphQL via mondayQuery
              try {
                const itemData = await mondayQuery(accessToken, `
                  query GetItemBoard($ids: [ID!]!) {
                    items(ids: $ids) { board { id columns { id type title } } }
                  }`, { ids: [String(parseInt(sig.item_id, 10))] });
                const cols = itemData?.items?.[0]?.board?.columns || [];
                const statusCol = cols.find(c => c.type === 'color' && (c.title.toLowerCase().includes('status') || c.title.toLowerCase().includes('estado') || c.title.toLowerCase().includes('firma')));
                if (statusCol) {
                  const boardId = itemData.items[0].board.id;
                  await mondayQuery(accessToken, `
                    mutation ChangeCol($itemId: ID!, $boardId: ID!, $colId: String!, $value: String!) {
                      change_simple_column_value(item_id: $itemId, board_id: $boardId, column_id: $colId, value: $value) { id }
                    }`, { itemId: String(sig.item_id), boardId: String(boardId), colId: statusCol.id, value: 'Firmado' }
                  ).catch(e => logger.error({ err: e.message }, 'Status col update error'));
                }
              } catch(colErr) { logger.error({ err: colErr.message }, 'Status col error'); }

              // 3. Notificar al responsable asignado — variables GraphQL
              try {
                const itemData2 = await mondayQuery(accessToken, `
                  query GetPeople($ids: [ID!]!) {
                    items(ids: $ids) { column_values(types: [people]) { value } }
                  }`, { ids: [String(parseInt(sig.item_id, 10))] });
                const peopleVal = itemData2?.items?.[0]?.column_values?.[0]?.value;
                if (peopleVal) {
                  const parsed = JSON.parse(peopleVal);
                  const personIds = (parsed.personsAndTeams || []).filter(p => p.kind === 'person').map(p => p.id);
                  const notifText = `DocuGen: ${sig.document_filename} fue firmado por ${finalName}.`;
                  for (const pid of personIds) {
                    await mondayQuery(accessToken, `
                      mutation Notify($text: String!, $userId: ID!, $targetId: ID!) {
                        create_notification(text: $text, user_id: $userId, target_id: $targetId, target_type: Project, internal: true) { id }
                      }`, { text: notifText, userId: String(pid), targetId: String(sig.item_id) }
                    ).catch(e => logger.error({ err: e.message }, 'Notification error'));
                  }
                }
              } catch(notifErr) { logger.error({ err: notifErr.message }, 'Notif error'); }
            }
          } catch(mondayErr) { logger.error({ err: mondayErr.message }, 'Monday post-sign error'); }

        } catch(bgErr) { logger.error('Background PDF error:', bgErr.message); }
      }); // end setImmediate

    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── PORTAL LOGO (solo para portal de firmas, separado del logo de documentos) ──
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  // FIX-5: requireAuth added — use req.accountId from auth middleware
  router.post('/portal-logo/upload', requireAuth, upload.single('logo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibio imagen' });
    try {
      await pool.query(
        'INSERT INTO portal_logos (account_id, filename, data, mimetype) VALUES ($1,$2,$3,$4) ON CONFLICT (account_id) DO UPDATE SET filename=$2, data=$3, mimetype=$4, updated_at=NOW()',
        [req.accountId, req.file.originalname, req.file.buffer, req.file.mimetype]
      );
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // FIX-25: CREATE TABLE removed — portal_logos table created in initDB()
  router.get('/portal-logo', async (req, res) => {
    const accountId = req.query.account_id || req.headers['x-account-id'];
    if (!accountId) return res.status(400).json({ error: 'account_id required' });
    try {
      const r = await pool.query('SELECT data, mimetype FROM portal_logos WHERE account_id=$1', [accountId]);
      if (!r.rows.length) return res.status(404).json({ error: 'No hay logo' });
      res.set('Content-Type', r.rows[0].mimetype);
      res.send(r.rows[0].data);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/portal-logo/delete', requireAuth, async (req, res) => {
    try {
      await pool.query('DELETE FROM portal_logos WHERE account_id=$1', [req.accountId]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // FIX-25: CREATE TABLE removed — signature_requests table created in initDB()
  router.get('/signatures', requireAuth, async (req, res) => {
    try {
      const { page, limit, offset } = parsePagination(req.query, 20, 100);
      const [r, countResult] = await Promise.all([
        pool.query(
          'SELECT id, document_filename, signer_name, signer_email, status, signed_at, created_at, token FROM signature_requests WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
          [req.accountId, limit, offset]
        ),
        pool.query('SELECT COUNT(*)::int AS total FROM signature_requests WHERE account_id=$1', [req.accountId]),
      ]);
      const total = countResult.rows[0].total;
      res.json({
        signatures: r.rows,
        pagination:  { page, limit, total, total_pages: Math.ceil(total / limit) },
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── DESCARGAR DOCUMENTO FIRMADO ──────────────────────────
  router.get('/signatures/:token/download', async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1 AND status=$2', [req.params.token, 'signed']);
      if (!r.rows.length) return res.status(404).json({ error: 'Firma no encontrada o pendiente' });
      const sig = r.rows[0];

      // Parsear item_id (puede ser JSON string o string plano)
      let itemId = sig.item_id;
      try { const parsed = JSON.parse(itemId); if (parsed.id) itemId = parsed.id; } catch(e) {}

      // Buscar el documento más reciente del item con doc_data
      const docR = await pool.query(
        'SELECT doc_data, filename FROM documents WHERE account_id=$1 AND item_id=$2 AND doc_data IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        [sig.account_id, itemId]
      );
      if (!docR.rows.length || !docR.rows[0].doc_data) return res.status(404).json({ error: 'Documento no encontrado' });

      const docBuffer = docR.rows[0].doc_data;
      // FIX-19: null check before calling .replace() on signature_data
      if (!sig.signature_data) return res.status(400).json({ error: 'No hay datos de firma' });
      // P2-7: Size check before Buffer.from() to prevent memory exhaustion from corrupt data
      if (sig.signature_data && sig.signature_data.length > 500000) {
        return res.status(400).json({ error: 'Datos de firma corruptos' });
      }
      const sigImgBase64 = sig.signature_data.replace(/^data:image\/png;base64,/, '');
      const sigImgBuffer = Buffer.from(sigImgBase64, 'base64');

      // Insertar firma en el docx via PizZip + XML
      const zip2 = new PizZip(docBuffer);
      let documentXml = zip2.file('word/document.xml').asText();

      // Agregar imagen de firma como relación
      const relsXml = zip2.file('word/_rels/document.xml.rels').asText();
      const sigRelId = 'rIdSig1';
      const newRel = '<Relationship Id="' + sigRelId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/signature.png"/>';
      const updatedRels = relsXml.replace('</Relationships>', newRel + '</Relationships>');
      zip2.file('word/_rels/document.xml.rels', updatedRels);
      zip2.file('word/media/signature.png', sigImgBuffer);

      // FIX-9: XML-escape all user-supplied values before OOXML injection
      const sigXml = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' +
        '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1a1a2e"/></w:rPr><w:t>FIRMA DIGITAL</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>' +
        '<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
        '<wp:extent cx="2743200" cy="914400"/>' +
        '<wp:docPr id="99" name="Firma"/>' +
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:nvPicPr><pic:cNvPr id="99" name="Firma"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:embed="' + sigRelId + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>' +
        '<a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="914400"/></a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
        '</pic:pic></a:graphicData></a:graphic>' +
        '</wp:inline></w:drawing></w:r></w:p>' +
        '<w:p><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>Firmante: ' + xmlEscape(sig.signer_name) + '</w:t></w:r></w:p>' +
        '<w:p><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>Fecha: ' + xmlEscape(new Date(sig.signed_at).toLocaleString('es-MX')) + '</w:t></w:r></w:p>' +
        '<w:p><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>IP: ' + xmlEscape(sig.signer_ip||'N/A') + '</w:t></w:r></w:p>';

      documentXml = documentXml.replace('</w:body>', sigXml + '</w:body>');
      zip2.file('word/document.xml', documentXml);
      const modifiedDocx = zip2.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

      // Convertir a PDF con libreoffice-convert (in-process, async, no execSync)
      try {
        const pdfBuffer = await convertDocxToPdf(modifiedDocx);
        const baseName = docR.rows[0].filename.replace(/\.docx$/i, '');
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `attachment; filename="${baseName}_firmado.pdf"`);
        return res.send(pdfBuffer);
      } catch(e) {
        logger.error({ err: e.message, token: req.params.token.slice(0,8) }, 'PDF conversion error in download');
      }

      // Fallback: devolver el docx modificado si PDF falla
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.set('Content-Disposition', 'attachment; filename="documento_firmado.docx"');
      res.send(modifiedDocx);

    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Ver estado de firma por token
  // FIX-20: signer_ip removed from public endpoint — it's PII and should not be exposed without auth
  router.get('/signatures/:token/status', async (req, res) => {
    try {
      const r = await pool.query('SELECT status, signer_name, signed_at FROM signature_requests WHERE token=$1', [req.params.token]);
      if (!r.rows.length) return res.status(404).json({ error: 'No encontrada' });
      res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── QUOTE RESPONSE ENDPOINT ──
  router.post('/sign/:token/quote-response', async (req, res) => {
    try {
      const { token } = req.params;
      const { response, comment } = req.body; // response: 'accepted' | 'rejected' | 'changes_requested'

      if (!['accepted', 'rejected', 'changes_requested'].includes(response)) {
        return res.status(400).json({ error: 'Respuesta inválida' });
      }

      const sig = await pool.query('SELECT * FROM signature_requests WHERE token=$1', [token]);
      if (!sig.rows.length) return res.status(404).json({ error: 'No encontrado' });
      const s = sig.rows[0];

      if (s.doc_type !== 'quote') return res.status(400).json({ error: 'Este documento no es una cotización' });
      if (s.quote_response) return res.status(400).json({ error: 'Ya respondiste esta cotización' });

      // Registrar respuesta
      await pool.query(
        'UPDATE signature_requests SET quote_response=$1, quote_comment=$2, quote_responded_at=NOW(), status=$3 WHERE token=$4',
        [response, comment || null, response, token]
      );

      // Actualizar item en Monday si hay item_id y token de cuenta
      const tokenRow = await pool.query('SELECT access_token FROM tokens WHERE account_id=$1 LIMIT 1', [s.account_id]);
      if (tokenRow.rows.length && s.item_id) {
        const statusMap = {
          'accepted': 'Cotización Aceptada',
          'rejected': 'Cotización Rechazada',
          'changes_requested': 'Cambios Solicitados'
        };

        // P1-3: createMondayUpdate usa variables GraphQL
        const commentBody = `📄 Cotización ${statusMap[response]}${comment ? ': ' + comment : ''}`;
        try {
          await createMondayUpdate(decryptToken(tokenRow.rows[0].access_token), s.item_id, commentBody);
        } catch(e) { logger.error('Monday update error:', e.message); }
      }

      // Enviar notificación email al owner si hay email registrado
      try {
        const ownerRow = await pool.query('SELECT settings FROM account_settings WHERE account_id=$1', [s.account_id]);
        const ownerEmail = ownerRow.rows[0]?.settings?.email_empresa;
        if (ownerEmail) {
          const responseLabels = {
            'accepted': '✅ Aceptada',
            'rejected': '❌ Rechazada',
            'changes_requested': '💬 Cambios Solicitados'
          };
          await sendEmail({
            to:      ownerEmail,
            subject: `Cotización ${responseLabels[response]} — ${s.signer_name || 'Cliente'}`,
            html:    `<h2>Respuesta de Cotización</h2>
                <p><strong>Cliente:</strong> ${s.signer_name || 'N/A'}</p>
                <p><strong>Email:</strong> ${s.signer_email || 'N/A'}</p>
                <p><strong>Respuesta:</strong> ${responseLabels[response]}</p>
                ${comment ? `<p><strong>Comentario:</strong> ${escapeHtml(comment)}</p>` : ''}
                <p><strong>Fecha:</strong> ${new Date().toLocaleString('es-MX')}</p>`,
            type: 'generic',
          });
        }
      } catch(e) { logger.error('Email notification error:', e.message); }

      res.json({ success: true, response });
    } catch(e) {
      logger.error('Quote response error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Registrar apertura del portal y tiempo
  router.post('/sign/:token/track', async (req, res) => {
    try {
      const { token } = req.params;
      const { event } = req.body; // event: 'opened' | 'heartbeat'

      if (event === 'opened') {
        await pool.query('UPDATE signature_requests SET opened_at=NOW() WHERE token=$1 AND opened_at IS NULL', [token]);
      }
      if (event === 'heartbeat') {
        // FIX-30: Validate time_spent before using in DB update
        const time_spent = parseInt(req.body.time_spent);
        if (!Number.isInteger(time_spent) || time_spent < 0 || time_spent > 3600) {
          return res.status(400).json({ error: 'Invalid time_spent' });
        }
        // P1-7: use LEAST() to cap cumulative total at 86400 seconds (1 day) — prevents integer overflow
        await pool.query('UPDATE signature_requests SET time_on_portal = LEAST(COALESCE(time_on_portal,0) + $1, 86400) WHERE token=$2', [time_spent, token]);
      }
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── SISTEMA DE FIRMA AVANZADO ────────────────────────────
  // Múltiples firmantes con orden
  router.post('/signatures/request-multi', requireAuth, checkSigLimit, async (req, res) => {
    const { document_filename, signers, item_id, board_id } = req.body;
    // signers = [{name, email, order}, ...]
    if (!signers || !signers.length) return res.status(400).json({ error: 'Se requieren firmantes' });
    try {
      const groupId = crypto.randomBytes(16).toString('hex');
      const tokens = [];

      for (const signer of signers) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        // P2-2/P2-3: crypto OTP + stored as HMAC hash (same pattern as single-signer flow)
        const rawOtp = generateOtp();
        const otpHash = hashOtp(rawOtp, token);
        const order = signer.order || 1;

        await pool.query(
          'INSERT INTO signature_requests (token, account_id, document_filename, signer_name, signer_email, item_id, board_id, expires_at, signer_order, group_id, otp_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [token, req.accountId, document_filename, signer.name, signer.email, item_id, board_id, expiresAt, order, groupId, otpHash]
        );

        const signUrl = process.env.APP_URL + '/sign/' + token;

        // Solo enviar email al primero en el orden
        if (order === 1 && signer.email) {
          sendEmail({
            to:      signer.email,
            subject: 'Documento pendiente de tu firma — ' + document_filename,
            html:    emailSignRequest(signer.name, document_filename, signUrl, expiresAt),
            type:    'sign_request',
          }).catch(e => logger.error('Email error:', e.message));
        }
        tokens.push({ name: signer.name, email: signer.email, order, token, sign_url: signUrl });
      }

      res.json({ success: true, group_id: groupId, signers: tokens });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // FIX-12: requireAuth + account scoping to protect audit certificate PII
  router.get('/signatures/group/:groupId/certificate', requireAuth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM signature_requests WHERE group_id=$1 AND account_id=$2 ORDER BY signer_order ASC', [req.params.groupId, req.accountId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Grupo no encontrado' });

      const htmlPdf = require('html-pdf-node');
      const certHtml = generateAuditCertificate(r.rows);
      const pdfBuffer = await htmlPdf.generatePdf({ content: certHtml }, {
        format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }, printBackground: true
      });

      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="certificado_auditoria.pdf"');
      res.send(pdfBuffer);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── SEND REMINDER ───────────────────────────────────────────────────────────
  router.post('/sign/:token/remind', requireAuth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM signature_requests WHERE token=$1 AND account_id=$2', [req.params.token, req.accountId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Documento no encontrado' });
      const sig = r.rows[0];
      if (sig.status === 'signed') return res.status(400).json({ error: 'El documento ya fue firmado' });
      if (!sig.signer_email) return res.status(400).json({ error: 'El firmante no tiene email registrado' });

      const portalUrl = (process.env.APP_URL || 'https://docugen-monday-production.up.railway.app') + '/sign/' + sig.token;
      const expiresText = sig.expires_at ? new Date(sig.expires_at).toLocaleDateString('es-MX') : 'pronto';

      // #6 Email al firmante vía sendEmail
      await sendEmail({
        to:      sig.signer_email,
        subject: 'Recordatorio: documento pendiente de tu firma',
        html:    '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px"><h2 style="color:#1a1a1a">Tienes un documento pendiente de firma</h2><p>Hola <strong>' + escapeHtml(sig.signer_name) + '</strong>,</p><p>Te recordamos que el documento <strong>' + escapeHtml(sig.document_filename) + '</strong> sigue pendiente de tu firma.</p><p style="color:#e55;">Este enlace expira el ' + escapeHtml(expiresText) + '.</p><div style="margin:32px 0;text-align:center"><a href="' + escapeHtml(portalUrl) + '" style="background:#1a1a1a;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px">Firmar ahora</a></div></div>',
        type: 'reminder',
      });

      // Notificación en Monday si hay item_id
      if (sig.item_id) {
        try {
          const tokenRow = await pool.query('SELECT access_token FROM tokens WHERE account_id=$1 LIMIT 1', [req.accountId]);
          if (tokenRow.rows.length) {
            const remindToken = decryptToken(tokenRow.rows[0].access_token);
            const remindBody = `Recordatorio enviado a ${sig.signer_name} (${sig.signer_email}) para firmar ${sig.document_filename}.`;
            await createMondayUpdate(remindToken, sig.item_id, remindBody).catch(e => logger.error({ err: e.message }, 'Monday remind error'));
          }
        } catch(e) { logger.error({ err: e.message }, 'Monday remind error'); }
      }

      // Registrar en audit log
      try {
        const existing = JSON.parse(sig.audit_log || '[]');
        existing.push({ event: 'reminder_sent', timestamp: new Date().toISOString(), to: sig.signer_email });
        await pool.query('UPDATE signature_requests SET audit_log=$1 WHERE token=$2', [JSON.stringify(existing), sig.token]);
      } catch(e) {}

      res.json({ success: true, sent_to: sig.signer_email });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Cancel a pending signature request ──────────────────────────────────
  router.post('/signatures/:token/cancel', requireAuth, async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT id, account_id, status, signer_name FROM signature_requests WHERE token=$1",
        [req.params.token]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
      const sig = r.rows[0];
      if (sig.account_id !== req.accountId) return res.status(403).json({ error: 'Sin permiso' });
      if (sig.status !== 'pending') return res.status(400).json({ error: 'Solo se pueden cancelar solicitudes pendientes' });

      await pool.query(
        "UPDATE signature_requests SET status='cancelled', audit_log=audit_log || $1::jsonb WHERE token=$2",
        [JSON.stringify([{ event:'cancelled', timestamp: new Date().toISOString(), by: req.accountId }]), req.params.token]
      );
      logger.info({ token: req.params.token, accountId: req.accountId, signer: sig.signer_name }, 'Signature request cancelled');
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
