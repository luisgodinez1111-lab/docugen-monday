-- Migration 001: Initial schema — all CREATE TABLE statements
-- Idempotent: uses IF NOT EXISTS

CREATE TABLE IF NOT EXISTS tokens (
  account_id   TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  user_id      TEXT,
  created_at   TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS templates (
  id         SERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  filename   TEXT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(account_id, filename)
);

CREATE TABLE IF NOT EXISTS documents (
  id            SERIAL PRIMARY KEY,
  account_id    TEXT NOT NULL,
  board_id      TEXT,
  item_id       TEXT,
  item_name     TEXT,
  template_name TEXT,
  filename      TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pdf_jobs (
  job_id     TEXT PRIMARY KEY,
  account_id TEXT,
  status     TEXT DEFAULT 'processing',
  filename   TEXT,
  item_name  TEXT,
  error      TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logos (
  account_id TEXT PRIMARY KEY,
  filename   TEXT,
  data       BYTEA NOT NULL,
  mimetype   TEXT DEFAULT 'image/png',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id     TEXT PRIMARY KEY,
  plan           TEXT DEFAULT 'free',
  docs_generated INT DEFAULT 0,
  created_at     TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id           SERIAL PRIMARY KEY,
  event_type   TEXT,
  item_id      TEXT,
  board_id     TEXT,
  column_id    TEXT,
  column_value TEXT,
  account_id   TEXT,
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_triggers (
  id            SERIAL PRIMARY KEY,
  account_id    TEXT,
  board_id      TEXT,
  column_id     TEXT,
  trigger_value TEXT,
  template_name TEXT,
  action        TEXT DEFAULT 'generate',
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_automations (
  id               SERIAL PRIMARY KEY,
  account_id       TEXT,
  name             TEXT,
  cron_expression  TEXT,
  board_id         TEXT,
  template_name    TEXT,
  condition_column TEXT,
  condition_value  TEXT,
  last_run         TIMESTAMP,
  next_run         TIMESTAMP,
  status           TEXT DEFAULT 'active',
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signature_requests (
  id                SERIAL PRIMARY KEY,
  account_id        TEXT,
  item_id           TEXT,
  board_id          TEXT,
  document_filename TEXT,
  signer_name       TEXT,
  signer_email      TEXT,
  token             TEXT UNIQUE,
  status            TEXT DEFAULT 'pending',
  signed_at         TIMESTAMP,
  ip_address        TEXT,
  created_at        TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_settings (
  account_id TEXT PRIMARY KEY,
  settings   JSONB DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portal_logos (
  account_id TEXT PRIMARY KEY,
  filename   TEXT,
  data       BYTEA,
  mimetype   TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  id           SERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,
  account_id   TEXT,
  user_id      TEXT,
  plan_id      TEXT,
  is_trial     BOOLEAN,
  renewal_date TEXT,
  data         JSONB,
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  account_id   TEXT PRIMARY KEY,
  plan_id      TEXT,
  status       TEXT DEFAULT 'active',
  is_trial     BOOLEAN DEFAULT false,
  renewal_date TEXT,
  docs_limit   INT DEFAULT 10,
  docs_used    INT DEFAULT 0,
  trial_ends_at TIMESTAMP,
  subscribed_at TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id                   SERIAL PRIMARY KEY,
  approval_token       TEXT UNIQUE NOT NULL,
  signature_request_id INT,
  created_at           TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS error_logs (
  id         SERIAL PRIMARY KEY,
  account_id TEXT,
  error_type TEXT,
  message    TEXT,
  stack      TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backups (
  id                SERIAL PRIMARY KEY,
  created_at        TIMESTAMP DEFAULT NOW(),
  tables_backed_up  INT,
  total_rows        INT,
  status            TEXT,
  error             TEXT
);

CREATE TABLE IF NOT EXISTS backup_data (
  id         SERIAL PRIMARY KEY,
  created_at TIMESTAMP DEFAULT NOW(),
  data       TEXT
);

CREATE TABLE IF NOT EXISTS deletion_queue (
  id           SERIAL PRIMARY KEY,
  account_id   TEXT NOT NULL UNIQUE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  executed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_events (
  id          BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL,
  event_type  TEXT NOT NULL,
  actor_id    TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
