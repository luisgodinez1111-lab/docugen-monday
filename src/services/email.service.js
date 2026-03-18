'use strict';

const { Resend } = require('resend');
const { resendBreaker } = require('../utils/circuit-breaker');
const { emailSignRequest, emailQuotaAlert } = require('../utils/email-templates');
const { escapeHtml } = require('../utils/strings');

// Lazy init — RESEND_API_KEY may not be set in dev/test; instantiate only when sending
let _resend = null;
function getResend() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

let enqueueEmailJob = null;
try {
  enqueueEmailJob = require('../queues/email.queue').enqueueEmailJob;
} catch { /* Redis not configured — direct send fallback is used */ }

/**
 * Sends an email via BullMQ queue (async, retried) when Redis is available,
 * or directly via Resend when Redis is not configured.
 * @param {{ to: string|string[], subject: string, html: string, from?: string, type?: string, accountId?: string, token?: string }} payload
 */
async function sendEmail(payload) {
  if (typeof enqueueEmailJob === 'function') {
    const jobId = await enqueueEmailJob({
      type: 'generic',
      ...payload,
    }).catch(() => null);
    if (jobId !== null) return; // successfully queued
  }
  // Fallback: direct send (Redis unavailable or queue error)
  await resendBreaker.call(() =>
    getResend().emails.send({
      from:    payload.from || process.env.SMTP_FROM || 'DocuGen <onboarding@resend.dev>',
      to:      Array.isArray(payload.to) ? payload.to : [payload.to],
      subject: payload.subject,
      html:    payload.html,
    })
  );
}

/**
 * Send signature request email to a signer.
 * P0-1 fix: was called but never defined.
 */
async function sendSignatureEmail(email, name, url, docName) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await sendEmail({
    to:      email,
    subject: `Documento pendiente de tu firma — ${escapeHtml(docName)}`,
    html:    emailSignRequest(escapeHtml(name), escapeHtml(docName), escapeHtml(url), expiresAt),
    type:    'sign_request',
  });
}

/**
 * Notify each account admin that a legal document needs approval.
 * P0-1 fix: was called but never defined.
 */
async function sendApprovalEmails(admins, approvalToken, docName, signerName, accountId) {
  // Sanitize token to only allow hex chars (approvalToken is randomBytes hex)
  const safeToken = String(approvalToken || '').replace(/[^a-zA-Z0-9_\-]/g, '');
  const approvalUrl = (process.env.APP_URL || '') + '/approve/' + safeToken;
  const targets = admins.length > 0
    ? admins
    : process.env.ADMIN_EMAIL ? [{ email: process.env.ADMIN_EMAIL, name: 'Admin' }] : [];
  for (const admin of targets) {
    try {
      await sendEmail({
        to:      admin.email,
        subject: `Aprobación requerida: ${escapeHtml(docName)}`,
        html:    `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:system-ui,sans-serif;background:#f5f5f5;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#f59e0b;padding:24px 28px">
      <div style="color:white;font-size:20px;font-weight:700">DocuGen · Aprobación pendiente</div>
    </div>
    <div style="padding:28px">
      <p style="color:#444;font-size:14px;margin:0 0 16px">Hola <b>${escapeHtml(admin.name || 'Admin')}</b>,</p>
      <p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 20px">
        <b>${escapeHtml(signerName)}</b> ha solicitado firma en el documento <b>${escapeHtml(docName)}</b>.
        Tu aprobación es requerida antes de enviarlo al firmante.
      </p>
      <a href="${escapeHtml(approvalUrl)}" style="display:block;text-align:center;background:#f59e0b;color:white;text-decoration:none;padding:13px;border-radius:8px;font-size:14px;font-weight:600">✅ Revisar y aprobar</a>
    </div>
  </div>
</body></html>`,
        type: 'approval',
      });
    } catch(e) { console.error('Approval email failed to:', admin.email, e.message); }
  }
}

/**
 * Notify account owner when their document quota hits 80% or 100%.
 */
async function sendQuotaAlert(email, { docsUsed, docsLimit, pct }) {
  const upgradeUrl = process.env.APP_URL ? process.env.APP_URL + '/view?tab=ajustes' : '';
  await sendEmail({
    to:      email,
    subject: pct >= 100 ? '🚨 DocuGen — Límite de documentos alcanzado' : '⚠️ DocuGen — Acercándote al límite de documentos',
    html:    emailQuotaAlert(pct, docsUsed, docsLimit, upgradeUrl),
    type:    'quota_alert',
  });
}

module.exports = { sendEmail, sendSignatureEmail, sendApprovalEmails, sendQuotaAlert };
