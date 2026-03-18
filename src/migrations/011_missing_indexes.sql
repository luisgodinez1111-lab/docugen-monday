-- Migration 011: indexes for pagination and performance
-- All CREATE INDEX wrapped in DO blocks checking column existence

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='documents' AND column_name='account_id') AND
     EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='documents' AND column_name='created_at') AND
     EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='documents' AND column_name='deleted_at') THEN
    CREATE INDEX IF NOT EXISTS idx_documents_active
      ON documents(account_id, created_at DESC) WHERE deleted_at IS NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='signature_requests' AND column_name='account_id') AND
     EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='signature_requests' AND column_name='status') THEN
    CREATE INDEX IF NOT EXISTS idx_sig_requests_account_status
      ON signature_requests(account_id, status);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='signature_requests' AND column_name='account_id') AND
     EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='signature_requests' AND column_name='created_at') AND
     EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='signature_requests' AND column_name='status') THEN
    CREATE INDEX IF NOT EXISTS idx_sig_requests_active
      ON signature_requests(account_id, created_at DESC)
      WHERE status NOT IN ('completed','cancelled','expired');
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='tokens' AND column_name='account_id') THEN
    CREATE INDEX IF NOT EXISTS idx_tokens_account
      ON tokens(account_id);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='pdf_jobs' AND column_name='account_id') AND
     EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='pdf_jobs' AND column_name='created_at') THEN
    CREATE INDEX IF NOT EXISTS idx_pdf_jobs_account_created
      ON pdf_jobs(account_id, created_at DESC);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='bulk_jobs' AND column_name='account_id') AND
     EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='bulk_jobs' AND column_name='created_at') THEN
    CREATE INDEX IF NOT EXISTS idx_bulk_jobs_account_created
      ON bulk_jobs(account_id, created_at DESC);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='workflow_attempts' AND column_name='account_id') AND
     EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='workflow_attempts' AND column_name='created_at') THEN
    CREATE INDEX IF NOT EXISTS idx_workflow_attempts_account_created
      ON workflow_attempts(account_id, created_at DESC);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='approval_requests' AND column_name='account_id') AND
     EXISTS (SELECT FROM information_schema.columns
             WHERE table_name='approval_requests' AND column_name='status') THEN
    CREATE INDEX IF NOT EXISTS idx_approval_requests_account_status
      ON approval_requests(account_id, status);
  END IF;
END $$;
