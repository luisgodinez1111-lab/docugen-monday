'use strict';

// HTML escape — prevent XSS when interpolating user data into HTML email/portal strings
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function sanitizeStr(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'number') return val;
  if (typeof val !== 'string') return val;
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/[/]/g, '&#x2F;');
}

function sanitizeInput(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') clean[key] = sanitizeStr(val);
    else if (typeof val === 'object' && val !== null) clean[key] = sanitizeInput(val);
    else clean[key] = val;
  }
  return clean;
}

module.exports = { escapeHtml, sanitizeStr, sanitizeInput };
