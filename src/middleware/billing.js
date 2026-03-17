'use strict';

const { checkSubscription, getAccountPlanLimits, getMonthlyUsage } = require('../services/billing.service');

// Middleware: verificar suscripción activa
async function requireSubscription(req, res, next) {
  try {
    const accountId = req.accountId;
    if (!accountId) return next(); // Sin accountId, dejar pasar (manejado por requireAuth)
    const { pool } = require('../services/db.service');
    const r = await pool.query("SELECT * FROM subscriptions WHERE account_id=$1 AND status IN ('active','trial') ORDER BY created_at DESC LIMIT 1", [accountId]);
    if (!r.rows.length) {
      return res.status(402).json({
        error: 'subscription_required',
        message: 'Se requiere una suscripción activa para usar DocuGen.',
        upgrade_url: 'https://monday.com/marketplace'
      });
    }
    req.subscription = r.rows[0];
    next();
  // FIX-17: fail CLOSED — DB errors must not grant access
  } catch(e) { return res.status(500).json({ error: 'Error verificando suscripción.' }); }
}

// Middleware: verificar límite de documentos
async function checkDocLimit(req, res, next) {
  try {
    const accountId = req.accountId || req.body?.account_id || req.query?.account_id;
    if (!accountId) return next(); // Sin accountId, dejar pasar
    const sub = await checkSubscription(accountId);
    if (!sub.allowed) {
      const msg = sub.reason === 'trial_expired'
        ? 'Tu periodo de prueba ha expirado. Actualiza tu plan.'
        : sub.reason === 'docs_limit_reached'
          ? 'Limite de documentos alcanzado (' + sub.docs_used + '/' + sub.docs_limit + '). Actualiza tu plan.'
          : 'Suscripcion inactiva. Actualiza tu plan.';
      // P2-5: upgrade_url debe apuntar al marketplace de Monday, no a un sitio externo
      // Ref: https://developer.monday.com/apps/docs/monetization
      return res.status(402).json({ error: sub.reason, message: msg, upgrade_url: 'https://monday.com/marketplace' });
    }
    next();
  } catch(e) {
    console.error('checkDocLimit error:', e.message);
    // P1-8: fail CLOSED — error en verificación no debe dar acceso gratis
    return res.status(500).json({ error: 'Error verificando suscripción. Intenta de nuevo.' });
  }
}

// Middleware: verificar límite de firmas
async function checkSigLimit(req, res, next) {
  try {
    const limits = await getAccountPlanLimits(req.accountId);
    if (!limits) return next();
    if (limits.sigs === -1) return next();
    const usage = await getMonthlyUsage(req.accountId);
    if (usage.sigs >= limits.sigs) {
      return res.status(402).json({
        error: 'sig_limit_reached',
        message: 'Has alcanzado el límite de firmas de tu plan (' + limits.sigs + '/mes). Actualiza tu plan para continuar.',
        current_usage: usage.sigs,
        limit: limits.sigs
      });
    }
    next();
  // FIX-17: fail CLOSED — DB errors must not grant access
  } catch(e) { return res.status(500).json({ error: 'Error verificando suscripción.' }); }
}

module.exports = { checkDocLimit, checkSigLimit, requireSubscription };
