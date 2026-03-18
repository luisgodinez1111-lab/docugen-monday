'use strict';
/**
 * src/utils/config.js
 * Centralised constants — single source of truth for magic numbers.
 * Import this instead of scattering literals across the codebase.
 */

// ── Billing / Subscriptions ──────────────────────────────────────────────────
const TRIAL_DURATION_MS      = 14 * 24 * 60 * 60 * 1000;   // 14 days
const TOKEN_TTL_MS           = 7  * 24 * 60 * 60 * 1000;   // 7 days (email links)
const SUBSCRIPTION_CACHE_TTL = 60;                           // seconds
const LIMITS_CACHE_TTL       = 60;                           // seconds

// ── Automation ───────────────────────────────────────────────────────────────
const MAX_AUTOMATION_ATTEMPTS = 3;
const AUTOMATION_CONCURRENCY  = 5;

// ── Rate limiting ────────────────────────────────────────────────────────────
const DOC_RATE_MAX     = 20;           // requests
const DOC_RATE_WINDOW  = 60_000;       // ms (1 minute)

// ── Input validation ─────────────────────────────────────────────────────────
const MAX_STRING_LENGTH       = 1_000;
const MAX_FILENAME_LENGTH     = 255;
const MAX_SIGNER_NAME_LENGTH  = 200;
const MAX_SIGNER_EMAIL_LENGTH = 254;
const MAX_SETTINGS_KEYS       = 50;

// ── Token refresh ────────────────────────────────────────────────────────────
const PROACTIVE_REFRESH_WINDOW_MS = 10 * 60 * 1000;  // 10 minutes
const REFRESH_IN_FLIGHT_TTL_MS   = 5  * 60 * 1000;   // 5 minutes (stale-entry guard)

// ── Circuit breaker defaults ─────────────────────────────────────────────────
const CB_MONDAY_FAILURE_THRESHOLD = 5;
const CB_MONDAY_TIMEOUT_MS        = 30_000;
const CB_EMAIL_FAILURE_THRESHOLD  = 3;
const CB_EMAIL_TIMEOUT_MS         = 60_000;
const CB_TSA_FAILURE_THRESHOLD    = 3;
const CB_TSA_TIMEOUT_MS           = 120_000;

// ── Request timeouts ─────────────────────────────────────────────────────────
const HTTP_REQUEST_TIMEOUT_MS = 30_000;   // 30 s — max for any route handler

module.exports = {
  TRIAL_DURATION_MS, TOKEN_TTL_MS,
  SUBSCRIPTION_CACHE_TTL, LIMITS_CACHE_TTL,
  MAX_AUTOMATION_ATTEMPTS, AUTOMATION_CONCURRENCY,
  DOC_RATE_MAX, DOC_RATE_WINDOW,
  MAX_STRING_LENGTH, MAX_FILENAME_LENGTH,
  MAX_SIGNER_NAME_LENGTH, MAX_SIGNER_EMAIL_LENGTH, MAX_SETTINGS_KEYS,
  PROACTIVE_REFRESH_WINDOW_MS, REFRESH_IN_FLIGHT_TTL_MS,
  CB_MONDAY_FAILURE_THRESHOLD, CB_MONDAY_TIMEOUT_MS,
  CB_EMAIL_FAILURE_THRESHOLD, CB_EMAIL_TIMEOUT_MS,
  CB_TSA_FAILURE_THRESHOLD, CB_TSA_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
};
