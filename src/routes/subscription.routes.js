'use strict';
const { Router } = require('express');

module.exports = function makeSubscriptionRouter(deps) {
  const {
    pool, requireAuth, logger,
    checkSubscription, getPlanLimits, getAccountPlanLimits, getMonthlyUsage,
    verifyMondayHmac, processDeletionQueue,
  } = deps;
  const router = Router();

  // ── SUBSCRIPTION STATUS ──
  // P2-10: requireAuth added — plan info must not be exposed without authentication
  router.get('/subscription/status', requireAuth, async (req, res) => {
    const status = await checkSubscription(req.accountId);
    res.json(status);
  });

  // FIX-13: verifyMondayHmac added — unauthenticated endpoint allowed arbitrary account deletion
  // FIX-25: CREATE TABLE removed — deletion_queue table created in initDB()
  router.post('/lifecycle/uninstall', verifyMondayHmac({ allowChallenge: false }), async (req, res) => {
    try {
      const { accountId } = req.body;
      if (!accountId) return res.status(400).json({ error: 'accountId required' });

      await pool.query(
        `INSERT INTO deletion_queue (account_id, scheduled_for)
         VALUES ($1, NOW() + INTERVAL '10 days')
         ON CONFLICT (account_id) DO UPDATE SET scheduled_for = NOW() + INTERVAL '10 days', executed_at = NULL`,
        [accountId]
      );

      logger.info('Uninstall queued for account:', accountId);
      res.status(200).json({ success: true });
    } catch(e) {
      logger.error('Uninstall webhook error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── APP LIFECYCLE EVENTS (Monday.com) ──
  router.post('/monday/lifecycle', verifyMondayHmac({ allowChallenge: false }), async (req, res) => {

    // Responder 200 inmediatamente según docs
    res.sendStatus(200);

    try {
      const { type, data } = req.body;
      if (!type || !data) return;

      // account_id viene directamente en data según docs
      const accountId = data.account_id?.toString();
      const userId = data.user_id?.toString();
      const planId = data.subscription?.plan_id;
      const isTrial = data.subscription?.is_trial;
      const renewalDate = data.subscription?.renewal_date;

      logger.info('Lifecycle event:', type, 'account:', accountId, 'plan:', planId);

      // FIX-25: CREATE TABLE statements removed — tables created in initDB()
      await pool.query(
        'INSERT INTO lifecycle_events (event_type, account_id, user_id, plan_id, is_trial, renewal_date, data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [type, accountId, userId, planId, isTrial, renewalDate, JSON.stringify(data)]
      );

      if (type === 'install') {
        // Inicializar settings por defecto
        await pool.query(
          `INSERT INTO account_settings (account_id, settings) VALUES ($1,$2) ON CONFLICT (account_id) DO NOTHING`,
          [accountId, JSON.stringify({ language: 'es', date_format: 'es-MX', timezone: 'America/Mexico_City' })]
        );
        // Registrar suscripción del install
        if (planId) {
          await pool.query(
            'INSERT INTO subscriptions (account_id, plan_id, status, is_trial, renewal_date) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id) DO UPDATE SET plan_id=$2, status=$3, is_trial=$4, renewal_date=$5, updated_at=NOW()',
            [accountId, planId, 'active', isTrial || false, renewalDate]
          );
        }
      }

      if (type === 'uninstall') {
        await pool.query('DELETE FROM tokens WHERE account_id=$1', [accountId]);
        await pool.query("UPDATE subscriptions SET status='uninstalled', updated_at=NOW() WHERE account_id=$1", [accountId]);
      }

      if (['app_subscription_created', 'app_subscription_changed', 'app_subscription_renewed', 'app_trial_subscription_started'].includes(type)) {
        const _limits = getPlanLimits(planId);
        await pool.query(
          `INSERT INTO subscriptions (account_id, plan_id, status, is_trial, renewal_date, docs_limit, docs_used)
           VALUES ($1,$2,$3,$4,$5,$6,0)
           ON CONFLICT (account_id) DO UPDATE SET
             plan_id=$2, status=$3, is_trial=$4, renewal_date=$5,
             docs_limit=$6, docs_used=0, updated_at=NOW()`,
          [accountId, planId, 'active', isTrial || false, renewalDate, _limits.docs_limit]
        );
      }

      if (['app_subscription_cancelled', 'app_trial_subscription_ended'].includes(type)) {
        await pool.query("UPDATE subscriptions SET status='cancelled', updated_at=NOW() WHERE account_id=$1", [accountId]);
      }

      if (type === 'app_subscription_cancelled_by_user') {
        // Suscripción sigue activa hasta renewal_date
        await pool.query("UPDATE subscriptions SET status='cancelling', updated_at=NOW() WHERE account_id=$1", [accountId]);
      }

      if (type === 'app_subscription_cancellation_revoked_by_user') {
        await pool.query("UPDATE subscriptions SET status='active', updated_at=NOW() WHERE account_id=$1", [accountId]);
      }

      if (['app_subscription_renewal_attempt_failed', 'app_subscription_renewal_failed'].includes(type)) {
        await pool.query("UPDATE subscriptions SET status='payment_failed', updated_at=NOW() WHERE account_id=$1", [accountId]);
      }

    } catch(e) {
      logger.error('Lifecycle error:', e.message);
    }
  });

  // Ver estado de suscripción de una cuenta
  // FIX-25: CREATE TABLE removed — subscriptions table created in initDB()
  router.get('/subscription', requireAuth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM subscriptions WHERE account_id=$1', [req.accountId]);
      res.json({ subscription: r.rows[0] || null });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── BILLING / PLAN ENFORCEMENT ──────────────────────────────────────────────

  // Endpoint: obtener uso y plan actual
  router.get('/billing/usage', requireAuth, async (req, res) => {
    try {
      const sub = await pool.query("SELECT * FROM subscriptions WHERE account_id=$1 AND status IN ('active','trial') ORDER BY subscribed_at DESC LIMIT 1", [req.accountId]);
      const limits = await getAccountPlanLimits(req.accountId);
      const usage = await getMonthlyUsage(req.accountId);
      const planId = sub.rows[0]?.plan_id || 'none';

      res.json({
        success: true,
        plan: planId,
        status: sub.rows[0]?.status || 'inactive',
        is_trial: sub.rows[0]?.is_trial || false,
        renewal_date: sub.rows[0]?.renewal_date || null,
        billing_period: sub.rows[0]?.billing_period || null,
        usage: {
          docs: { used: usage.docs, limit: limits?.docs ?? 0, unlimited: limits?.docs === -1 },
          sigs: { used: usage.sigs, limit: limits?.sigs ?? 0, unlimited: limits?.sigs === -1 },
        },
        features: limits || {}
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
