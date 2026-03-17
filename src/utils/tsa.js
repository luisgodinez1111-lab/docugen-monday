/**
 * src/utils/tsa.js
 * Cliente RFC 3161 para sellado de tiempo con TSA externa acreditada.
 *
 * ⚖️  REQUERIMIENTO LEGAL:
 *     NOM-151-SCFI-2016 y Código de Comercio (México) exigen que el
 *     sellado de tiempo provenga de un Prestador de Servicios de
 *     Certificación (PSC) acreditado. Una TSA interna NO tiene validez.
 *
 * TSA usada por defecto: Sectigo (RFC 3161 compliant, gratuita)
 *   URL: http://timestamp.sectigo.com
 *
 * Alternativas acreditadas:
 *   - DigiCert:  http://timestamp.digicert.com
 *   - GlobalSign: http://timestamp.globalsign.com/tsa/r6advanced1
 *   - Entrust:   http://timestamp.entrust.net/TSS/RFC3161sha2TS
 *
 * Docs RFC 3161: https://www.rfc-editor.org/rfc/rfc3161
 * Docs NOM-151: https://www.dof.gob.mx/nota_detalle.php?codigo=5427399
 */
const crypto = require('crypto');
const axios  = require('axios');

// TSA pública por defecto (Sectigo, RFC 3161, sin costo para uso básico)
const DEFAULT_TSA_URL = process.env.TSA_URL || 'http://timestamp.sectigo.com';

/**
 * Construye un TimeStampRequest (TSQ) RFC 3161 básico en formato DER.
 * Para producción con requisitos estrictos se recomienda usar la librería
 * `pkijs` o `node-forge` para una implementación ASN.1 completa.
 *
 * Esta implementación genera el minimal TSQ compatible con la mayoría
 * de TSAs públicas (RFC 3161 §2.4.1).
 *
 * @param {Buffer} docHash - Hash SHA-256 del documento a sellar
 * @returns {Buffer} - TSQ en DER
 */
function buildTsq(docHash) {
  // OID SHA-256: 2.16.840.1.101.3.4.2.1
  const sha256Oid = Buffer.from([
    0x30, 0x0d, // SEQUENCE
    0x06, 0x09, // OID tag + length
    0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, // SHA-256 OID
    0x05, 0x00  // NULL params
  ]);

  const hashValue = Buffer.concat([
    Buffer.from([0x04, docHash.length]), // OCTET STRING tag + length
    docHash
  ]);

  const messageImprint = Buffer.concat([
    Buffer.from([0x30]), // SEQUENCE
    encodeLength(sha256Oid.length + hashValue.length),
    sha256Oid,
    hashValue
  ]);

  // nonce: 8 bytes aleatorios para prevenir replay attacks
  const nonce = crypto.randomBytes(8);
  const nonceInt = Buffer.concat([
    Buffer.from([0x02, 0x08]), // INTEGER tag + length
    nonce
  ]);

  // certReq: TRUE (pedir certificado del TSA en la respuesta)
  const certReq = Buffer.from([0x01, 0x01, 0xff]);

  const tsqContent = Buffer.concat([
    Buffer.from([0x02, 0x01, 0x01]), // version: INTEGER = 1
    messageImprint,
    nonceInt,
    certReq
  ]);

  const tsq = Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(tsqContent.length),
    tsqContent
  ]);

  return tsq;
}

/**
 * Codifica la longitud en DER (maneja longitudes > 127).
 */
function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

/**
 * Solicita un sello de tiempo RFC 3161 a una TSA externa acreditada.
 *
 * @param {Buffer} documentBuffer - Buffer del documento a sellar
 * @param {string} [tsaUrl]       - URL de la TSA (default: Sectigo)
 * @returns {Promise<object>}     - Objeto con timestamp, tsaUrl, responseToken (base64), docHash
 */
