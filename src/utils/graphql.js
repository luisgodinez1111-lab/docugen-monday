/**
 * src/utils/graphql.js
 * Wrapper seguro para la API GraphQL de Monday.com.
 *
 * C1/C2: Optional cache for getMondayItem (2 min TTL) and getMondayBoard (5 min TTL)
 *
 * Mejoras:
 *   #5 — Token refresh automático en 401 / error Unauthorized
 *   #8 — Circuit breaker (mondayBreaker) para fallar rápido cuando Monday está caído
 *
 * - Usa VARIABLES GraphQL (nunca concatenación) → previene GraphQL injection
 * - Valida response.data.errors (errores manejados en 200 OK)
 * - Adjunta API-Version header para estabilidad
 * - Aplica timeout configurable
 */
'use strict';

const axios  = require('axios');
const https  = require('https');
const { mondayBreaker } = require('./circuit-breaker');

// Same TLS workaround as oauth.routes.js — needed on Railway
const _mondayAgent = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

// C1/C2: Optional cache service — gracefully degraded if not available
let _cacheGet, _cacheSet;
try { ({ cacheGet: _cacheGet, cacheSet: _cacheSet } = require('../services/cache.service')); } catch {}

const MONDAY_API_URL     = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2024-10';
// Configurable via env: MONDAY_API_TIMEOUT_MS (default 20s, max 60s)
const DEFAULT_TIMEOUT_MS = Math.min(
  parseInt(process.env.MONDAY_API_TIMEOUT_MS, 10) || 20_000,
  60_000
);

// P1-9: removed local refreshMondayToken() — it incorrectly passed the access token as refresh_token.
// Token refresh is handled exclusively via opts.onTokenRefreshed() callback wired from auth.js.

/**
 * Executes a GraphQL query/mutation against Monday.com.
 *
 * @param {string}   accessToken
 * @param {string}   query         - GraphQL query/mutation (no user-data interpolation)
 * @param {object}   [variables]   - GraphQL variables (user data goes here)
 * @param {number}   [timeout]     - Timeout in ms
 * @param {object}   [opts]
 * @param {Function} [opts.onTokenRefreshed] - async (newToken: string) => void  called when token is refreshed
 * @returns {Promise<object>}
 * @throws {Error} with code 'CIRCUIT_OPEN' if Monday API circuit is open
 */
async function mondayQuery(accessToken, query, variables = {}, timeout = DEFAULT_TIMEOUT_MS, opts = {}) {
  return mondayBreaker.call(async () => {
    const response = await axios.post(
      MONDAY_API_URL,
      { query, variables },
      {
        headers: {
          Authorization:  accessToken,
          'Content-Type': 'application/json',
          'API-Version':  MONDAY_API_VERSION,
        },
        timeout,
        ...(_mondayAgent ? { httpsAgent: _mondayAgent } : {}),
      }
    );

    // Monday returns auth errors as 200 OK with errors array (code: 'Unauthorized')
    // Handle with a single retry after calling the onTokenRefreshed callback (from auth.js).
    // P1-9: do NOT call local refreshMondayToken() — it incorrectly used the access token as refresh_token.
    const isUnauthorized =
      response.data.errors?.some(e =>
        e.extensions?.code === 'Unauthorized' || e.message?.toLowerCase().includes('unauthorized')
      );

    if (isUnauthorized && !opts._refreshed && typeof opts.onTokenRefreshed === 'function') {
      const newToken = await opts.onTokenRefreshed();
      if (newToken) {
        // Retry exactly once with the new token — pass _refreshed flag to avoid loops
        return mondayQuery(newToken, query, variables, timeout, { ...opts, _refreshed: true });
      }
    }

    if (response.data.errors?.length) {
      const msg = response.data.errors.map(e => e.message).join('; ');
      throw new Error(`GraphQL error: ${msg}`);
    }

    return response.data.data;
  });
}

/**
 * Obtiene un item de Monday.com con todos sus column_values y subitems.
 *
 * @param {string}   accessToken
 * @param {string|number} itemId
 * @param {string}   columnFragment
 * @param {object}   [opts] - forwarded to mondayQuery (e.g. { onTokenRefreshed })
 */
