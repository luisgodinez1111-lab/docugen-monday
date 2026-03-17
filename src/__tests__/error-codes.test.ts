/**
 * src/__tests__/error-codes.test.ts
 * Unit tests for structured error codes.
 */
import { describe, it, expect } from 'vitest';
import { makeError, makeMondayError, ERROR_CODES, MONDAY_SEVERITY_MAP } from '../utils/error-codes';

describe('makeError', () => {
  it('returns structured error with code and message', () => {
    const err = makeError('TEMPLATE_NOT_FOUND');
    expect(err.error).toBe('TEMPLATE_NOT_FOUND');
    expect(err.message).toBeTruthy();
  });

  it('includes detail when provided', () => {
    const err = makeError('ITEM_NOT_FOUND', 'item_id: 123');
    expect(err.detail).toBe('item_id: 123');
  });

  it('falls back to INTERNAL_ERROR for unknown codes', () => {
    const err = makeError('NONEXISTENT_CODE' as any);
    expect(err.error).toBe('INTERNAL_ERROR');
  });

  it('has correct HTTP status for DOC_LIMIT_EXCEEDED (402)', () => {
    expect(ERROR_CODES.DOC_LIMIT_EXCEEDED.status).toBe(402);
  });

  it('has correct HTTP status for TOKEN_INVALID (400)', () => {
    expect(ERROR_CODES.TOKEN_INVALID.status).toBe(400);
  });
});

describe('makeMondayError', () => {
  it('maps TEMPLATE_NOT_FOUND to severity 6000 (permanent)', () => {
    const err = makeMondayError('TEMPLATE_NOT_FOUND');
    expect(err.severityCode).toBe(6000);
  });

  it('maps ITEM_NOT_FOUND to severity 4000 (retryable)', () => {
    const err = makeMondayError('ITEM_NOT_FOUND');
    expect(err.severityCode).toBe(4000);
  });

  it('maps DOC_LIMIT_EXCEEDED to severity 4000 (retryable after upgrade)', () => {
    expect(MONDAY_SEVERITY_MAP.DOC_LIMIT_EXCEEDED).toBe(4000);
  });

  it('defaults to severity 4000 for unmapped codes', () => {
    const err = makeMondayError('INTERNAL_ERROR');
    expect(err.severityCode).toBe(4000);
  });

  it('includes all required Monday.com action block error fields', () => {
    const err = makeMondayError('TEMPLATE_NOT_FOUND', 'template was deleted');
    expect(err).toHaveProperty('severityCode');
    expect(err).toHaveProperty('notificationErrorTitle');
    expect(err).toHaveProperty('notificationErrorDescription');
    expect(err).toHaveProperty('runtimeErrorDescription');
  });
});
