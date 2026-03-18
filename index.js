// ── HEALTH CHECK SERVER — zero dependencies, starts in <5ms ──────────────
// This MUST be the very first thing that runs. Railway's health check fires
// immediately on container start. If any require() below crashes, /healthz
// still responds because it runs in a separate http server using only Node builtins.
const _startTime = Date.now();
const _http = require('http');
const _PORT = process.env.PORT || 3000;
let _appHandler = null; // filled in once the full Express app is ready

const _preServer = _http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/healthz/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: (Date.now() - _startTime) / 1000 }));
    return;
  }
  if (_appHandler) {
    _appHandler(req, res); // delegate to full Express app once ready
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Servidor iniciando…', code: 'STARTING_UP' }));
  }
});
_preServer.listen(_PORT, () => {
  console.log(`[STARTUP] HTTP server listening on port ${_PORT} — /healthz ready`);
});

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
    (() => {
      if (!isDev) return process.stdout;
      try { return pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' } }); }
      catch { return process.stdout; } // pino-pretty not installed — fallback to JSON
    })()
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
  // Guard flags prevent overlapping executions when a job takes > 1 minute
  let _triggersRunning = false;
  let _scheduledRunning = false;
  cron.schedule('* * * * *', () => {
    if (_triggersRunning) return;
    _triggersRunning = true;
    processPendingTriggers().catch(console.error).finally(() => { _triggersRunning = false; });
  });
  cron.schedule('* * * * *', () => {
    if (_scheduledRunning) return;
    _scheduledRunning = true;
    runScheduledAutomations().catch(console.error).finally(() => { _scheduledRunning = false; });
  });
  cron.schedule('0 3 * * *', () => processDeletionQueue().catch(console.error));
  cron.schedule('0 2 * * *', () => runBackup().catch(console.error));
  logger.info('Local cron jobs started (Redis not configured)');
}

// ── CONNECT FULL EXPRESS APP TO THE PRE-SERVER ──
// The _preServer is already listening (started at top of file).
// Wire the Express app as the request handler — from this point all
// requests (except /healthz handled above) go through Express.
_appHandler = app;
logger.info({ port: _PORT, env: process.env.NODE_ENV || 'development' }, 'DocuGen Express app wired');

// ── INIT DB WITH RETRY — does not block the health check ──
// Railway DB may not be ready instantly. Retry up to 10 times (50s total)
// before giving up. /healthz keeps responding throughout.
async function startWithRetry(maxAttempts = 10, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initDB(logger);
      logger.info({ port: _PORT, appId: process.env.MONDAY_APP_ID, attempt }, 'DocuGen server ready — DB initialised');

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
      return; // success
    } catch (err) {
      logger.warn({ attempt, maxAttempts, err: err.message }, `initDB attempt ${attempt}/${maxAttempts} failed`);
      if (attempt === maxAttempts) {
        logger.error({ err: err.message }, 'FATAL: DB unreachable after all retries — exiting');
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}
startWithRetry();

module.exports = app;
