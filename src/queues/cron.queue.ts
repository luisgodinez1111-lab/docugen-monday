/**
 * src/queues/cron.queue.ts
 * BullMQ queue for distributed cron job scheduling.
 *
 * When Redis is available: repeatable jobs are registered here and processed
 * by cron.worker.ts — only one instance runs each job across all Railway replicas.
 * When Redis is unavailable: falls back to node-cron in index.js.
 *
 * BullMQ deduplicates repeatable jobs by jobId, so calling registerCronJobs()
 * on every startup is safe — it will not create duplicate schedules.
 */
import { Queue, type QueueOptions } from 'bullmq';
import { REDIS_URL, redisAvailable } from './connection';
import { logger } from '../shared/logger';

export type CronJobName =
  | 'processPendingTriggers'
  | 'runScheduledAutomations'
  | 'processDeletionQueue'
  | 'runBackup';

const QUEUE_NAME = 'cron';

const queueOpts: QueueOptions = {
  connection: { url: REDIS_URL! } as unknown as QueueOptions['connection'],
};

export let cronQueue: Queue | null = null;

if (redisAvailable && REDIS_URL) {
  cronQueue = new Queue(QUEUE_NAME, queueOpts);
  logger.info({ queue: QUEUE_NAME }, 'BullMQ cron queue initialised');
}

/**
 * Register all repeatable cron jobs.
 * FIX-28: Remove existing repeatable jobs first to prevent duplicates on restart.
 * jobId as top-level option doesn't deduplicate repeatables in BullMQ — must use
 * getRepeatableJobs() + removeRepeatableByKey() before re-adding.
 */
export async function registerCronJobs(): Promise<void> {
  if (!cronQueue) {
    logger.warn('Cron queue not initialised — Redis not configured');
    return;
  }

  // Remove existing repeatable jobs to prevent duplicates on restart
  const existing = await (cronQueue as any).getRepeatableJobs();
  for (const job of existing) {
    await (cronQueue as any).removeRepeatableByKey(job.key);
    logger.info({ key: job.key }, 'Removed existing repeatable job');
  }

  const jobs: Array<{ name: CronJobName; pattern: string }> = [
    { name: 'processPendingTriggers',  pattern: '* * * * *' }, // every minute
    { name: 'runScheduledAutomations', pattern: '* * * * *' }, // every minute
    { name: 'processDeletionQueue',    pattern: '0 3 * * *' }, // daily at 3am
    { name: 'runBackup',               pattern: '0 2 * * *' }, // daily at 2am
  ];

  // Add fresh — no jobId at top level (doesn't work for repeatables)
  for (const job of jobs) {
    await (cronQueue as any).add(
      job.name,
      {},
      {
        repeat: { pattern: job.pattern },
        removeOnComplete: 10,
        removeOnFail: 5,
      }
    );
    logger.info({ job: job.name, pattern: job.pattern }, 'Cron job registered');
  }
}
