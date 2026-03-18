'use strict';

const { pool }                         = require('./db.service');
const { cacheGet, cacheSet, cacheDel } = require('./cache.service');
const { TRIAL_DURATION_MS, SUBSCRIPTION_CACHE_TTL, LIMITS_CACHE_TTL } = require('../utils/config');

// ── PLAN LIMITS MAP ──
const PLAN_LIMITS = {
  trial:        { docs: 10,    sigs: 5,    templates: 2,   doc_types: ['document'],                          branding: false, workflows: false, legal: false, multisign: false },
  starter:      { docs: 50,    sigs: 25,   templates: 5,   doc_types: ['document','simple'],                 branding: false, workflows: false, legal: false, multisign: false },
  professional: { docs: 200,   sigs: 100,  templates: 20,  doc_types: ['document','simple','quote','legal'], branding: true,  workflows: true,  legal: true,  multisign: false },
  business:     { docs: 1000,  sigs: 500,  templates: -1,  doc_types: ['document','simple','quote','legal'], branding: true,  workflows: true,  legal: true,  multisign: true  },
  enterprise:   { docs: -1,    sigs: -1,   templates: -1,  doc_types: ['document','simple','quote','legal'], branding: true,  workflows: true,  legal: true,  multisign: true  },
};

function getPlanLimits(planId) {
  const plans = {
    trial:        { docs_limit: 10,     label: 'Trial' },
    starter:      { docs_limit: 50,     label: 'Starter' },
    professional: { docs_limit: 150,    label: 'Professional' },
    business:     { docs_limit: 500,    label: 'Business' },
    enterprise:   { docs_limit: 999999, label: 'Enterprise' },
  };
  return plans[planId?.toLowerCase()] || { docs_limit: 10, label: 'Trial' };
}

// ── CHECK SUBSCRIPTION ──
async function checkSubscription(accountId) {
  const cacheKey = `sub:${accountId}`;
  try {
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const result = await pool.query(
      "SELECT * FROM subscriptions WHERE account_id=$1 AND status IN ('active','trial') ORDER BY created_at DESC LIMIT 1",
      [accountId]
    );

    if (result.rows.length === 0) {
      const trialEnds = new Date(Date.now() + TRIAL_DURATION_MS);
      await pool.query(
        'INSERT INTO subscriptions (account_id, plan_id, status, docs_used, docs_limit, trial_ends_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id) DO NOTHING',
        [accountId, 'trial', 'trial', 0, 10, trialEnds]
      );
      const sub = { allowed: true, plan: 'trial', docs_used: 0, docs_limit: 10, trial_ends_at: trialEnds };
      await cacheSet(cacheKey, sub, SUBSCRIPTION_CACHE_TTL);
      return sub;
    }

    const sub = result.rows[0];

    if (sub.status === 'trial' && sub.trial_ends_at && new Date(sub.trial_ends_at) < new Date()) {
      await pool.query("UPDATE subscriptions SET status='expired' WHERE account_id=$1", [accountId]);
      await cacheDel(cacheKey);
      return { allowed: false, reason: 'trial_expired', plan: 'trial' };
    }

    if (sub.docs_used >= sub.docs_limit) {
      return { allowed: false, reason: 'docs_limit_reached', plan: sub.plan_id, docs_used: sub.docs_used, docs_limit: sub.docs_limit };
    }

    const response = { allowed: true, plan: sub.plan_id, status: sub.status, docs_used: sub.docs_used, docs_limit: sub.docs_limit };
    await cacheSet(cacheKey, response, SUBSCRIPTION_CACHE_TTL);
    return response;

  } catch (e) {
    // Fail CLOSED — a DB error must NOT grant billing access
    try { require('./logger.service').error({ err: e.message, accountId }, 'checkSubscription DB error — failing closed'); } catch {}
    return { allowed: false, reason: 'subscription_check_error', plan: 'unknown' };
  }
}

// ── INCREMENT DOCS USED ──
async function incrementDocsUsed(accountId) {
  try {
    await pool.query(
      'UPDATE subscriptions SET docs_used = docs_used + 1, updated_at = NOW() WHERE account_id=$1',
      [accountId]
    );
    await cacheDel(`sub:${accountId}`);
  } catch (e) {
    try { require('./logger.service').error({ err: e.message, accountId }, 'incrementDocsUsed error'); } catch {}
  }
}

// ── GET ACCOUNT PLAN LIMITS — throws on DB error (fail-closed) ──
async function getAccountPlanLimits(accountId) {
  const cacheKey = `limits:${accountId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const r = await pool.query(
    "SELECT plan_id FROM subscriptions WHERE account_id=$1 AND status IN ('active','trial') ORDER BY created_at DESC LIMIT 1",
    [accountId]
  );
  if (!r.rows.length) return null;
  const key = (r.rows[0].plan_id || 'trial').toLowerCase().replace(/[^a-z]/g, '');
  const limits = PLAN_LIMITS[key] || PLAN_LIMITS.trial;
  await cacheSet(cacheKey, limits, LIMITS_CACHE_TTL);
  return limits;
}

// ── GET MONTHLY USAGE — throws on DB error (never silently grant zero usage) ──
async function getMonthlyUsage(accountId) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM documents          WHERE account_id=$1 AND created_at >= $2) AS docs,
       (SELECT COUNT(*) FROM signature_requests WHERE account_id=$1 AND created_at >= $2) AS sigs`,
    [accountId, startOfMonth]
  );
  return {
    docs: parseInt(result.rows[0].docs),
    sigs: parseInt(result.rows[0].sigs),
  };
}

module.exports = { PLAN_LIMITS, getPlanLimits, checkSubscription, incrementDocsUsed, getAccountPlanLimits, getMonthlyUsage };
