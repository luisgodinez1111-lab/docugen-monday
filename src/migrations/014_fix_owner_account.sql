-- 014_fix_owner_account.sql — Fix owner account id and ensure enterprise plan
DELETE FROM subscriptions WHERE account_id = '18402626437';

INSERT INTO subscriptions (account_id, plan_id, status, docs_used, docs_limit, is_trial, subscribed_at, updated_at)
VALUES ('242041401', 'enterprise', 'active', 0, 999999, false, NOW(), NOW())
ON CONFLICT (account_id) DO UPDATE
  SET plan_id    = 'enterprise',
      status     = 'active',
      docs_limit = 999999,
      is_trial   = false,
      updated_at = NOW();
