'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const Sentry = require('@sentry/node');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./docs/openapi');

module.exports = function createApp(deps) {
  const { logger, sanitizeStr, requireAuth, pool } = deps;

  const app = express();
  app.use(helmet.hsts({ maxAge: 31536000, includeSubDomains: true, preload: true }));

  // P3-1: CORS restringido a orígenes de Monday.com y la propia app
  const ALLOWED_ORIGINS = [
    'https://monday.com',
    process.env.APP_URL,
  ].filter(Boolean);

  app.use(cors({
    origin: (origin, cb) => {
      // Permitir: sin origin (curl, server-to-server), orígenes *.monday.com, APP_URL
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/.*\.monday\.com$/.test(origin)) {
        return cb(null, true);
      }
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '2mb' }));

  // FIX-33: X-Frame-Options ALLOW-FROM removed (deprecated) — CSP frame-ancestors handles this
  // FIX-34: Duplicate HSTS and X-XSS-Protection removed — helmet already sets them
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // ── SANITIZE REQ.BODY MIDDLEWARE ──
  app.use((req, res, next) => {
    // P2-3: Recursively sanitize all string leaves, including nested objects like 'settings'
    function sanitizeDeep(obj, depth = 0) {
      if (depth > 10) return typeof obj === 'string' ? '[TRUNCATED]' : obj;
      if (typeof obj === 'string') return sanitizeStr(obj);
      if (Array.isArray(obj)) return obj.map(item => sanitizeDeep(item, depth + 1));
      if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = sanitizeDeep(v, depth + 1);
        return out;
      }
      return obj;
    }
    if (req.body && typeof req.body === 'object') {
      const skipKeys = ['event', 'data', 'signature_data', 'challenge'];
      for (const key of Object.keys(req.body)) {
        if (!skipKeys.includes(key)) {
          req.body[key] = sanitizeDeep(req.body[key]);
        }
      }
    }
    next();
  });

  // ── SWAGGER / API DOCS ──
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'DocuGen API Docs',
  }));

  // ── STATIC FILES ──
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ── MOUNT ROUTE FACTORIES ──
  app.use('/', require('./routes/static.routes')(deps));
  app.use('/', require('./routes/oauth.routes')(deps));
  app.use('/', require('./routes/settings.routes')(deps));
  app.use('/', require('./routes/templates.routes')(deps));
  app.use('/', require('./routes/documents.routes')(deps));
  app.use('/', require('./routes/subscription.routes')(deps));
  app.use('/', require('./routes/signatures.routes')(deps));
  app.use('/', require('./routes/automations.routes')(deps));
  app.use('/', require('./routes/workflows.routes')(deps));
  app.use('/', require('./routes/admin.routes')(deps));

  // ── STATIC HTML VIEWS ──
  app.get('/view', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'view.html')); });
  app.get('/editor', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'editor.html')); });
  app.get('/dashboard', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')); });

  // Instructions page (iframe-embeddable para Monday Marketplace)
  // FIX-33: X-Frame-Options ALLOW-FROM removed (deprecated) — use CSP frame-ancestors only
  app.get('/instructions', (req, res) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.monday.com");
    res.sendFile(path.join(__dirname, '..', 'public', 'instructions.html'));
  });

  // ── NEXLABS LEGAL PAGES ──
  app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html')));
  app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'terms.html')));

  // P1-1: Debug endpoints — solo disponibles en desarrollo, con auth, sin exponer OTP codes
  if (process.env.NODE_ENV !== 'production') {
    app.get('/debug-sigs', requireAuth, async (req, res) => {
      try {
        // otp_code ELIMINADO de la query — nunca exponer OTPs activos
        const r = await pool.query(
          'SELECT id, token, signer_name, signer_email, status, document_filename, item_id, created_at FROM signature_requests WHERE account_id=$1 ORDER BY created_at DESC LIMIT 5',
          [req.accountId]
        );
        res.json(r.rows);
      } catch(e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/debug-docs', requireAuth, async (req, res) => {
      try {
        const r = await pool.query(
          'SELECT id, filename, template_name, item_id, created_at, doc_data IS NOT NULL as has_data, length(doc_data) as data_size FROM documents WHERE account_id=$1 ORDER BY created_at DESC LIMIT 15',
          [req.accountId]
        );
        res.json(r.rows);
      } catch(e) { res.status(500).json({ error: e.message }); }
    });
  } else {
    // En producción: rutas debug devuelven 404
    app.get('/debug-sigs', (_, res) => res.status(404).end());
    app.get('/debug-docs', (_, res) => res.status(404).end());
  }

  // ── #10 SENTRY EXPRESS ERROR HANDLER (must be after all routes, before custom error handler) ──
  Sentry.setupExpressErrorHandler(app);

  // ── GLOBAL ERROR HANDLER ──────────────────────────────────────────────────
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.code === 'CIRCUIT_OPEN') {
      return res.status(503).json({ error: 'Servicio temporalmente no disponible. Intenta en unos minutos.', code: 'CIRCUIT_OPEN' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Payload demasiado grande' });
    }
    logger.error({ err: err.message, path: req.path }, 'Unhandled error');
    Sentry.captureException(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

  return app;
};
