-- Migration 011: missing indexes + partial indexes for performance and pagination
-- FIX-8: DB indexes for pagination and lookup queries
-- FIX-11: Partial indexes to avoid scanning deleted/inactive rows

-- pdf_jobs pagination
CREATE INDEX IF NOT EXISTS idx_pdf_jobs_account_created ON pdf_jobs(account_id, created_at DESC);

-- bulk_jobs pagination
CREATE INDEX IF NOT EXISTS idx_bulk_jobs_account_created ON bulk_jobs(account_id, created_at DESC);

-- workflow_attempts pagination
CREATE INDEX IF NOT EXISTS idx_workflow_attempts_account_created ON workflow_attempts(account_id, created_at DESC);

-- approval_requests lookup
CREATE INDEX IF NOT EXISTS idx_approval_requests_account_status ON approval_requests(account_id, status);

-- signature_requests by account + status for approvals
CREATE INDEX IF NOT EXISTS idx_sig_requests_account_status ON signature_requests(account_id, status);

-- tokens lookup by account
CREATE INDEX IF NOT EXISTS idx_tokens_account ON tokens(account_id);

-- FIX-11: Partial index to avoid scanning deleted docs
CREATE INDEX IF NOT EXISTS idx_documents_active ON documents(account_id, created_at DESC) WHERE deleted_at IS NULL;

-- FIX-11: Partial index for active signature requests
CREATE INDEX IF NOT EXISTS idx_sig_requests_active ON signature_requests(account_id, created_at DESC) WHERE status NOT IN ('completed','cancelled','expired');
