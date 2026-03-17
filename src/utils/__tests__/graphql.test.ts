/**
 * Tests for src/utils/graphql.js
 *
 * Uses nock to intercept HTTP at the Node.js socket level — works
 * regardless of whether the module uses ESM import or CJS require.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';

// Load the CJS module under test
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { mondayQuery, getMondayItem, getMondayBoard, createMondayUpdate } = require('../graphql');

const TOKEN = 'test-access-token';
const MONDAY_API = 'https://api.monday.com';
const GQL_PATH = '/v2';

beforeEach(() => {
  nock.cleanAll();
});

afterEach(() => {
  // Fail if any nock interceptors were unused (means a request wasn't made)
  if (!nock.isDone()) {
    nock.cleanAll();
  }
});

// ── mondayQuery ──────────────────────────────────────────────────────────────
describe('mondayQuery()', () => {
  it('returns response.data.data on success', async () => {
    nock(MONDAY_API)
      .post(GQL_PATH)
      .reply(200, { data: { boards: [{ name: 'Test' }] } });

    const result = await mondayQuery(TOKEN, '{ boards { name } }');
    expect(result).toEqual({ boards: [{ name: 'Test' }] });
  });

  it('throws on GraphQL errors embedded in 200 response', async () => {
    nock(MONDAY_API)
      .post(GQL_PATH)
      .reply(200, { errors: [{ message: 'Not found' }, { message: 'Rate limited' }] });

    await expect(mondayQuery(TOKEN, '{ items(ids: [1]) { id } }')).rejects.toThrow(
      'GraphQL error: Not found; Rate limited'
    );
  });

  it('sends API-Version: 2024-10 header', async () => {
    nock(MONDAY_API, { reqheaders: { 'API-Version': '2024-10' } })
      .post(GQL_PATH)
      .reply(200, { data: {} });

    await mondayQuery(TOKEN, '{ me { id } }');
    // nock would throw if the header wasn't present
  });

  it('sends Authorization header with the access token', async () => {
    nock(MONDAY_API, { reqheaders: { Authorization: TOKEN } })
      .post(GQL_PATH)
      .reply(200, { data: {} });

    await mondayQuery(TOKEN, '{ me { id } }');
  });
});

// ── getMondayItem ────────────────────────────────────────────────────────────
describe('getMondayItem()', () => {
  it('returns the first item', async () => {
    const item = { id: '42', name: 'Invoice', column_values: [], subitems: [] };
    nock(MONDAY_API).post(GQL_PATH).reply(200, { data: { items: [item] } });

    expect(await getMondayItem(TOKEN, '42', 'id text')).toEqual(item);
  });

  it('returns null when items array is empty', async () => {
    nock(MONDAY_API).post(GQL_PATH).reply(200, { data: { items: [] } });

    expect(await getMondayItem(TOKEN, '99', 'id text')).toBeNull();
  });

  it('throws on non-numeric itemId (no HTTP call made)', async () => {
    await expect(getMondayItem(TOKEN, 'not-a-number', 'id text')).rejects.toThrow(/itemId inválido/);
  });

  it('sends itemId as variables.ids array, not string-interpolated', async () => {
    let capturedBody: unknown;
    nock(MONDAY_API)
      .post(GQL_PATH, (body: unknown) => {
        capturedBody = body;
        return true;
      })
      .reply(200, { data: { items: [{ id: '1', name: 'X', column_values: [], subitems: [] }] } });

    await getMondayItem(TOKEN, '1', 'id text');
    expect((capturedBody as { variables: { ids: string[] } }).variables).toEqual({ ids: ['1'] });
  });
});

// ── getMondayBoard ───────────────────────────────────────────────────────────
describe('getMondayBoard()', () => {
  it('returns the first board', async () => {
    const board = { name: 'CRM', columns: [], items_page: { items: [] } };
    nock(MONDAY_API).post(GQL_PATH).reply(200, { data: { boards: [board] } });

    expect(await getMondayBoard(TOKEN, '100')).toEqual(board);
  });

  it('returns null when boards array is empty', async () => {
    nock(MONDAY_API).post(GQL_PATH).reply(200, { data: { boards: [] } });

    expect(await getMondayBoard(TOKEN, '100')).toBeNull();
  });

  it('throws on non-numeric boardId (no HTTP call made)', async () => {
    await expect(getMondayBoard(TOKEN, 'abc')).rejects.toThrow(/boardId inválido/);
  });
});

// ── createMondayUpdate ───────────────────────────────────────────────────────
describe('createMondayUpdate()', () => {
  it('sends mutation with variables (no string interpolation)', async () => {
    let capturedBody: unknown;
    nock(MONDAY_API)
      .post(GQL_PATH, (body: unknown) => {
        capturedBody = body;
        return true;
      })
      .reply(200, { data: { create_update: { id: '999' } } });

    await createMondayUpdate(TOKEN, '42', 'Hello world');
    const b = capturedBody as { query: string; variables: { itemId: string; body: string } };
    expect(b.query).toContain('create_update');
    expect(b.variables).toEqual({ itemId: '42', body: 'Hello world' });
  });

  it('throws on non-numeric itemId (no HTTP call made)', async () => {
    await expect(createMondayUpdate(TOKEN, 'bad-id', 'text')).rejects.toThrow(/itemId inválido/);
  });
});
