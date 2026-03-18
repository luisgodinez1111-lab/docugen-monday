'use strict';
/**
 * src/utils/circuit-breaker.js
 * Three-state circuit breaker (CLOSED → OPEN → HALF_OPEN) for external APIs.
 *
 * When the breaker opens it emits a Sentry event so ops has visibility.
 * When it closes again it emits a recovery event.
 */

const STATE = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

class CircuitBreaker {
  constructor(name, opts = {}) {
    this.name             = name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 2;
    this.timeout          = opts.timeout          ?? 30_000;
    this.state            = STATE.CLOSED;
    this.failureCount     = 0;
    this.successCount     = 0;
    this.nextAttemptTime  = 0;
  }

  async call(fn) {
    if (this.state === STATE.OPEN) {
      if (Date.now() < this.nextAttemptTime) {
        const retryAfterMs = this.nextAttemptTime - Date.now();
        const err = new Error(
          `Circuit OPEN for "${this.name}" — fast failing. Retry in ${Math.ceil(retryAfterMs / 1000)}s`
        );
        err.code = 'CIRCUIT_OPEN';
        err.retryAfterMs = retryAfterMs;
        throw err;
      }
      this.state = STATE.HALF_OPEN;
      this.successCount = 0;
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    this.failureCount = 0;
    if (this.state === STATE.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        const wasOpen = true;
        this.state = STATE.CLOSED;
        // Alert: service recovered
        this._alert('info', `Circuit "${this.name}" CLOSED — service recovered`);
        void wasOpen; // suppress lint
      }
    }
  }

  _onFailure() {
    this.failureCount++;
    if (this.state === STATE.HALF_OPEN || this.failureCount >= this.failureThreshold) {
      const wasAlreadyOpen = this.state === STATE.OPEN;
      this.state = STATE.OPEN;
      this.nextAttemptTime = Date.now() + this.timeout;
      // Alert only on the transition, not on every subsequent fast-fail
      if (!wasAlreadyOpen) {
        this._alert('error', `Circuit "${this.name}" OPENED after ${this.failureCount} failures — fast-failing for ${this.timeout / 1000}s`);
      }
    }
  }

  /**
   * Emit alert to Sentry (if configured) and always log to stderr.
   * Uses lazy require to avoid circular dependency with Sentry init.
   */
  _alert(level, message) {
    console.error(`[circuit-breaker] ${message}`);
    try {
      const Sentry = require('@sentry/node');
      if (level === 'error') {
        Sentry.captureMessage(message, 'error');
      } else {
        Sentry.addBreadcrumb({ message, level: 'info', category: 'circuit-breaker' });
      }
    } catch { /* Sentry not configured — stderr only */ }
  }

  get status() {
    return {
      name:          this.name,
      state:         this.state,
      failureCount:  this.failureCount,
      nextAttemptAt: this.state === STATE.OPEN ? new Date(this.nextAttemptTime).toISOString() : null,
    };
  }

  get isOpen() { return this.state === STATE.OPEN; }
}

// ── Singletons ──────────────────────────────────────────────────────────────
const mondayBreaker = new CircuitBreaker('monday-api',    { failureThreshold: 5, timeout: 30_000 });
const resendBreaker = new CircuitBreaker('resend-email',  { failureThreshold: 3, timeout: 60_000 });
const tsaBreaker    = new CircuitBreaker('tsa-timestamp', { failureThreshold: 3, timeout: 120_000 });

module.exports = { CircuitBreaker, mondayBreaker, resendBreaker, tsaBreaker };
