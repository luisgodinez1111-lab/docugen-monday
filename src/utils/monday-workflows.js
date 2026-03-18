'use strict';

const jwt = require('jsonwebtoken');

// JWT verification helper for Monday Workflow action blocks
// FIX-22: Remove || '' fallback — throw if secret is not set to prevent empty-secret forgery
function verifyWorkflowJWT(req) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '');
    if (!token) return null;
    const secret = process.env.MONDAY_SIGNING_SECRET || process.env.MONDAY_CLIENT_SECRET;
    if (!secret) throw new Error('MONDAY_SIGNING_SECRET is required');
    // Enforce exp, alg whitelist, and app-id audience when configured
    const verifyOpts = { algorithms: ['HS256'], clockTolerance: 0 };
    if (process.env.MONDAY_APP_ID) verifyOpts.audience = String(process.env.MONDAY_APP_ID);
    return jwt.verify(token, secret, verifyOpts);
  } catch(e) { return null; }
}

// ── SEVERITY CODES (Monday Workflows Action Blocks) ──
// Según docs: https://developer.monday.com/apps/docs/error-handling
function severityError(code, title, description, runtimeDesc, disableDesc) {
  const body = {
    severityCode: code,
    notificationErrorTitle: title,
    notificationErrorDescription: description,
    runtimeErrorDescription: runtimeDesc
  };
  if (code === 6000 && disableDesc) body.disableErrorDescription = disableDesc;
  return body;
}
// Uso: res.status(500).json(severityError(4000, 'Error', 'Desc', 'Log desc'))
// 4000 = error recuperable (automation puede volver a correr)
// 6000 = error permanente (automation se deshabilita)

module.exports = { verifyWorkflowJWT, severityError };
