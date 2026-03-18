-- Migration 010: audit_log table + improved webhook_events index with attempts filter

-- Account-level audit trail (settings changed, templates uploaded/deleted, triggers configured)
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  account_id  TEXT        NOT NULL,
  action      TEXT        NOT NULL,         -- e.g. 'template.upload', 'settings.update', 'trigger.create'
  actor_id    TEXT,                          -- account_id or user identifier
  details     JSONB       DEFAULT '{}',
  ip          TEXT,
  created_at  TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_account_created
  ON audit_log(account_id, created_at DESC);

-- Improve webhook_events pending query — adds attempts to the partial index
-- processPendingTriggers() queries: event_type='trigger_fired' AND column_value='pending' AND attempts < N
CREATE INDEX IF NOT EXISTS idx_webhook_events_pending
  ON webhook_events(account_id, item_id, attempts)
  WHERE event_type = 'trigger_fired' AND column_value = 'pending';

-- Quota notification tracking: prevent duplicate quota alert emails per threshold
-- Uses the cache (Redis/memory) but this table is a durable fallback
CREATE TABLE IF NOT EXISTS quota_notifications (
  account_id  TEXT    NOT NULL,
  threshold   INT     NOT NULL,             -- 80 or 100
  sent_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, threshold)
);
