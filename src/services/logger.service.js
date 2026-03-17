'use strict';

/**
 * src/services/logger.service.js
 * Singleton pino logger for use inside services/ (not via DI).
 * Route factories receive logger via deps — services use this module directly.
 */

let logger;
try {
  const pino   = require('pino');
  const isDev  = process.env.NODE_ENV !== 'production';
  logger = pino(
    {
      level:  process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
      base:   { service: 'docugen-backend' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: ['accessToken', 'req.headers.authorization'], censor: '[REDACTED]' },
    },
    isDev
      ? pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' } })
      : process.stdout
  );
} catch {
  logger = {
    info:  (...a) => console.log('[INFO]',  ...a),
    warn:  (...a) => console.warn('[WARN]',  ...a),
    error: (...a) => console.error('[ERROR]', ...a),
    debug: (...a) => process.env.NODE_ENV !== 'production' && console.log('[DEBUG]', ...a),
    child: function() { return this; },
  };
}

module.exports = logger;
