/**
 * src/__tests__/webhook-monday.test.ts
 * Integration tests for POST /webhooks/monday.
 *
 * The HMAC middleware and challenge handler run before any DB access,
 * so these tests work without a real database.
 *
 * Deduplication (#9) and event-insert tests are marked as todo —
 * they need a real PostgreSQL test instance.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';

const SIGNING_SECRET = 'test-signing-secret-32-bytes-long!!';
process.env.MONDAY_SIGNING_SECRET  = SIGNING_SECRET;
process.env.MONDAY_CLIENT_ID       = 'test-client-id';
process.env.MONDAY_CLIENT_SECRET   = 'test-client-secret';
process.env.MONDAY_APP_ID          = 'test-app-id';
process.env.REDIRECT_URI           = 'https://test.example.com/oauth/callback';
process.env.APP_URL                = 'https://test.example.com';
process.env.DATABASE_URL           = 'postgres://localhost/test';
process.env.TOKEN_ENCRYPTION_KEY   = 'a'.repeat(64);
process.env.NODE_ENV               = 'test';
process.env.RESEND_API_KEY         = 're_test_key';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const app = require('../../index');

// ── Helpers ───────────────────────────────────────────────────────────────────
function signBody(body: object): string {
  return crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
}

function webhookRequest(body: object) {
  return request(app)
    .post('/webhooks/monday')
    .set('Content-Type', 'application/json')
    .set('Authorization', signBody(body))
    .send(body);
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('POST /webhooks/monday', () => {
  // ── No DB required ────────────────────────────────────────────────────────

  it('responds to challenge handshake without requiring HMAC', async () => {
    const res = await request(app)
      .post('/webhooks/monday')
      .send({ challenge: 'abc123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: 'abc123' });
  });

  it('rejects requests with invalid HMAC signature', async () => {
    const body = { event: { type: 'change_column_value', itemId: '1', boardId: '2' } };
    const res = await request(app)
      .post('/webhooks/monday')
      .set('Authorization', 'deadbeef')
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
  });

  it('returns 200 for a valid signed event (DB errors caught internally)', async () => {
    // The webhook handler always returns 200 — DB errors are caught and logged
    const body = {
      event: {
        type: 'change_column_value',
        id: 'evt-001',
        itemId: '42',
        boardId: '10',
        columnId: 'status',
        value: { label: { text: 'Done' } },
      },
    };
    const res = await webhookRequest(body);
    expect(res.status).toBe(200);
  });

  it('returns 200 when event is missing (no DB access needed)', async () => {
    const body = {}; // no event, no challenge
    const res = await webhookRequest(body);
    expect(res.status).toBe(200);
  });

  // ── DB-dependent scenarios (require real test PostgreSQL) ─────────────────

  it.todo('inserts webhook_event into DB on valid event — needs real test DB');
  it.todo('deduplicates events with same event_id (ON CONFLICT DO NOTHING) — needs real test DB');
  it.todo('fires trigger_fired insert when trigger matches — needs real test DB');
});
