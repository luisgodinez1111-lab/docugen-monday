/**
 * src/utils/graphql.js
 * Wrapper seguro para la API GraphQL de Monday.com.
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

const axios = require('axios');
const { mondayBreaker } = require('./circuit-breaker');

const MONDAY_API_URL     = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2024-10';
const DEFAULT_TIMEOUT_MS = 20_000;
const TOKEN_REFRESH_URL  = 'https://auth.monday.com/oauth2/token';

/**
 * Refreshes a Monday.com OAuth access token.
 * Returns the new access token or null if refresh fails.
 *
 * @param {string} currentToken - The current (possibly expired) access token
 * @returns {Promise<string|null>}
 */
async function refreshMondayToken(currentToken) {
  try {
    const resp = await axios.post(
      TOKEN_REFRESH_URL,
      {
        client_id:     process.env.MONDAY_CLIENT_ID,
        client_secret: process.env.MONDAY_CLIENT_SECRET,
        grant_type:    'refresh_token',
        refresh_token: currentToken,
      },
      { timeout: 10_000 }
    );
    return resp.data?.access_token ?? null;
  } catch {
    return null;
  }
}

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
      }
    );

    // Monday returns auth errors as 200 OK with errors array (code: 'Unauthorized')
    // OR as HTTP 401. Handle both with a single retry after token refresh.
    const isUnauthorized =
      response.data.errors?.some(e =>
        e.extensions?.code === 'Unauthorized' || e.message?.toLowerCase().includes('unauthorized')
      );

    if (isUnauthorized && !opts._refreshed) {
      const newToken = await refreshMondayToken(accessToken);
      if (newToken) {
        if (typeof opts.onTokenRefreshed === 'function') await opts.onTokenRefreshed(newToken);
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
  return items[0];
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
  return boards[0];
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

module.exports = { mondayQuery, getMondayItem, getMondayBoard, createMondayUpdate };
