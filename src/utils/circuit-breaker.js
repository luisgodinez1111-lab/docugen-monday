'use strict';
/**
 * src/utils/circuit-breaker.js
 * Three-state circuit breaker (CLOSED → OPEN → HALF_OPEN) for external APIs.
 * Pure JS — no extra dependencies.
 *
 * States:
 *   CLOSED    — normal operation, failures are counted
 *   OPEN      — fast-fail, no requests sent until timeout expires
 *   HALF_OPEN — probe mode: one success closes, one failure re-opens
 */

const STATE = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

class CircuitBreaker {
  /**
   * @param {string} name - Service name for logging
   * @param {object} opts
   * @param {number} [opts.failureThreshold=5]  - Failures before opening
   * @param {number} [opts.successThreshold=2]  - Successes in HALF_OPEN before closing
   * @param {number} [opts.timeout=30000]        - ms to stay OPEN before probing
   */
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

  /**
   * Executes fn() through the circuit breaker.
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>}
   * @throws {Error} with code 'CIRCUIT_OPEN' when the breaker is open
   */
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
      // Timeout expired — move to HALF_OPEN for a probe
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
        this.state = STATE.CLOSED;
      }
    }
  }

  _onFailure() {
    this.failureCount++;
    if (this.state === STATE.HALF_OPEN || this.failureCount >= this.failureThreshold) {
      this.state = STATE.OPEN;
      this.nextAttemptTime = Date.now() + this.timeout;
    }
  }

  /** Returns a snapshot of current breaker state for monitoring */
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

// ── Singletons — one per external service ──────────────────────────────────
const mondayBreaker = new CircuitBreaker('monday-api',    { failureThreshold: 5, timeout: 30_000 });
const resendBreaker = new CircuitBreaker('resend-email',  { failureThreshold: 3, timeout: 60_000 });
const tsaBreaker    = new CircuitBreaker('tsa-timestamp', { failureThreshold: 3, timeout: 120_000 });

module.exports = { CircuitBreaker, mondayBreaker, resendBreaker, tsaBreaker };
