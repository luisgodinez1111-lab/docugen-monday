-- 012_enhancements.sql — Batch improvements: template versioning, retry backoff, OTP expiry, email tracking, rejections, dedup

-- Template versioning (FIX 2, FIX 9)
ALTER TABLE templates ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS previous_versions JSONB DEFAULT '[]';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS variables JSONB DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_templates_account_name ON templates(account_id, template_name);

-- Webhook retry backoff (FIX 4)
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMP;

-- OTP expiry (FIX 8)
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP;

-- Email delivery tracking (FIX 10)
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS email_status TEXT DEFAULT 'pending';
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMP;

-- Signature rejection (FIX 15)
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Document deduplication (FIX 11)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(account_id, doc_hash) WHERE deleted_at IS NULL;