async function getMondayItem(accessToken, itemId, columnFragment, opts = {}) {
  const id = parseInt(itemId, 10);
  if (!id || isNaN(id)) throw new Error(`itemId inválido: ${itemId}`);

  // C1: 2-minute cache
  const cacheKey = `monday_item:${id}`;
  if (_cacheGet) {
    const cached = await _cacheGet(cacheKey).catch(() => null);
    if (cached) return cached;
  }

  const query = `
    query GetItem($ids: [ID!]!) {
      items(ids: $ids) {
        id name
        column_values { ${columnFragment} }
        subitems { id name column_values { ${columnFragment} } }
      }
    }
  `;

  const data  = await mondayQuery(accessToken, query, { ids: [String(id)] }, DEFAULT_TIMEOUT_MS, opts);
  const items = data?.items;
  if (!items?.length) return null;
  const item = items[0];
  if (_cacheSet && item) await _cacheSet(cacheKey, item, 120).catch(() => {});
  return item;
}

/**
 * Obtiene un board con sus items (primera página).
 *
 * @param {string}   accessToken
 * @param {string|number} boardId
 * @param {number}   [limit=50]
 * @param {string}   [columnFragment]
 * @param {object}   [opts]
 */
async function getMondayBoard(accessToken, boardId, limit = 50, columnFragment = 'id text', opts = {}) {
  const id = parseInt(boardId, 10);
  if (!id || isNaN(id)) throw new Error(`boardId inválido: ${boardId}`);

  // C2: 5-minute cache
  const cacheKey = `monday_board:${id}:${limit}`;
  if (_cacheGet) {
    const cached = await _cacheGet(cacheKey).catch(() => null);
    if (cached) return cached;
  }

  const query = `
    query GetBoard($ids: [ID!]!, $limit: Int!) {
      boards(ids: $ids) {
        name
        columns { id title type }
        items_page(limit: $limit) {
          items {
            id name
            column_values { ${columnFragment} }
            subitems { id name column_values { ${columnFragment} } }
          }
        }
      }
    }
  `;

  const data   = await mondayQuery(accessToken, query, { ids: [String(id)], limit }, DEFAULT_TIMEOUT_MS, opts);
  const boards = data?.boards;
  if (!boards?.length) return null;
  const board = boards[0];
  // FIX-12: Increased TTL from 300s (5 min) to 1800s (30 min) to reduce Monday API pressure
  if (_cacheSet && board) await _cacheSet(cacheKey, board, 1800).catch(() => {});
  return board;
}

/**
 * Invalidates the cached board data for a given boardId.
 * Call this from webhook handlers when board changes are detected.
 *
 * @param {string|number} boardId
 */
async function invalidateBoardCache(boardId) {
  if (!_cacheGet) return;
  const id = parseInt(boardId, 10);
  if (!id || isNaN(id)) return;
  // Delete all cache keys for this board regardless of the limit used.
  // Covers all known limits + any custom limit passed by callers.
  const ALL_LIMITS = [10, 25, 50, 75, 100, 150, 200, 300, 500];
  const { cacheDel } = require('../services/cache.service');
  await Promise.allSettled(
    ALL_LIMITS.map(limit => cacheDel(`monday_board:${id}:${limit}`).catch(() => {}))
  );
}

/**
 * Crea un update (comentario) en un item.
 * Los valores se pasan como variables — no hay injection posible.
 *
 * @param {string}   accessToken
 * @param {string|number} itemId
 * @param {string}   body
 * @param {object}   [opts]
 */
async function createMondayUpdate(accessToken, itemId, body, opts = {}) {
  const id = parseInt(itemId, 10);
  if (!id || isNaN(id)) throw new Error(`itemId inválido: ${itemId}`);

  const query = `
    mutation CreateUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }
  `;

  return mondayQuery(accessToken, query, { itemId: String(id), body }, DEFAULT_TIMEOUT_MS, opts);
}

module.exports = { mondayQuery, getMondayItem, getMondayBoard, createMondayUpdate, invalidateBoardCache };
