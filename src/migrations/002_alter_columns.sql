-- Migration 002: All ALTER TABLE ADD COLUMN statements
-- Idempotent: uses ADD COLUMN IF NOT EXISTS

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS user_id       TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS refresh_token TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS expires_at    TIMESTAMPTZ;

ALTER TABLE templates ADD COLUMN IF NOT EXISTS canvas_json  TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMP DEFAULT NOW();

ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_data    BYTEA;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS signed_pdf  BYTEA;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;

ALTER TABLE pdf_jobs ADD COLUMN IF NOT EXISTS pdf_data BYTEA;

ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS doc_data            BYTEA;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signed_pdf          BYTEA;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signature_type      TEXT;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signer_order        INT DEFAULT 1;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS group_id            TEXT;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_code            TEXT;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_verified        BOOLEAN DEFAULT FALSE;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS doc_hash            TEXT;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS doc_type            TEXT DEFAULT 'document';
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS quote_response      TEXT;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS quote_comment       TEXT;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS quote_responded_at  TIMESTAMP;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS opened_at           TIMESTAMP;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS time_on_portal      INT DEFAULT 0;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signed_hash         TEXT;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS audit_log           JSONB DEFAULT '[]';
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS consent_text        TEXT;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS identity_verified   BOOLEAN DEFAULT FALSE;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS otp_attempts        INT DEFAULT 0;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS expires_at          TIMESTAMP;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS user_agent          TEXT;
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signature_data      TEXT;

ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS event_id TEXT;