async function requestTsaTimestamp(documentBuffer, tsaUrl = DEFAULT_TSA_URL) {
  // 1. Generar hash SHA-256 del documento
  const docHash = crypto.createHash('sha256').update(documentBuffer).digest();
  const docHashHex = docHash.toString('hex');

  // 2. Construir TimeStampRequest
  const tsq = buildTsq(docHash);

  // 3. Enviar a la TSA
  let tsrBuffer;
  try {
    const response = await axios.post(tsaUrl, tsq, {
      headers: { 'Content-Type': 'application/timestamp-query' },
      responseType: 'arraybuffer',
      timeout: 15000
    });
    tsrBuffer = Buffer.from(response.data);
  } catch (err) {
    throw new Error(`TSA request failed (${tsaUrl}): ${err.message}`);
  }

  // 4. Verificación básica: el primer byte del TSR debe ser 0x30 (SEQUENCE)
  if (!tsrBuffer || tsrBuffer[0] !== 0x30) {
    throw new Error('Respuesta TSA inválida — no es un TimeStampResponse DER válido');
  }

  // 5. Construir el objeto de sello de tiempo para guardar en BD
  const tsaRecord = {
    timestamp:      new Date().toISOString(),
    tsa_url:        tsaUrl,
    tsa_provider:   getTsaProvider(tsaUrl),
    doc_hash:       docHashHex,
    hash_algorithm: 'SHA-256',
    tsr_base64:     tsrBuffer.toString('base64'), // Respuesta completa para verificación futura
    rfc_standard:   'RFC 3161',
    // Para NOM-151: el PSC está en el certificado del TSA dentro del TSR
    nom151_compliant: true,
  };

  return tsaRecord;
}

/**
 * Versión de fallback: si la TSA no está disponible, genera un sello
 * local marcado explícitamente como NO acreditado.
 * Solo usar en desarrollo/testing, NUNCA en producción para firma legal.
 */
function generateLocalFallbackTimestamp(documentBuffer) {
  const docHash = crypto.createHash('sha256').update(documentBuffer).digest('hex');
  console.warn('[TSA] ADVERTENCIA: usando timestamp local — NO tiene validez legal bajo NOM-151');
  return {
    timestamp:        new Date().toISOString(),
    tsa_url:          'local',
    tsa_provider:     'DocuGen-Local-NON-ACCREDITED',
    doc_hash:         docHash,
    hash_algorithm:   'SHA-256',
    tsr_base64:       null,
    rfc_standard:     'NONE',
    nom151_compliant: false, // ← Explícito: NO cumple NOM-151
    warning:          'Este sello NO tiene validez legal. Configurar TSA_URL en variables de entorno.',
  };
}

function getTsaProvider(url) {
  if (url.includes('sectigo'))   return 'Sectigo (RFC 3161)';
  if (url.includes('digicert'))  return 'DigiCert (RFC 3161)';
  if (url.includes('globalsign')) return 'GlobalSign (RFC 3161)';
  if (url.includes('entrust'))   return 'Entrust (RFC 3161)';
  return `TSA Externa: ${url}`;
}

/**
 * Función principal exportada: intenta TSA externa, fallback local en dev.
 */
async function getTimestamp(documentBuffer) {
  // En producción, TSA_URL DEBE estar configurado
  if (process.env.NODE_ENV === 'production' && !process.env.TSA_URL) {
    console.warn('[TSA] PRODUCCIÓN sin TSA_URL configurado — usando Sectigo por defecto');
  }

  try {
    return await requestTsaTimestamp(documentBuffer, DEFAULT_TSA_URL);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[TSA] TSA externa no disponible, usando fallback local:', err.message);
      return generateLocalFallbackTimestamp(documentBuffer);
    }
    // En producción: propagar el error (no silenciar fallo de TSA)
    throw err;
  }
}

module.exports = { getTimestamp, requestTsaTimestamp, generateLocalFallbackTimestamp };
