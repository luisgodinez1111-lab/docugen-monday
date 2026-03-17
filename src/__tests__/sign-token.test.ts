/**
 * src/__tests__/sign-token.test.ts
 * Integration tests for POST /sign/:token.
 *
 * NOTE: Tests that require a live DB (token lookup, expiry check) are marked
 * as todo — they need a real PostgreSQL test instance.
 * Pure input-validation tests run without any DB.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';

// ── Env stubs ─────────────────────────────────────────────────────────────────
process.env.MONDAY_SIGNING_SECRET = 'test-signing-secret-32-bytes-long!!';
process.env.MONDAY_CLIENT_ID      = 'test-client-id';
process.env.MONDAY_CLIENT_SECRET  = 'test-client-secret';
process.env.MONDAY_APP_ID         = 'test-app-id';
process.env.REDIRECT_URI          = 'https://test.example.com/oauth/callback';
process.env.APP_URL               = 'https://test.example.com';
process.env.DATABASE_URL          = 'postgres://localhost/test';
process.env.NODE_ENV              = 'test';
process.env.RESEND_API_KEY        = 're_test_key';

// ── Load app ──────────────────────────────────────────────────────────────────
// index.js is a CJS module loaded outside vitest's module resolver; pg is
// NOT mocked here — DB calls gracefully fail (AggregateError) inside try/catch.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const app = require('../../index');

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('POST /sign/:token', () => {
  // ── Input validation (no DB required) ────────────────────────────────────

  it('returns 400 when signature_data is missing', async () => {
    const res = await request(app)
      .post('/sign/some-token')
      .send({ signer_name: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/firma requerida/i);
  });

  // ── DB-dependent scenarios (require a real test PostgreSQL) ───────────────

  it.todo('returns 404 for unknown/invalid token — needs real test DB');
  it.todo('returns 400 for expired token — needs real test DB');
  it.todo('returns 200 with download_url for valid pending token — needs real test DB');
});
