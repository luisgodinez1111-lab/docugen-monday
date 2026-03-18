/**
 * src/middleware/hmac.js
 * Verificación de firma HMAC-SHA256 para webhooks de Monday.com.
 * Usado en: /webhooks/monday y /monday/lifecycle
 *
 * Monday envía la firma en el header Authorization como el hex digest
 * del body firmado con MONDAY_SIGNING_SECRET.
 */
const crypto = require('crypto');

/**
 * Middleware Express que valida la firma HMAC de Monday.com.
 * Rechaza con 401 si falta el secret, falta el header, o no coincide.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.allowChallenge=true] - Deja pasar requests de challenge sin firma
 */
function verifyMondayHmac(opts = {}) {
  const { allowChallenge = true } = opts;

  return (req, res, next) => {
    // Challenge de Monday.com no lleva firma — es el handshake inicial
    if (allowChallenge && req.body?.challenge) return next();

    const signingSecret = process.env.MONDAY_SIGNING_SECRET;
    if (!signingSecret) {
      try { require('../services/logger.service').error({}, '[HMAC] MONDAY_SIGNING_SECRET no configurado — endpoint desprotegido'); } catch {}
      return res.status(500).json({ error: 'Server misconfiguration: missing signing secret' });
    }

    const authHeader = req.headers['authorization'] || '';
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const rawBody = JSON.stringify(req.body);
    const expectedBuf = Buffer.from(
      crypto.createHmac('sha256', signingSecret).update(rawBody).digest('hex'),
      'hex'
    );

    // FIX-5: Double-HMAC comparison — both digests are always 32 bytes regardless of input length.
    // This prevents timing attacks from the early-exit length check.
    try {
      const receivedRaw = Buffer.from(authHeader.replace(/^sha256=/, ''), 'hex');
      // Derive fixed-length MACs so timingSafeEqual always compares 32 bytes
      const secret32 = Buffer.from(signingSecret);
      const hashExpected = crypto.createHmac('sha256', secret32).update(expectedBuf).digest();
      const hashReceived = crypto.createHmac('sha256', secret32).update(receivedRaw).digest();

      if (hashExpected.length !== hashReceived.length || !crypto.timingSafeEqual(hashExpected, hashReceived)) {
        try { require('../services/logger.service').warn({}, '[HMAC] Firma inválida — posible request falsificado'); } catch {}
        return res.status(401).json({ error: 'Invalid HMAC signature' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid Authorization format' });
    }

    next();
  };
}

module.exports = { verifyMondayHmac };
