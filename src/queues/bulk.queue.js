'use strict';
/**
 * src/queues/bulk.queue.js
 * BullMQ queue for async bulk document generation.
 */
const { Queue } = require('bullmq');
const { REDIS_URL, redisAvailable } = require('./connection');
const { logger } = require('../shared/logger');

const QUEUE_NAME = 'bulk-generation';

let bulkQueue = null;

if (redisAvailable && REDIS_URL) {
  bulkQueue = new Queue(QUEUE_NAME, {
    connection: { url: REDIS_URL },
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 3_000 },
      removeOnComplete: { age: 3_600, count: 1000 },
      removeOnFail:     { age: 86_400 },
    },
  });
  logger.info({ queue: QUEUE_NAME }, 'BullMQ bulk queue initialised');
}

async function enqueueBulkItem(payload) {
  if (!bulkQueue) return null;
  const job = await bulkQueue.add('process-item', payload);
  return job.id ?? null;
}

module.exports = { bulkQueue, enqueueBulkItem };
