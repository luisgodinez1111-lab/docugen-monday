-- Migration 011: indexes for pagination and performance
-- Uses DO blocks to skip indexes on tables that may not exist yet

-- Core tables — always exist
CREATE INDEX IF NOT EXISTS idx_documents_active
  ON documents(account_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sig_requests_account_status
  ON signature_requests(account_id, status);

CREATE INDEX IF NOT EXISTS idx_sig_requests_active
  ON signature_requests(account_id, created_at DESC)
  WHERE status NOT IN ('completed','cancelled','expired');

CREATE INDEX IF NOT EXISTS idx_tokens_account
  ON tokens(account_id);

-- Optional tables — only create index if table exists
DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name='pdf_jobs') THEN
    CREATE INDEX IF NOT EXISTS idx_pdf_jobs_account_created ON pdf_jobs(account_id, created_at DESC);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name='bulk_jobs') THEN
    CREATE INDEX IF NOT EXISTS idx_bulk_jobs_account_created ON bulk_jobs(account_id, created_at DESC);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name='workflow_attempts') THEN
    CREATE INDEX IF NOT EXISTS idx_workflow_attempts_account_created
      ON workflow_attempts(account_id, created_at DESC);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name='approval_requests') THEN
    CREATE INDEX IF NOT EXISTS idx_approval_requests_account_status
      ON approval_requests(account_id, status);
  END IF;
END $$;
