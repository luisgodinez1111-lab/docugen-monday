/**
 * src/__tests__/generate-document.test.ts
 * Integration tests for POST /generate-from-monday.
 *
 * NOTE: Tests that require a DB lookup (session/template checks) are marked
 * as todo — they need a real PostgreSQL test instance.
 * The missing-account-id check runs at the middleware level with no DB.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import nock from 'nock';

process.env.MONDAY_SIGNING_SECRET = 'test-signing-secret-32-bytes-long!!';
process.env.MONDAY_CLIENT_ID      = 'test-client-id';
process.env.MONDAY_CLIENT_SECRET  = 'test-client-secret';
process.env.MONDAY_APP_ID         = 'test-app-id';
process.env.REDIRECT_URI          = 'https://test.example.com/oauth/callback';
process.env.APP_URL               = 'https://test.example.com';
process.env.DATABASE_URL          = 'postgres://localhost/test';
process.env.NODE_ENV              = 'test';
process.env.RESEND_API_KEY        = 're_test_key';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const app = require('../../index');

describe('POST /generate-from-monday', () => {
  beforeEach(() => nock.cleanAll());

  // ── Auth header check (no DB required) ───────────────────────────────────

  it('returns 401 when x-account-id header is missing', async () => {
    const res = await request(app)
      .post('/generate-from-monday')
      .send({ board_id: '1', item_id: '1', template_name: 'test.docx' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/account_id/i);
  });

  // ── DB-dependent scenarios (require real test PostgreSQL) ─────────────────

  it.todo('returns 401 with needs_auth when no OAuth session exists — needs real test DB');
  it.todo('returns 404 when template does not exist — needs real test DB');
  it.todo('calls Monday API and generates document when auth + template exist — needs real test DB');
});
