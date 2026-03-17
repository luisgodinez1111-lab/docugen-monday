'use strict';

/**
 * src/utils/error-codes.js
 * Centralised error code registry.
 * Routes use makeError() instead of ad-hoc strings.
 * Monday.com automation block endpoints also map codes to severity 4000/6000.
 */

const ERROR_CODES = {
  // Document generation
  TEMPLATE_NOT_FOUND:    { code: 'TEMPLATE_NOT_FOUND',    status: 404, message: 'La plantilla no existe o fue eliminada.' },
  ITEM_NOT_FOUND:        { code: 'ITEM_NOT_FOUND',         status: 404, message: 'El item no fue encontrado en Monday.com.' },
  DOC_LIMIT_EXCEEDED:    { code: 'DOC_LIMIT_EXCEEDED',     status: 402, message: 'Límite de documentos del plan alcanzado.' },
  SIG_LIMIT_EXCEEDED:    { code: 'SIG_LIMIT_EXCEEDED',     status: 402, message: 'Límite de firmas del plan alcanzado.' },
  TRIAL_EXPIRED:         { code: 'TRIAL_EXPIRED',          status: 402, message: 'El período de prueba ha expirado.' },
  SUBSCRIPTION_INACTIVE: { code: 'SUBSCRIPTION_INACTIVE',  status: 402, message: 'La suscripción está inactiva.' },
  // Auth
  UNAUTHORIZED:          { code: 'UNAUTHORIZED',           status: 401, message: 'No autenticado.' },
  FORBIDDEN:             { code: 'FORBIDDEN',              status: 403, message: 'Sin permiso para este recurso.' },
  // Processing
  LIBREOFFICE_TIMEOUT:   { code: 'LIBREOFFICE_TIMEOUT',    status: 500, message: 'Timeout convirtiendo a PDF. Intenta de nuevo.' },
  LIBREOFFICE_ERROR:     { code: 'LIBREOFFICE_ERROR',      status: 500, message: 'Error al convertir a PDF.' },
  // Signatures
  TOKEN_INVALID:         { code: 'TOKEN_INVALID',          status: 400, message: 'Token de firma inválido o expirado.' },
  ALREADY_SIGNED:        { code: 'ALREADY_SIGNED',         status: 409, message: 'Este documento ya fue firmado.' },
  OTP_INVALID:           { code: 'OTP_INVALID',            status: 400, message: 'Código OTP incorrecto.' },
  OTP_MAX_ATTEMPTS:      { code: 'OTP_MAX_ATTEMPTS',       status: 429, message: 'Demasiados intentos de OTP.' },
  // General
  VALIDATION_ERROR:      { code: 'VALIDATION_ERROR',       status: 400, message: 'Parámetros inválidos.' },
  INTERNAL_ERROR:        { code: 'INTERNAL_ERROR',         status: 500, message: 'Error interno del servidor.' },
};

/**
 * Maps error codes to Monday.com automation severity codes.
 * 4000 = retryable (automation keeps running)
 * 6000 = permanent (automation is disabled)
 */
const MONDAY_SEVERITY_MAP = {
  TEMPLATE_NOT_FOUND:    6000,  // permanent — template won't reappear
  ITEM_NOT_FOUND:        4000,  // retryable — item may be transiently unavailable
  DOC_LIMIT_EXCEEDED:    4000,  // retryable — user may upgrade their plan
  SIG_LIMIT_EXCEEDED:    4000,
  TRIAL_EXPIRED:         6000,  // permanent — requires account action
  SUBSCRIPTION_INACTIVE: 6000,
  LIBREOFFICE_TIMEOUT:   4000,
  LIBREOFFICE_ERROR:     4000,
};

/**
 * Build a structured error response object.
 * @param {keyof typeof ERROR_CODES} codeKey
 * @param {string} [detail] - optional extra context (not shown to end user)
 */
function makeError(codeKey, detail) {
  const def = ERROR_CODES[codeKey] || ERROR_CODES.INTERNAL_ERROR;
  return {
    error:   def.code,
    message: def.message,
    ...(detail ? { detail } : {}),
  };
}

/**
 * Build a Monday.com automation block error response.
 * Uses severity 6000 (permanent) or 4000 (retryable) based on code.
 * @param {keyof typeof ERROR_CODES} codeKey
 * @param {string} [detail]
 */
function makeMondayError(codeKey, detail) {
  const def = ERROR_CODES[codeKey] || ERROR_CODES.INTERNAL_ERROR;
  const severity = MONDAY_SEVERITY_MAP[codeKey] || 4000;
  return {
    severityCode:    severity,
    notificationErrorTitle: def.message,
    notificationErrorDescription: detail || def.message,
    runtimeErrorDescription: detail || def.message,
  };
}

module.exports = { ERROR_CODES, makeError, makeMondayError, MONDAY_SEVERITY_MAP };
