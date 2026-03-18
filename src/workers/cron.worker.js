'use strict';
/**
 * src/workers/cron.worker.js
 * BullMQ worker — processes distributed cron jobs.
 * Concurrency=1: jobs run serially (no overlap across replicas).
 */
const { Worker } = require('bullmq');
const { REDIS_URL, redisAvailable } = require('../queues/connection');
const { logger } = require('../shared/logger');

const QUEUE_NAME = 'cron';

async function processJob(job) {
  switch (job.name) {
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
  const worker = new Worker(QUEUE_NAME, processJob, {
    connection: { url: REDIS_URL },
    concurrency: 1,
  });

  worker.on('completed', (job) => {
    logger.info({ job: job.name, durationMs: Date.now() - job.timestamp }, 'Cron worker: job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ job: job?.name, err: err.message }, 'Cron worker: job failed');
  });

  logger.info({ queue: QUEUE_NAME, concurrency: 1 }, 'Cron worker started');
}
