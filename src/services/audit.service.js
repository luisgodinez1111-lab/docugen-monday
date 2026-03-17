'use strict';

/**
 * Log a document lifecycle event.
 * @param {object} client - pg client (or pool for auto-transaction)
 * @param {object} event
 * @param {number|string} event.documentId
 * @param {string} event.eventType - 'created'|'downloaded'|'signed'|'deleted'|'restored'
 * @param {string} [event.actorId] - account_id
 * @param {object} [event.metadata] - extra JSON data
 */
async function logDocumentEvent(client, { documentId, eventType, actorId = null, metadata = null }) {
  await client.query(
    `INSERT INTO document_events (document_id, event_type, actor_id, metadata)
     VALUES ($1, $2, $3, $4)`,
    [documentId, eventType, actorId, metadata ? JSON.stringify(metadata) : null]
  );
}

module.exports = { logDocumentEvent };
