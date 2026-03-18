'use strict';
/**
 * src/queues/email.queue.js
 * BullMQ queue for async email delivery via Resend.
 */
const { Queue } = require('bullmq');
const { REDIS_URL, redisAvailable } = require('./connection');
const { logger } = require('../shared/logger');

const QUEUE_NAME = 'email-send';

let emailQueue = null;

if (redisAvailable && REDIS_URL) {
  emailQueue = new Queue(QUEUE_NAME, {
    connection: { url: REDIS_URL },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 3_600, count: 200 },
      removeOnFail:     { age: 86_400 },
    },
  });
  logger.info({ queue: QUEUE_NAME }, 'BullMQ email queue initialised');
}

async function enqueueEmailJob(payload) {
  if (!emailQueue) return null;
  const job = await emailQueue.add('send-email', payload);
  logger.info({ jobId: job.id, type: payload.type, to: payload.to }, 'Email job enqueued');
  return job.id ?? null;
}

module.exports = { emailQueue, enqueueEmailJob };
