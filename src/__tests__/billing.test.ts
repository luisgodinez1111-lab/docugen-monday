/**
 * src/__tests__/billing.test.ts
 * Unit tests for billing.service.js
 *
 * Strategy: inject mocks via Node's require.cache before loading billing.service.
 * This works regardless of whether vitest's vi.mock intercepts CJS require chains,
 * because we directly replace the cached module exports before billing.service.js loads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const req = createRequire(import.meta.url);
const SRC = path.resolve(import.meta.dirname, '..');

// ── Shared mock functions ────────────────────────────────────────────────────

const mockQuery    = vi.fn();
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn().mockResolvedValue(undefined);
const mockCacheDel = vi.fn().mockResolvedValue(undefined);
const mockLogger   = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

// ── Inject mocks into Node's require.cache BEFORE billing.service loads ─────

function injectMocks() {
  const dbPath     = path.join(SRC, 'services/db.service.js');
  const cachePath  = path.join(SRC, 'services/cache.service.js');
  const loggerPath = path.join(SRC, 'services/logger.service.js');

  (req as NodeRequire & { cache: Record<string, unknown> }).cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { pool: { query: mockQuery } },
    parent: null, children: [], paths: [],
  } as unknown as NodeModule;

  (req as NodeRequire & { cache: Record<string, unknown> }).cache[cachePath] = {
    id: cachePath, filename: cachePath, loaded: true,
    exports: { cacheGet: mockCacheGet, cacheSet: mockCacheSet, cacheDel: mockCacheDel },
    parent: null, children: [], paths: [],
  } as unknown as NodeModule;

  (req as NodeRequire & { cache: Record<string, unknown> }).cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { default: mockLogger, ...mockLogger },
    parent: null, children: [], paths: [],
  } as unknown as NodeModule;
}

// Load billing.service fresh for each test group
function loadBilling() {
  const billingPath = path.join(SRC, 'services/billing.service.js');
  delete (req as NodeRequire & { cache: Record<string, unknown> }).cache[billingPath];
  injectMocks();
  return req(billingPath) as typeof import('../services/billing.service');
}

const billing = loadBilling();

beforeEach(() => {
  vi.clearAllMocks();
  mockCacheGet.mockResolvedValue(null);
  mockCacheSet.mockResolvedValue(undefined);
  mockCacheDel.mockResolvedValue(undefined);
});

// ── checkSubscription ────────────────────────────────────────────────────────

describe('checkSubscription', () => {
  it('returns allowed:true for active subscription within limit', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ plan_id: 'professional', status: 'active', docs_used: 50, docs_limit: 200, trial_ends_at: null }],
    });
    const result = await billing.checkSubscription('acc_001');
    expect(result.allowed).toBe(true);
    expect(result.plan).toBe('professional');
  });

  it('returns allowed:false reason:trial_expired when trial_ends_at is past', async () => {
    const pastDate = new Date(Date.now() - 86400000);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ plan_id: 'trial', status: 'trial', docs_used: 3, docs_limit: 10, trial_ends_at: pastDate }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await billing.checkSubscription('acc_002');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('trial_expired');
  });

  it('returns allowed:false reason:docs_limit_reached when docs_used >= docs_limit', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ plan_id: 'trial', status: 'trial', docs_used: 10, docs_limit: 10, trial_ends_at: null }],
    });
    const result = await billing.checkSubscription('acc_003');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('docs_limit_reached');
  });

  it('returns allowed:false reason:subscription_check_error on DB error — fail-closed', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));
    const result = await billing.checkSubscription('acc_004');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('subscription_check_error');
  });

  it('auto-creates trial subscription for new account', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await billing.checkSubscription('new_account');
    expect(result.allowed).toBe(true);
    expect(result.plan).toBe('trial');
    expect(result.docs_limit).toBe(10);
  });

  it('returns cached result without hitting DB on second call', async () => {
    const cached = { allowed: true, plan: 'business', docs_used: 5, docs_limit: 1000 };
    mockCacheGet.mockResolvedValueOnce(cached);
    const result = await billing.checkSubscription('acc_cached');
    expect(result).toEqual(cached);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ── incrementDocsUsed ────────────────────────────────────────────────────────

describe('incrementDocsUsed', () => {
  it('increments docs_used by 1', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await billing.incrementDocsUsed('acc_001');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('docs_used = docs_used + 1'),
      ['acc_001']
    );
  });

  it('invalidates billing cache after increment', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await billing.incrementDocsUsed('acc_001');
    expect(mockCacheDel).toHaveBeenCalledWith('sub:acc_001');
  });

  it('does not throw on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    await expect(billing.incrementDocsUsed('acc_001')).resolves.not.toThrow();
  });
});

// ── getAccountPlanLimits ─────────────────────────────────────────────────────

describe('getAccountPlanLimits', () => {
  it('returns correct limits for professional plan', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan_id: 'professional' }] });
    const limits = await billing.getAccountPlanLimits('acc_001');
    expect(limits?.docs).toBe(200);
    expect(limits?.sigs).toBe(100);
    expect(limits?.workflows).toBe(true);
  });

  it('returns null when no subscription exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const limits = await billing.getAccountPlanLimits('acc_new');
    expect(limits).toBeNull();
  });

  it('throws on DB error — fail-closed', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));
    await expect(billing.getAccountPlanLimits('acc_001')).rejects.toThrow('DB down');
  });
});

// ── getMonthlyUsage ──────────────────────────────────────────────────────────

describe('getMonthlyUsage', () => {
  it('returns correct monthly counts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ docs: '15', sigs: '8' }] });
    const usage = await billing.getMonthlyUsage('acc_001');
    expect(usage.docs).toBe(15);
    expect(usage.sigs).toBe(8);
  });

  it('throws on DB error — never returns zero usage silently', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    await expect(billing.getMonthlyUsage('acc_001')).rejects.toThrow('DB error');
  });
});
