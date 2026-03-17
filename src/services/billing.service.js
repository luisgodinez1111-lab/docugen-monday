'use strict';

const { pool } = require('./db.service');

// ── PLAN LIMITS MAP ──
const PLAN_LIMITS = {
  trial:        { docs: 10,    sigs: 5,    templates: 2,   doc_types: ['document'],                              branding: false, workflows: false, legal: false, multisign: false },
  starter:      { docs: 50,    sigs: 25,   templates: 5,   doc_types: ['document','simple'],                     branding: false, workflows: false, legal: false, multisign: false },
  professional: { docs: 200,   sigs: 100,  templates: 20,  doc_types: ['document','simple','quote','legal'],     branding: true,  workflows: true,  legal: true,  multisign: false },
  business:     { docs: 1000,  sigs: 500,  templates: -1,  doc_types: ['document','simple','quote','legal'],     branding: true,  workflows: true,  legal: true,  multisign: true  },
  enterprise:   { docs: -1,    sigs: -1,   templates: -1,  doc_types: ['document','simple','quote','legal'],     branding: true,  workflows: true,  legal: true,  multisign: true  },
};

function getPlanLimits(planId) {
  const plans = {
    'trial':        { docs_limit: 10,     label: 'Trial' },
    'starter':      { docs_limit: 50,     label: 'Starter' },
    'professional': { docs_limit: 150,    label: 'Professional' },
    'business':     { docs_limit: 500,    label: 'Business' },
    'enterprise':   { docs_limit: 999999, label: 'Enterprise' },
  };
  return plans[planId?.toLowerCase()] || { docs_limit: 10, label: 'Trial' };
}

// ── CHECK SUBSCRIPTION (valida plan activo antes de cada operación) ──
async function checkSubscription(accountId) {
  try {
    const result = await pool.query(
      'SELECT * FROM subscriptions WHERE account_id=$1 AND status IN ($2,$3) ORDER BY created_at DESC LIMIT 1',
      [accountId, 'active', 'trial']
    );

    if (result.rows.length === 0) {
      // No hay suscripción — crear trial automáticamente al primer uso
      const trialEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 días
      await pool.query(
        'INSERT INTO subscriptions (account_id, plan_id, status, docs_used, docs_limit, trial_ends_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id) DO NOTHING',
        [accountId, 'trial', 'trial', 0, 10, trialEnds]
      );
      return { allowed: true, plan: 'trial', docs_used: 0, docs_limit: 10, trial_ends_at: trialEnds };
    }

    const sub = result.rows[0];

    // Verificar si el trial expiró
    if (sub.status === 'trial' && sub.trial_ends_at && new Date(sub.trial_ends_at) < new Date()) {
      await pool.query('UPDATE subscriptions SET status=$1 WHERE account_id=$2', ['expired', accountId]);
      return { allowed: false, reason: 'trial_expired', plan: 'trial' };
    }

    // Verificar límite de documentos
    if (sub.docs_used >= sub.docs_limit) {
      return { allowed: false, reason: 'docs_limit_reached', plan: sub.plan_id, docs_used: sub.docs_used, docs_limit: sub.docs_limit };
    }

    return { allowed: true, plan: sub.plan_id, status: sub.status, docs_used: sub.docs_used, docs_limit: sub.docs_limit };
  } catch(e) {
    console.error('checkSubscription error:', e.message);
    // P1-8: fail CLOSED para billing — un error de DB no debe regalar acceso
    return { allowed: false, reason: 'subscription_check_error', plan: 'unknown' };
  }
}

// ── INCREMENT DOCS USED ──
async function incrementDocsUsed(accountId) {
  try {
    await pool.query(
      'UPDATE subscriptions SET docs_used = docs_used + 1, updated_at = NOW() WHERE account_id = $1',
      [accountId]
    );
  } catch(e) {
    console.error('incrementDocsUsed error:', e.message);
  }
}

// Obtener límites del plan activo para una cuenta
async function getAccountPlanLimits(accountId) {
  try {
    const r = await pool.query('SELECT * FROM subscriptions WHERE account_id=$1 AND status IN ($2,$3) ORDER BY created_at DESC LIMIT 1', [accountId, 'active', 'trial']);
    if (!r.rows.length) return null; // Sin suscripción
    const sub = r.rows[0];
    const planId = sub.plan_id || 'trial';
    // Normalizar plan_id a clave de PLAN_LIMITS
    const key = planId.toLowerCase().replace(/[^a-z]/g, '');
    return PLAN_LIMITS[key] || PLAN_LIMITS['trial'];
  } catch(e) { return PLAN_LIMITS['trial']; }
}

// Obtener uso mensual actual de una cuenta
async function getMonthlyUsage(accountId) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  try {
    const docs = await pool.query("SELECT COUNT(*) FROM documents WHERE account_id=$1 AND created_at >= $2", [accountId, startOfMonth]);
    const sigs = await pool.query("SELECT COUNT(*) FROM signature_requests WHERE account_id=$1 AND created_at >= $2", [accountId, startOfMonth]);
    return {
      docs: parseInt(docs.rows[0].count),
      sigs: parseInt(sigs.rows[0].count)
    };
  } catch(e) { return { docs: 0, sigs: 0 }; }
}

module.exports = { PLAN_LIMITS, getPlanLimits, checkSubscription, incrementDocsUsed, getAccountPlanLimits, getMonthlyUsage };
