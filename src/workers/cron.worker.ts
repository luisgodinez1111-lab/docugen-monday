/**
 * src/workers/cron.worker.ts
 * BullMQ worker that processes distributed cron jobs.
 *
 * Registered by index.js when REDIS_URL is configured.
 * Concurrency is set to 1 so cron jobs run serially (no overlap).
 *
 * Using lazy require() for service imports to avoid circular dependency
 * issues at module load time.
 */
import { Worker, type Job } from 'bullmq';
import { REDIS_URL, redisAvailable } from '../queues/connection';
import { logger } from '../shared/logger';
import type { CronJobName } from '../queues/cron.queue';

const QUEUE_NAME = 'cron';

async function processJob(job: Job): Promise<void> {
  switch (job.name as CronJobName) {
    case 'processPendingTriggers': {
      const { processPendingTriggers } = require('../services/automation.service');
      await processPendingTriggers();
      break;
    }
    case 'runScheduledAutomations': {
      const { runScheduledAutomations } = require('../services/automation.service');
      await runScheduledAutomations();
      break;
    }
    case 'processDeletionQueue': {
      const { processDeletionQueue } = require('../services/lifecycle.service');
      await processDeletionQueue();
      break;
    }
    case 'runBackup': {
      const { runBackup } = require('../services/backup.service');
      await runBackup();
      break;
    }
    default:
      throw new Error(`Unknown cron job: ${job.name}`);
  }
}

if (redisAvailable && REDIS_URL) {
  const worker = new Worker(
    QUEUE_NAME,
    processJob,
    {
      connection: { url: REDIS_URL! } as any,
      concurrency: 1, // run one cron job at a time
    }
  );

  worker.on('completed', (job) => {
    logger.info(
      { job: job.name, durationMs: Date.now() - job.timestamp },
      'Cron worker: job completed'
    );
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { job: job?.name, err: err.message },
      'Cron worker: job failed'
    );
  });

  logger.info({ queue: QUEUE_NAME, concurrency: 1 }, 'Cron worker started');
}
