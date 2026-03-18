-- Migration 009: persist last-used board per account
CREATE TABLE IF NOT EXISTS account_boards (
  account_id TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL,
  board_name TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);
