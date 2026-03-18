'use strict';
/**
 * src/workers/email.worker.js
 * BullMQ worker — processes email-send jobs using Resend SDK.
 */
const { Worker } = require('bullmq');
const { Resend } = require('resend');
const { REDIS_URL, redisAvailable } = require('../queues/connection');
const { logger } = require('../shared/logger');

const QUEUE_NAME = 'email-send';

if (redisAvailable && REDIS_URL) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { to, subject, html, from, type, accountId, token } = job.data;
      const sender = from ?? process.env.SMTP_FROM ?? 'DocuGen <onboarding@resend.dev>';
      const recipients = Array.isArray(to) ? to : [to];

      logger.info({ jobId: job.id, type, to: recipients, accountId, token }, 'Email worker: sending');

      const result = await resend.emails.send({ from: sender, to: recipients, subject, html });

      logger.info({ jobId: job.id, type, messageId: result.id }, 'Email worker: sent successfully');
      return { messageId: result.id ?? '' };
    },
    { connection: { url: REDIS_URL }, concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, type: job?.data?.type, err: err.message }, 'Email worker: job failed');
  });

  logger.info({ queue: QUEUE_NAME, concurrency: 5 }, 'Email worker started');
}
