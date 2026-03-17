'use strict';

const jwt = require('jsonwebtoken');

// JWT verification helper for Monday Workflow action blocks
function verifyWorkflowJWT(req) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '');
    if (!token) return null;
    return jwt.verify(token, process.env.MONDAY_SIGNING_SECRET || process.env.MONDAY_CLIENT_SECRET || '');
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
