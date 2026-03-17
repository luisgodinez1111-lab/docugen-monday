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
      console.error('[HMAC] MONDAY_SIGNING_SECRET no configurado — endpoint desprotegido');
      return res.status(500).json({ error: 'Server misconfiguration: missing signing secret' });
    }

    const authHeader = req.headers['authorization'] || '';
    if (!authHeader) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const rawBody = JSON.stringify(req.body);
    const expected = crypto
      .createHmac('sha256', signingSecret)
      .update(rawBody)
      .digest('hex');

    // timingSafeEqual previene timing attacks
    try {
      const expectedBuf = Buffer.from(expected, 'hex');
      const receivedBuf = Buffer.from(authHeader.replace(/^sha256=/, ''), 'hex');

      if (
        expectedBuf.length !== receivedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, receivedBuf)
      ) {
        console.warn('[HMAC] Firma inválida — posible request falsificado');
        return res.status(401).json({ error: 'Invalid HMAC signature' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid Authorization format' });
    }

    next();
  };
}

module.exports = { verifyMondayHmac };
