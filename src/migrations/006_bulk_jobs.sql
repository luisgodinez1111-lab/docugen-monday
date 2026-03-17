-- Migration 006: Bulk generation job tracking table
-- Enables async bulk generation with BullMQ + progress polling

CREATE TABLE IF NOT EXISTS bulk_jobs (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  total      INT NOT NULL,
  completed  INT DEFAULT 0,
  failed     INT DEFAULT 0,
  status     TEXT DEFAULT 'processing',
  results    JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_account_status
  ON bulk_jobs(account_id, status);
