-- Migration 005: Automation max-attempts tracking
-- Fixes infinite retry loop in processPendingTriggers()

ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS attempts   INT DEFAULT 0;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Index for the updated query that filters on attempts < 3
CREATE INDEX IF NOT EXISTS idx_webhook_events_pending_attempts
  ON webhook_events(account_id, attempts)
  WHERE event_type = 'trigger_fired' AND column_value = 'pending';
