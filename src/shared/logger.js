'use strict';
/**
 * src/shared/logger.js
 * Pino structured JSON logger — single instance shared by queues and workers.
 */
const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    base: { service: 'docugen-backend' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['accessToken', 'req.headers.authorization', 'TOKEN_ENCRYPTION_KEY', 'MONDAY_CLIENT_SECRET'],
      censor: '[REDACTED]',
    },
  },
  isDev
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' } })
    : pino.destination({ sync: false })
);

function childLogger(context) {
  return logger.child(context);
}

module.exports = { logger, childLogger };
