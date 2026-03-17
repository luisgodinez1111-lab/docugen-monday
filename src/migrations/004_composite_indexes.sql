-- Migration 004: Composite indexes for common query patterns
-- Avoids full table scans on pagination and filtered list queries

-- Listing documents by account sorted by date
CREATE INDEX IF NOT EXISTS idx_documents_account_created
  ON documents(account_id, created_at DESC);

-- Listing signatures by account sorted by date
CREATE INDEX IF NOT EXISTS idx_sigs_account_created
  ON signature_requests(account_id, created_at DESC);

-- checkSubscription() — filter by account + status
CREATE INDEX IF NOT EXISTS idx_subscriptions_account_status
  ON subscriptions(account_id, status);

-- runScheduledAutomations() — only active automations
CREATE INDEX IF NOT EXISTS idx_sched_autos_status
  ON scheduled_automations(status) WHERE status = 'active';

-- pdf_jobs polling by account + status
CREATE INDEX IF NOT EXISTS idx_pdf_jobs_account_status
  ON pdf_jobs(account_id, status);

-- processPendingTriggers() — event_type + column_value
CREATE INDEX IF NOT EXISTS idx_webhook_events_type_value
  ON webhook_events(event_type, column_value);

-- document_events audit trail
CREATE INDEX IF NOT EXISTS idx_document_events_doc_created
  ON document_events(document_id, created_at DESC);

-- signature_requests token + account scope (download dedup fix)
CREATE INDEX IF NOT EXISTS idx_sigs_token_account
  ON signature_requests(token, account_id);
