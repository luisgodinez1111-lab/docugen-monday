/**
 * src/queues/pdf.queue.ts
 * BullMQ queue for async PDF generation.
 *
 * Jobs are enqueued by the /generate-pdf-async endpoint and processed
 * by a PDF worker. Falls back to synchronous processing when Redis is
 * not available.
 *
 * BullMQ bundles its own ioredis, so we pass the Redis URL string
 * directly instead of an IORedis instance to avoid type conflicts.
 */
import { Queue, type QueueOptions } from 'bullmq';
import { REDIS_URL, redisAvailable } from './connection';
import { logger } from '../shared/logger';

export interface PdfJobPayload {
  jobId: string;
  accountId: string;
  accessToken: string;
  boardId: string;
  itemId: string;
  templateName: string;
  /** base64-encoded DOCX template data */
  templateBase64: string;
}

export interface PdfJobResult {
  jobId: string;
  filename: string;
  storedDocId: number;
}

const QUEUE_NAME = 'pdf-generation';

const queueOpts: QueueOptions = {
  // Pass URL string — BullMQ uses its own bundled ioredis
  connection: { url: REDIS_URL! } as unknown as QueueOptions['connection'],
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 3_600, count: 500 }, // keep 1h or 500 jobs
    removeOnFail: { age: 86_400 },                // keep failures 24h
  },
};

export let pdfQueue: Queue<PdfJobPayload, PdfJobResult> | null = null;

if (redisAvailable && REDIS_URL) {
  pdfQueue = new Queue<PdfJobPayload, PdfJobResult>(QUEUE_NAME, queueOpts);
  logger.info({ queue: QUEUE_NAME }, 'BullMQ pdf queue initialised');
}

/**
 * Add a PDF generation job to the queue.
 * Returns the BullMQ job id or null when queues are disabled.
 */
export async function enqueuePdfJob(
  payload: PdfJobPayload
): Promise<string | null> {
  if (!pdfQueue) return null;
  const job = await pdfQueue.add('generate-pdf', payload, {
    jobId: payload.jobId,
  });
  logger.info({ jobId: job.id }, 'PDF job enqueued');
  return job.id ?? null;
}
