'use strict';
/**
 * src/queues/cron.queue.js
 * BullMQ queue for distributed cron job scheduling.
 */
const { Queue } = require('bullmq');
const { REDIS_URL, redisAvailable } = require('./connection');
const { logger } = require('../shared/logger');

const QUEUE_NAME = 'cron';

let cronQueue = null;

if (redisAvailable && REDIS_URL) {
  cronQueue = new Queue(QUEUE_NAME, {
    connection: { url: REDIS_URL },
  });
  logger.info({ queue: QUEUE_NAME }, 'BullMQ cron queue initialised');
}

async function registerCronJobs() {
  if (!cronQueue) {
    logger.warn('Cron queue not initialised — Redis not configured');
    return;
  }

  // Remove existing repeatable jobs to prevent duplicates on restart
  const existing = await cronQueue.getRepeatableJobs();
  for (const job of existing) {
    await cronQueue.removeRepeatableByKey(job.key);
    logger.info({ key: job.key }, 'Removed existing repeatable job');
  }

  const jobs = [
    { name: 'processPendingTriggers',  pattern: '* * * * *' },
    { name: 'runScheduledAutomations', pattern: '* * * * *' },
    { name: 'processDeletionQueue',    pattern: '0 3 * * *' },
    { name: 'runBackup',               pattern: '0 2 * * *' },
  ];

  for (const job of jobs) {
    await cronQueue.add(job.name, {}, {
      repeat: { pattern: job.pattern },
      removeOnComplete: 10,
      removeOnFail: 5,
    });
    logger.info({ job: job.name, pattern: job.pattern }, 'Cron job registered');
  }
}

module.exports = { cronQueue, registerCronJobs };
