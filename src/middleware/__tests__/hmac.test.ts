/**
 * Tests for src/middleware/hmac.js
 * Run: vitest run src/middleware/__tests__/hmac.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { verifyMondayHmac } = require('../hmac');

const SECRET = 'test-signing-secret-32-chars-min!';

function makeValidSig(body: object): string {
  const raw = JSON.stringify(body);
  return crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
}

function mockReq(body: object, authHeader?: string): Partial<Request> {
  return {
    body,
    headers: { authorization: authHeader },
  } as Partial<Request>;
}

function mockRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const res: Record<string, unknown> = {};
  res['json'] = vi.fn(() => res);
  res['status'] = vi.fn(() => res);
  return res as ReturnType<typeof mockRes>;
}

describe('verifyMondayHmac middleware', () => {
  const originalSecret = process.env['MONDAY_SIGNING_SECRET'];

  beforeEach(() => {
    process.env['MONDAY_SIGNING_SECRET'] = SECRET;
  });

  it('passes with a valid HMAC signature', () => {
    const body = { type: 'incoming_notification', data: { itemId: '42' } };
    const sig = makeValidSig(body);
    const req = mockReq(body, sig);
    const res = mockRes();
    const next: NextFunction = vi.fn();

    verifyMondayHmac()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects with 401 when signature is wrong', () => {
    const body = { type: 'incoming_notification' };
    const req = mockReq(body, 'deadbeef');
    const res = mockRes();
    const next: NextFunction = vi.fn();

    verifyMondayHmac()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 401 when Authorization header is missing', () => {
    const body = { type: 'incoming_notification' };
    const req = mockReq(body, undefined);
    const res = mockRes();
    const next: NextFunction = vi.fn();

    verifyMondayHmac()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('allows challenge bypass when allowChallenge=true (default)', () => {
    const body = { challenge: 'some-challenge-token' };
    const req = mockReq(body, undefined); // no auth header
    const res = mockRes();
    const next: NextFunction = vi.fn();

    verifyMondayHmac({ allowChallenge: true })(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks challenge bypass when allowChallenge=false', () => {
    const body = { challenge: 'some-challenge-token' };
    const req = mockReq(body, undefined);
    const res = mockRes();
    const next: NextFunction = vi.fn();

    verifyMondayHmac({ allowChallenge: false })(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 500 when MONDAY_SIGNING_SECRET is missing', () => {
    delete process.env['MONDAY_SIGNING_SECRET'];
    const body = { type: 'test' };
    const req = mockReq(body, 'anysig');
    const res = mockRes();
    const next: NextFunction = vi.fn();

    verifyMondayHmac()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);

    process.env['MONDAY_SIGNING_SECRET'] = originalSecret ?? SECRET;
  });

  it('accepts sha256= prefixed signatures (Monday.com format)', () => {
    const body = { type: 'incoming_notification', itemId: 99 };
    const sig = 'sha256=' + makeValidSig(body);
    const req = mockReq(body, sig);
    const res = mockRes();
    const next: NextFunction = vi.fn();

    verifyMondayHmac()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
