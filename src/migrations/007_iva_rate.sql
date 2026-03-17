-- Migration 007: Per-account IVA rate
-- Replaces hardcoded 16% IVA in calcularTotales()
-- Default 0.16 preserves existing Mexico behavior

ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS iva_rate NUMERIC(5,4) DEFAULT 0.16;
