/**
 * src/queues/email.queue.ts
 * BullMQ queue for async email delivery via Resend.
 *
 * When Redis is available: emails are enqueued and processed by email.worker.ts
 * with 3 retry attempts and exponential backoff.
 * When Redis is unavailable: enqueueEmailJob() returns null and the caller
 * falls back to direct Resend API calls.
 *
 * Mirrors the pattern established in pdf.queue.ts.
 */
import { Queue, type QueueOptions } from 'bullmq';
import { REDIS_URL, redisAvailable } from './connection';
import { logger } from '../shared/logger';

export interface EmailJobPayload {
  /** Recipient address(es) */
  to: string | string[];
  subject: string;
  html: string;
  /** Sender override — defaults to process.env.SMTP_FROM */
  from?: string;
  /** Job classification for logging and alerting */
  type: 'sign_request' | 'sign_confirm' | 'otp' | 'approval' | 'reminder' | 'generic';
  /** Metadata for observability */
  accountId?: string;
  token?: string;
}

export interface EmailJobResult {
  messageId: string;
}

const QUEUE_NAME = 'email-send';

const queueOpts: QueueOptions = {
  connection: { url: REDIS_URL! } as unknown as QueueOptions['connection'],
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3_600, count: 200 },  // keep 1h or 200 jobs
    removeOnFail:    { age: 86_400 },               // keep failures 24h for inspection
  },
};

export let emailQueue: Queue<EmailJobPayload, EmailJobResult> | null = null;

if (redisAvailable && REDIS_URL) {
  emailQueue = new Queue<EmailJobPayload, EmailJobResult>(QUEUE_NAME, queueOpts);
  logger.info({ queue: QUEUE_NAME }, 'BullMQ email queue initialised');
}

/**
 * Enqueue an email job.
 * Returns the BullMQ job id when queued, or null when queuing is disabled.
 * The caller must implement a direct-send fallback when null is returned.
 */
export async function enqueueEmailJob(
  payload: EmailJobPayload
): Promise<string | null> {
  if (!emailQueue) return null;
  const job = await emailQueue.add('send-email', payload);
  logger.info({ jobId: job.id, type: payload.type, to: payload.to }, 'Email job enqueued');
  return job.id ?? null;
}
