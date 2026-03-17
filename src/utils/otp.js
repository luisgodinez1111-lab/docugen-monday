/**
 * src/utils/otp.js
 * Generación y verificación segura de OTPs para firma electrónica.
 *
 * CORRECCIONES vs implementación anterior:
 * - Usa crypto.randomInt (criptográficamente seguro) en lugar de Math.random()
 * - Almacena HASH del OTP en BD (nunca el código plano)
 * - Comparación con timingSafeEqual (previene timing attacks)
 * - Expiración verificada en la capa de lógica, no solo en UI
 *
 * ⚖️  Cumplimiento NOM-151-SCFI-2016: el código de identidad debe ser
 *     impredecible. crypto.randomInt usa fuente de entropía del SO.
 */
const crypto = require('crypto');

const OTP_DIGITS = 6;
const OTP_MIN = 100000;
const OTP_MAX = 1000000; // exclusivo → 100000..999999

/**
 * Genera un OTP de 6 dígitos criptográficamente seguro.
 * @returns {string} - código de 6 dígitos (string, puede tener leading zeros si se necesita)
 */
function generateOtp() {
  return crypto.randomInt(OTP_MIN, OTP_MAX).toString();
}

/**
 * Genera el hash del OTP para almacenar en BD.
 * Se usa HMAC con el token del firmante como salt para que el hash
 * sea único por request (evita que un hash robado de otra request sea útil).
 *
 * @param {string} otp        - El código OTP en claro
 * @param {string} signerToken - El token único de la firma (salt)
 * @returns {string}           - hex digest del HMAC-SHA256
 */
function hashOtp(otp, signerToken) {
  // HMAC-SHA256: key = signerToken, data = otp
  // Si el signerToken se rota en cada request, el hash nunca se puede reutilizar
  return crypto.createHmac('sha256', signerToken).update(otp).digest('hex');
}

/**
 * Verifica un OTP ingresado por el usuario contra el hash almacenado.
 * Usa timingSafeEqual para prevenir timing attacks.
 *
 * @param {string} inputOtp    - Código ingresado por el usuario
 * @param {string} storedHash  - Hash almacenado en BD
 * @param {string} signerToken - Token del firmante (el mismo usado al hashear)
 * @returns {boolean}
 */
function verifyOtp(inputOtp, storedHash, signerToken) {
  if (!inputOtp || !storedHash || !signerToken) return false;
  const inputHash = hashOtp(inputOtp, signerToken);

  // Buffer de igual longitud (ambos son hex de SHA-256 = 64 chars = 32 bytes)
  const storedBuf = Buffer.from(storedHash, 'hex');
  const inputBuf  = Buffer.from(inputHash,  'hex');

  if (storedBuf.length !== inputBuf.length) return false;
  return crypto.timingSafeEqual(storedBuf, inputBuf);
}

module.exports = { generateOtp, hashOtp, verifyOtp, OTP_DIGITS };
