-- Migration 003: Core indexes
-- Idempotent: uses CREATE INDEX IF NOT EXISTS

CREATE INDEX IF NOT EXISTS idx_tokens_account        ON tokens(account_id);
CREATE INDEX IF NOT EXISTS idx_templates_account     ON templates(account_id);
CREATE INDEX IF NOT EXISTS idx_documents_account     ON documents(account_id);
CREATE INDEX IF NOT EXISTS idx_documents_item        ON documents(item_id);
CREATE INDEX IF NOT EXISTS idx_sigs_account          ON signature_requests(account_id);
CREATE INDEX IF NOT EXISTS idx_sigs_token            ON signature_requests(token);
CREATE INDEX IF NOT EXISTS idx_sigs_group            ON signature_requests(group_id);
CREATE INDEX IF NOT EXISTS idx_sigs_status           ON signature_requests(status);
CREATE INDEX IF NOT EXISTS idx_pdf_jobs_account      ON pdf_jobs(account_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account ON subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_deletion_queue_sched  ON deletion_queue(scheduled_for) WHERE executed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_triggers_acct ON webhook_triggers(account_id);
CREATE INDEX IF NOT EXISTS idx_sched_autos_account   ON scheduled_automations(account_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_event_id
  ON webhook_events(event_id) WHERE event_id IS NOT NULL;
