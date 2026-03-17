/**
 * src/workers/bulk.worker.ts
 * BullMQ worker for async bulk document generation.
 * Processes one item per job, updates bulk_jobs progress atomically.
 */
import { Worker, type Job } from 'bullmq';
import { REDIS_URL, redisAvailable } from '../queues/connection';
import { logger } from '../shared/logger';
import type { BulkItemPayload } from '../queues/bulk.queue';

const QUEUE_NAME = 'bulk-generation';

async function processItem(job: Job<BulkItemPayload>): Promise<void> {
  const { bulkJobId, accountId, itemId, boardId, templateName, accessToken } = job.data;

  // Lazy require to avoid circular deps at module load
  const { executeAutomation } = require('../services/automation.service');
  const { pool }              = require('../services/db.service');

  const result = await executeAutomation(accountId, itemId, boardId, templateName, accessToken);

  // Atomic counter increment + results append
  if (result.success) {
    await pool.query(
      `UPDATE bulk_jobs
       SET completed  = completed + 1,
           results    = results || $1::jsonb,
           updated_at = NOW(),
           status     = CASE WHEN completed + 1 + failed = total THEN 'done' ELSE status END
       WHERE id = $2`,
      [JSON.stringify([{ item_id: itemId, success: true, filename: result.filename }]), bulkJobId]
    );
  } else {
    await pool.query(
      `UPDATE bulk_jobs
       SET failed     = failed + 1,
           results    = results || $1::jsonb,
           updated_at = NOW(),
           status     = CASE WHEN completed + failed + 1 = total THEN 'done' ELSE status END
       WHERE id = $2`,
      [JSON.stringify([{ item_id: itemId, success: false, error: result.error }]), bulkJobId]
    );
    logger.warn({ itemId, accountId, error: result.error }, 'Bulk item failed');
  }
}

export let bulkWorker: Worker | null = null;

if (redisAvailable && REDIS_URL) {
  bulkWorker = new Worker<BulkItemPayload>(
    QUEUE_NAME,
    processItem,
    {
      connection:  { url: REDIS_URL } as any,
      concurrency: 5,
    }
  );

  bulkWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Bulk worker job failed');
  });

  logger.info({ queue: QUEUE_NAME, concurrency: 5 }, 'Bulk worker started');
}
