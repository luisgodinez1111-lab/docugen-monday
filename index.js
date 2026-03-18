// ── #10 SENTRY — must be first require for full auto-instrumentation ──────
const Sentry = require('@sentry/node');
Sentry.init({
  dsn:              process.env.SENTRY_DSN,
  environment:      process.env.NODE_ENV || 'development',
  enabled:          !!process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  beforeSend(event) {
    // Scrub sensitive fields before sending
    if (event.request?.headers?.authorization) event.request.headers.authorization = '[REDACTED]';
    if (event.request?.data?.accessToken)       event.request.data.accessToken       = '[REDACTED]';
    if (event.request?.data?.signature_data)    event.request.data.signature_data    = '[REDACTED]';
    return event;
  },
});

const dotenv = require('dotenv');
dotenv.config();

// FIX-29: Validate env vars at startup — must come after dotenv.config()
// Wrapped in try-catch so the port can still bind and /healthz can respond
// (Railway health check runs during startup — must not block on this)
try { require('./src/config/env'); } catch (envErr) {
  console.error('[STARTUP] env validation error:', envErr.message);
  // Don't exit — let the server start so /healthz responds, then fail gracefully
}

const path = require('path');
const fs = require('fs');

// ── OBSERVABILITY ──
// Pino logger (structured JSON in prod, pretty in dev)
let logger;
try {
  const pino = require('pino');
  const isDev = process.env.NODE_ENV !== 'production';
  logger = pino(
    {
      level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
      base: { service: 'docugen-backend' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: ['accessToken', 'req.headers.authorization'], censor: '[REDACTED]' },
    },
    isDev
      ? pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' } })
      : process.stdout
  );
} catch {
  logger = {
    info:  (...args) => console.log('[INFO]',  ...args),
    warn:  (...args) => console.warn('[WARN]',  ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    debug: (...args) => process.env.NODE_ENV !== 'production' && console.log('[DEBUG]', ...args),
    child: () => logger,
  };
}

// ── UTILITIES ──
const { escapeHtml, sanitizeStr, sanitizeInput } = require('./src/utils/strings');
const { GRAPHQL_COLUMN_FRAGMENT, convertDocxToPdf, toVarName, extractColumnValue,
        numeroALetras, calcularTotales } = require('./src/utils/docx');
const { ENC_KEY, encryptToken, decryptToken, generateDocHash } = require('./src/utils/crypto');
const { parsePagination } = require('./src/utils/pagination');
const { withRetry } = require('./src/utils/retry');
const { emailSignRequest, emailSignConfirm } = require('./src/utils/email-templates');
const { verifyWorkflowJWT, severityError } = require('./src/utils/monday-workflows');
const { signPage, signedPage, expiredPage, generateAuditCertificate } = require('./src/utils/html-pages');
const { getMondayItem, getMondayBoard, createMondayUpdate, mondayQuery } = require('./src/utils/graphql');
const { generateOtp, hashOtp, verifyOtp } = require('./src/utils/otp');
const { getTimestamp } = require('./src/utils/tsa');
const { mondayBreaker, resendBreaker, tsaBreaker } = require('./src/utils/circuit-breaker');

// ── SERVICES ──
const { pool, withTransaction, initDB } = require('./src/services/db.service');
const { saveToken, getToken } = require('./src/services/auth.service');
const { requireAuth } = require('./src/middleware/auth');
const { PLAN_LIMITS, getPlanLimits, checkSubscription, incrementDocsUsed,
        getAccountPlanLimits, getMonthlyUsage } = require('./src/services/billing.service');
const { logError } = require('./src/services/error-log.service');
const { injectGlobalSettings, createDocxtemplater } = require('./src/services/template.service');
const { processDeletionQueue } = require('./src/services/lifecycle.service');
const { sendEmail, sendSignatureEmail, sendApprovalEmails } = require('./src/services/email.service');
const { checkDocLimit, checkSigLimit, requireSubscription } = require('./src/middleware/billing');
const { runBackup } = require('./src/services/backup.service');
const { executeAutomation, processPendingTriggers, runScheduledAutomations } = require('./src/services/automation.service');
const { verifyMondayHmac } = require('./src/middleware/hmac');
const { makeRateLimiter } = require('./src/middleware/rateLimit');

// ── #3 RATE LIMIT POR ACCOUNT_ID ──────
const { DOC_RATE_MAX, DOC_RATE_WINDOW } = require('./src/utils/config');
const docGenRateLimit = makeRateLimiter(DOC_RATE_MAX, DOC_RATE_WINDOW);

// ── OUTPUT DIRECTORY ── (Railway: /tmp is writable; local: outputs/ dir)
const outputsDir = process.env.RAILWAY_ENVIRONMENT ? '/tmp/outputs' : path.join(__dirname, 'outputs');
try { if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true }); } catch {}

