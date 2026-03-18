'use strict';
const crypto = require('crypto');

// ── Key registry ─────────────────────────────────────────────────────────────
// Support two env-var formats:
//  1. Legacy: TOKEN_ENCRYPTION_KEY (single key, treated as version "1")
//  2. Multi:  ENCRYPTION_KEYS='{"1":"...","2":"..."}' + ENCRYPTION_KEY_VERSION="2"

function loadKeyRegistry() {
  if (process.env.ENCRYPTION_KEYS) {
    try {
      const parsed = JSON.parse(process.env.ENCRYPTION_KEYS);
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('ENCRYPTION_KEYS must be a JSON object {"version":"hex64key",...}');
      }
      return parsed; // { "1": "hex...", "2": "hex..." }
    } catch (e) {
      throw new Error(`Invalid ENCRYPTION_KEYS: ${e.message}`);
    }
  }
  // Legacy single-key mode
  const key = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is required');
  return { '1': key };
}

function getCurrentVersion(registry) {
  if (process.env.ENCRYPTION_KEY_VERSION) return process.env.ENCRYPTION_KEY_VERSION;
  // Pick the numerically highest version
  const versions = Object.keys(registry).map(Number).filter(n => !isNaN(n));
  return String(Math.max(...versions));
}

function getKeyBuffer(registry, version) {
  const hexKey = registry[version];
  if (!hexKey) throw new Error(`No encryption key found for version "${version}"`);
  return Buffer.from(hexKey, 'hex');
}

// Lazy-initialize to allow env vars to be set after module load (test support)
let _registry = null;
let _currentVersion = null;

function getRegistry() {
  if (!_registry) {
    _registry = loadKeyRegistry();
    _currentVersion = getCurrentVersion(_registry);
  }
  return { registry: _registry, currentVersion: _currentVersion };
}

// For tests — reset the key registry (called after setting process.env)
function resetKeyRegistry() {
  _registry = null;
  _currentVersion = null;
}

// ── ENC_KEY (backward compat export) ─────────────────────────────────────────
// Lazy getter — throws on first access if key is not configured, so callers
// fail loudly instead of receiving null and silently skipping decryption.
let _encKey = undefined;
function getEncKey() {
  if (_encKey === undefined) {
    const reg = loadKeyRegistry(); // throws if misconfigured
    _encKey = Buffer.from(Object.values(reg)[0], 'hex');
  }
  return _encKey;
}
// Proxy so existing `const { ENC_KEY } = require(...)` destructuring still works
const ENC_KEY = new Proxy({}, {
  get(_t, prop) { return getEncKey()[prop]; },
  apply(_t, _ctx, args) { return getEncKey()(...args); },
});

// ── Core crypto ──────────────────────────────────────────────────────────────
function encryptToken(plaintext) {
  if (!plaintext) return plaintext;
  const { registry, currentVersion } = getRegistry();
  const keyBuf = getKeyBuffer(registry, currentVersion);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // Format: v{version}:{iv_hex}:{encrypted_hex}
  return `v${currentVersion}:${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptToken(ciphertext) {
  if (!ciphertext) return ciphertext;
  if (!ciphertext.includes(':')) return ciphertext; // token pre-encryption (migration path)
  const { registry } = getRegistry();
  let version, iv, encrypted;

  if (ciphertext.startsWith('v')) {
    // New format: v{version}:{iv_hex}:{encrypted_hex}
    const parts = ciphertext.split(':');
    if (parts.length !== 3) throw new Error('Invalid ciphertext format');
    version = parts[0].slice(1); // strip leading 'v'
    iv = Buffer.from(parts[1], 'hex');
    encrypted = Buffer.from(parts[2], 'hex');
  } else {
    // Legacy format: {iv_hex}:{encrypted_hex} — treat as version "1"
    const parts = ciphertext.split(':');
    if (parts.length !== 2) throw new Error('Invalid ciphertext format');
    version = '1';
    iv = Buffer.from(parts[0], 'hex');
    encrypted = Buffer.from(parts[1], 'hex');
  }

  const keyBuf = getKeyBuffer(registry, version);
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// Generar hash SHA-256 del documento
function generateDocHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { ENC_KEY, encryptToken, decryptToken, generateDocHash, resetKeyRegistry };
