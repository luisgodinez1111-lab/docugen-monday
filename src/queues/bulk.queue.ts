/**
 * src/queues/bulk.queue.ts
 * BullMQ queue for async bulk document generation.
 * Each job processes one item in a bulk generation request.
 */
import { Queue, type QueueOptions } from 'bullmq';
import { REDIS_URL, redisAvailable } from './connection';
import { logger } from '../shared/logger';

export interface BulkItemPayload {
  bulkJobId:    string;
  accountId:    string;
  itemId:       string;
  boardId:      string;
  templateName: string;
  accessToken:  string;
}

const QUEUE_NAME = 'bulk-generation';

const queueOpts: QueueOptions = {
  connection: { url: REDIS_URL! } as unknown as QueueOptions['connection'],
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3_000 },
    removeOnComplete: { age: 3_600, count: 1000 },
    removeOnFail:     { age: 86_400 },
  },
};

export let bulkQueue: Queue<BulkItemPayload> | null = null;

if (redisAvailable && REDIS_URL) {
  bulkQueue = new Queue<BulkItemPayload>(QUEUE_NAME, queueOpts);
  logger.info({ queue: QUEUE_NAME }, 'BullMQ bulk queue initialised');
}

export async function enqueueBulkItem(payload: BulkItemPayload): Promise<string | null> {
  if (!bulkQueue) return null;
  const job = await bulkQueue.add('process-item', payload);
  return job.id ?? null;
}
