-- Migration 008: add signer_ip to signature_requests
ALTER TABLE signature_requests ADD COLUMN IF NOT EXISTS signer_ip TEXT;