// ── EMAIL QUEUE (optional Redis) ──
let enqueueEmailJob = null;
try {
  enqueueEmailJob = require('./src/queues/email.queue').enqueueEmailJob;
} catch { /* Redis not configured — direct send fallback is used */ }

// ── ASSEMBLE APP — grouped namespaces replace the 40-param flat object ──────
const createApp = require('./src/app');
const app = createApp({
  // ── Infrastructure ──
  pool, withTransaction, initDB, logger, Sentry, outputsDir,
  // ── Auth / Security ──
  saveToken, getToken, requireAuth, verifyMondayHmac,
  encryptToken, decryptToken, generateDocHash,
  generateOtp, hashOtp, verifyOtp,
  // ── Billing ──
  checkDocLimit, checkSigLimit, requireSubscription,
  PLAN_LIMITS, getPlanLimits, checkSubscription, incrementDocsUsed,
  getAccountPlanLimits, getMonthlyUsage,
  // ── Document generation ──
  injectGlobalSettings, createDocxtemplater,
  GRAPHQL_COLUMN_FRAGMENT, convertDocxToPdf, toVarName, extractColumnValue,
  numeroALetras, calcularTotales,
  // ── Monday.com integration ──
  getMondayItem, getMondayBoard, createMondayUpdate, mondayQuery,
  verifyWorkflowJWT, severityError,
  mondayBreaker, resendBreaker, tsaBreaker,
  // ── Email / Signatures ──
  sendEmail, sendSignatureEmail, sendApprovalEmails,
  emailSignRequest, emailSignConfirm,
  signPage, signedPage, expiredPage, generateAuditCertificate,
  // ── Automations / Background ──
  executeAutomation, processPendingTriggers, runScheduledAutomations,
  processDeletionQueue, runBackup,
  // ── Utilities ──
  sanitizeStr, escapeHtml, sanitizeInput,
  parsePagination, withRetry,
  logError, docGenRateLimit,
  getTimestamp,
});

// ── CRON JOBS ──
// When Redis is available: distributed cron via BullMQ (registered after server starts).
// When Redis is not available: fall back to node-cron running in-process.
if (!process.env.REDIS_URL) {
  const cron = require('node-cron');
  cron.schedule('* * * * *', () => processPendingTriggers().catch(console.error));
  cron.schedule('* * * * *', () => runScheduledAutomations().catch(console.error));
  cron.schedule('0 3 * * *', () => processDeletionQueue().catch(console.error));
  cron.schedule('0 2 * * *', () => runBackup().catch(console.error));
  logger.info('Local cron jobs started (Redis not configured)');
}

// ── STARTUP: bind port FIRST so /healthz responds immediately ──
// Railway health check fires as soon as the container starts.
// We must be listening on PORT before initDB() runs — otherwise the
// health check times out while waiting for DB migrations to finish.
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'DocuGen HTTP server listening');

  // Init DB asynchronously after port is bound
  initDB(logger).then(() => {
    logger.info({ port: PORT, appId: process.env.MONDAY_APP_ID }, 'DocuGen server ready — DB initialised');

    // ── EMAIL / BULK / CRON WORKERS (Redis-conditional) ──
    if (process.env.REDIS_URL) {
      try { require('./src/workers/email.worker'); }
      catch (workerErr) { logger.warn({ err: workerErr.message }, 'Email worker failed to start'); }

      try { require('./src/workers/bulk.worker'); }
      catch (workerErr) { logger.warn({ err: workerErr.message }, 'Bulk worker failed to start'); }

      try {
        require('./src/workers/cron.worker');
        const { registerCronJobs } = require('./src/queues/cron.queue');
        registerCronJobs().then(() => {
          logger.info('Cron jobs registered');
        }).catch(err => {
          logger.warn({ err: err.message }, 'Failed to register cron jobs');
        });
      } catch (workerErr) {
        logger.warn({ err: workerErr.message }, 'Cron worker failed to start');
      }
    }
  }).catch(err => {
    // Log the error clearly so Railway logs show the real cause
    logger.error({ err: err.message, stack: err.stack }, 'FATAL: initDB failed');
    process.exit(1);
  });
});

module.exports = app;
