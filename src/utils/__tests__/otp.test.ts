/**
 * Tests for src/utils/otp.js
 * Run: vitest run src/utils/__tests__/otp.test.ts
 */
import { describe, it, expect } from 'vitest';

// CommonJS require (otp.js is not TypeScript yet)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateOtp, hashOtp, verifyOtp } = require('../otp');

describe('generateOtp()', () => {
  it('returns a 6-digit string', () => {
    const otp = generateOtp();
    expect(otp).toMatch(/^\d{6}$/);
  });

  it('produces different values on each call', () => {
    const samples = Array.from({ length: 20 }, () => generateOtp());
    const unique = new Set(samples);
    // 20 samples from 900k space — virtually certain to not all be the same
    expect(unique.size).toBeGreaterThan(1);
  });

  it('is always in [100000, 999999]', () => {
    for (let i = 0; i < 50; i++) {
      const n = parseInt(generateOtp(), 10);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
    }
  });
});

describe('hashOtp() + verifyOtp()', () => {
  const signerToken = 'test-token-for-unit-test';

  it('verifies a correct OTP', () => {
    const otp = generateOtp();
    const hash = hashOtp(otp, signerToken);
    expect(verifyOtp(otp, hash, signerToken)).toBe(true);
  });

  it('rejects an incorrect OTP', () => {
    const otp = generateOtp();
    const hash = hashOtp(otp, signerToken);
    const wrong = String(parseInt(otp, 10) + 1).padStart(6, '0');
    expect(verifyOtp(wrong, hash, signerToken)).toBe(false);
  });

  it('rejects a different signer token', () => {
    const otp = generateOtp();
    const hash = hashOtp(otp, signerToken);
    expect(verifyOtp(otp, hash, 'different-token')).toBe(false);
  });

  it('hashOtp is deterministic', () => {
    const otp = '123456';
    expect(hashOtp(otp, signerToken)).toBe(hashOtp(otp, signerToken));
  });

  it('hashOtp produces 64-char hex (SHA-256)', () => {
    const hash = hashOtp('999999', signerToken);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
