/**
 * src/workers/email.worker.ts
 * BullMQ worker that processes email-send jobs using the Resend SDK.
 *
 * Registered by index.js when REDIS_URL is configured.
 * Runs in-process alongside the Express server (suitable for Railway single-instance).
 *
 * Concurrency: 5 emails processed in parallel.
 * Retries:     3 attempts with exponential backoff (configured in email.queue.ts).
 */
import { Worker } from 'bullmq';
import { Resend } from 'resend';
import { REDIS_URL, redisAvailable } from '../queues/connection';
import { logger } from '../shared/logger';
import type { EmailJobPayload, EmailJobResult } from '../queues/email.queue';

const QUEUE_NAME = 'email-send';

if (redisAvailable && REDIS_URL) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const worker = new Worker<EmailJobPayload, EmailJobResult>(
    QUEUE_NAME,
    async (job) => {
      const { to, subject, html, from, type, accountId, token } = job.data;

      const sender =
        from ??
        process.env.SMTP_FROM ??
        'DocuGen <onboarding@resend.dev>';

      const recipients = Array.isArray(to) ? to : [to];

      logger.info(
        { jobId: job.id, type, to: recipients, accountId, token },
        'Email worker: sending'
      );

      const result = await resend.emails.send({
        from:    sender,
        to:      recipients,
        subject,
        html,
      });

      logger.info(
        { jobId: job.id, type, messageId: (result as any).id },
        'Email worker: sent successfully'
      );

      return { messageId: (result as any).id ?? '' };
    },
    {
      connection:  { url: REDIS_URL! } as any,
      concurrency: 5,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, type: job?.data?.type, err: err.message },
      'Email worker: job failed'
    );
  });

  logger.info({ queue: QUEUE_NAME, concurrency: 5 }, 'Email worker started');
}
