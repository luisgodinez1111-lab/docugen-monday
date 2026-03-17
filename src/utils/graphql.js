/**
 * src/utils/graphql.js
 * Wrapper seguro para la API GraphQL de Monday.com.
 *
 * - Usa VARIABLES GraphQL (nunca concatenación de strings) → previene GraphQL injection
 * - Valida response.data.errors (errores manejados en 200 OK)
 * - Adjunta API-Version header para estabilidad
 * - Aplica timeout configurable
 *
 * Ref: Sección 1 y 3.1 de monday_docs_reference.txt
 * Docs: https://developer.monday.com/api-reference/docs/basics
 */
const axios = require('axios');

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2024-10';
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Ejecuta una query/mutation GraphQL contra Monday.com de forma segura.
 *
 * @param {string} accessToken - Token OAuth del usuario
 * @param {string} query       - Query/mutation GraphQL (sin interpolación de datos de usuario)
 * @param {object} [variables] - Variables GraphQL (los valores de usuario van AQUÍ)
 * @param {number} [timeout]   - Timeout en ms (default: 20000)
 * @returns {Promise<object>}  - response.data.data (ya validado)
 * @throws {Error}             - Si hay errores GraphQL o HTTP
 */
async function mondayQuery(accessToken, query, variables = {}, timeout = DEFAULT_TIMEOUT_MS) {
  const response = await axios.post(
    MONDAY_API_URL,
    { query, variables },
    {
      headers: {
        Authorization: accessToken,
        'Content-Type': 'application/json',
        'API-Version': MONDAY_API_VERSION,
      },
      timeout,
    }
  );

  // Errores manejados por Monday (200 OK con campo errors)
  // Ref: "error manejado (respuesta 200) → Promise RESUELTA con la respuesta"
  if (response.data.errors?.length) {
    const msg = response.data.errors.map(e => e.message).join('; ');
    throw new Error(`GraphQL error: ${msg}`);
  }

  return response.data.data;
}

/**
 * Obtiene un item de Monday.com con todos sus column_values y subitems.
 * Usa variables GraphQL — nunca concatena item_id directamente.
 *
 * @param {string} accessToken
 * @param {string|number} itemId
 * @param {string} columnFragment - GRAPHQL_COLUMN_FRAGMENT
 */
async function getMondayItem(accessToken, itemId, columnFragment) {
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

  const data = await mondayQuery(accessToken, query, { ids: [String(id)] });
  const items = data?.items;
  if (!items?.length) return null;
  return items[0];
}

/**
 * Obtiene un board con sus items (primera página).
 *
 * @param {string} accessToken
 * @param {string|number} boardId
 * @param {number} [limit=50]
 * @param {string} [columnFragment]
 */
async function getMondayBoard(accessToken, boardId, limit = 50, columnFragment = 'id text') {
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

  const data = await mondayQuery(accessToken, query, { ids: [String(id)], limit });
  const boards = data?.boards;
  if (!boards?.length) return null;
  return boards[0];
}

/**
 * Crea un update (comentario) en un item de Monday.com.
 * Los valores se pasan como variables, nunca interpolados.
 *
 * @param {string} accessToken
 * @param {string|number} itemId
 * @param {string} body - Texto del comentario
 */
async function createMondayUpdate(accessToken, itemId, body) {
  const id = parseInt(itemId, 10);
  if (!id || isNaN(id)) throw new Error(`itemId inválido: ${itemId}`);

  // body se pasa como variable → no hay injection posible
  const query = `
    mutation CreateUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }
  `;

  return mondayQuery(accessToken, query, { itemId: String(id), body });
}

module.exports = { mondayQuery, getMondayItem, getMondayBoard, createMondayUpdate };
