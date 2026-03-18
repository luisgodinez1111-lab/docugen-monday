'use strict';

/**
 * Parses ?page and ?limit query params.
 * @param {object} query - req.query
 * @param {number} [defaultLimit=20]
 * @param {number} [maxLimit=100]
 * @returns {{ page: number, limit: number, offset: number }}
 */
function parsePagination(query, defaultLimit = 20, maxLimit = 100) {
  const limit  = Math.min(Math.max(parseInt(query.limit,  10) || defaultLimit, 1), maxLimit);
  const page   = Math.max(parseInt(query.page, 10) || 1, 1);
  const offset = (page - 1) * limit;
  return { limit, page, offset };
}

module.exports = { parsePagination };
