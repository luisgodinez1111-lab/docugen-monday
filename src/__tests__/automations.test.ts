/**
 * src/__tests__/automations.test.ts
 * Unit tests for automation.service.js — processPendingTriggers max-attempts fix.
 *
 * Uses require.cache injection (same pattern as billing.test.ts) to inject mocks
 * into Node's native CJS require chain before automation.service.js loads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const req = createRequire(import.meta.url);
const SRC = path.resolve(import.meta.dirname, '..');

// ── Shared mock functions ────────────────────────────────────────────────────

const mockQuery            = vi.fn();
const mockLogger           = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
const mockGetMondayItem    = vi.fn();
const mockGetMondayBoard   = vi.fn();
const mockCreateUpdate     = vi.fn().mockResolvedValue({});
const mockDecryptToken     = vi.fn((t: string) => t);
const mockWithRetry        = vi.fn((fn: () => unknown) => fn());
const mockLogError         = vi.fn();
const mockCreateDocx       = vi.fn();
const mockInjectSettings   = vi.fn().mockResolvedValue({});

// ── Inject mocks into Node's require.cache ────────────────────────────────────

function injectMocks() {
  type CacheEntry = Record<string, unknown>;
  const cache = (req as NodeRequire & { cache: Record<string, CacheEntry> }).cache;

  const inject = (relPath: string, exports: unknown) => {
    const absPath = path.join(SRC, relPath);
    cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports, parent: null, children: [], paths: [] } as unknown as CacheEntry;
  };

  inject('services/db.service.js',       { pool: { query: mockQuery } });
  inject('services/logger.service.js',   { default: mockLogger, ...mockLogger });
  inject('utils/graphql.js',             { getMondayItem: mockGetMondayItem, getMondayBoard: mockGetMondayBoard, createMondayUpdate: mockCreateUpdate });
  inject('utils/crypto.js',             { decryptToken: mockDecryptToken });
  inject('utils/retry.js',              { withRetry: mockWithRetry });
  inject('services/error-log.service.js', { logError: mockLogError });
  inject('services/template.service.js', { createDocxtemplater: mockCreateDocx, injectGlobalSettings: mockInjectSettings });
}

// Load automation.service fresh with mocks injected
function loadAutomations() {
  const svcPath = path.join(SRC, 'services/automation.service.js');
  delete (req as NodeRequire & { cache: Record<string, unknown> }).cache[svcPath];
  injectMocks();
  return req(svcPath) as { processPendingTriggers: () => Promise<void> };
}

const automationSvc = loadAutomations();

beforeEach(() => vi.clearAllMocks());

describe('processPendingTriggers', () => {
  it('does not process events with attempts >= 3 (max_attempts filter in query)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await automationSvc.processPendingTriggers();
    // Should only run the SELECT query — nothing to process
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('attempts < $1'),
      [3]
    );
  });

  it('increments attempts before processing each event', async () => {
    const evt = {
      id: 1, account_id: 'acc_1', item_id: 'item_1', board_id: 'board_1',
      column_id: 'template.docx', attempts: 0,
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [evt] })          // SELECT pending
      .mockResolvedValueOnce({ rows: [] })             // UPDATE attempts + 1
      .mockResolvedValueOnce({ rows: [] })             // SELECT trigger
      .mockResolvedValueOnce({ rows: [] });            // SELECT token (no match)

    await automationSvc.processPendingTriggers();

    // Second call must be the attempts increment
    expect(mockQuery.mock.calls[1][0]).toContain('attempts = attempts + 1');
    expect(mockQuery.mock.calls[1][1]).toEqual([1]);
  });

  it('marks event as error:no_trigger when no trigger matches', async () => {
    const evt = { id: 2, account_id: 'acc_2', item_id: 'item_2', board_id: 'b', column_id: 'gone.docx', attempts: 0 };
    mockQuery
      .mockResolvedValueOnce({ rows: [evt] })
      .mockResolvedValueOnce({ rows: [] })             // UPDATE attempts
      .mockResolvedValueOnce({ rows: [] });            // SELECT trigger — no match

    await automationSvc.processPendingTriggers();

    const updateCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('error:no_trigger')
    );
    expect(updateCall).toBeTruthy();
  });

  it('marks event as error:no_token when no token matches', async () => {
    const evt = { id: 3, account_id: 'acc_3', item_id: 'i', board_id: 'b', column_id: 't.docx', attempts: 2 };
    mockQuery
      .mockResolvedValueOnce({ rows: [evt] })
      .mockResolvedValueOnce({ rows: [] })             // UPDATE attempts
      .mockResolvedValueOnce({ rows: [{ id: 1, account_id: 'acc_3', template_name: 't.docx' }] }) // trigger found
      .mockResolvedValueOnce({ rows: [] });            // token — no match → error

    await automationSvc.processPendingTriggers();

    const updateCall = mockQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('error:no_token')
    );
    expect(updateCall).toBeTruthy();
  });

  it('does nothing when there are no pending events', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await automationSvc.processPendingTriggers();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
