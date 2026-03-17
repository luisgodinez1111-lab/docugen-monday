import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// We need to reset module state between tests. Import the module freshly.
describe('crypto versioned encryption', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset module registry between tests
    delete process.env.ENCRYPTION_KEYS;
    delete process.env.ENCRYPTION_KEY_VERSION;
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  });

  afterEach(() => {
    // Restore
    Object.assign(process.env, originalEnv);
    // Reset the registry singleton
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resetKeyRegistry } = require('../utils/crypto');
    resetKeyRegistry();
  });

  it('encrypts and decrypts in legacy format (single key)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resetKeyRegistry, encryptToken, decryptToken } = require('../utils/crypto');
    resetKeyRegistry();
    const plaintext = 'test-oauth-token-value';
    const ciphertext = encryptToken(plaintext);
    expect(ciphertext).toMatch(/^v1:/);
    expect(decryptToken(ciphertext)).toBe(plaintext);
  });

  it('decrypts legacy format (no version prefix)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resetKeyRegistry, decryptToken } = require('../utils/crypto');
    resetKeyRegistry();
    // Simulate old ciphertext format (iv:encrypted without v prefix)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto');
    const key = Buffer.from('a'.repeat(64), 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const enc = Buffer.concat([cipher.update('legacy-token', 'utf8'), cipher.final()]);
    const legacyCiphertext = `${iv.toString('hex')}:${enc.toString('hex')}`;

    expect(decryptToken(legacyCiphertext)).toBe('legacy-token');
  });

  it('encrypts with v2 key and decrypts correctly', () => {
    process.env.ENCRYPTION_KEYS = JSON.stringify({
      '1': 'a'.repeat(64),
      '2': 'b'.repeat(64),
    });
    process.env.ENCRYPTION_KEY_VERSION = '2';

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resetKeyRegistry, encryptToken, decryptToken } = require('../utils/crypto');
    resetKeyRegistry();

    const plaintext = 'new-oauth-token';
    const ciphertext = encryptToken(plaintext);
    expect(ciphertext).toMatch(/^v2:/);
    expect(decryptToken(ciphertext)).toBe(plaintext);
  });

  it('decrypts old v1 token after key rotation to v2', () => {
    // First encrypt with v1
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resetKeyRegistry: r1, encryptToken: enc1 } = require('../utils/crypto');
    r1();
    const oldCiphertext = enc1('old-token');
    expect(oldCiphertext).toMatch(/^v1:/);

    // Now "rotate" to v2
    process.env.ENCRYPTION_KEYS = JSON.stringify({
      '1': 'a'.repeat(64),
      '2': 'b'.repeat(64),
    });
    process.env.ENCRYPTION_KEY_VERSION = '2';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resetKeyRegistry: r2, decryptToken: dec2 } = require('../utils/crypto');
    r2();

    // Old v1 token should still decrypt
    expect(dec2(oldCiphertext)).toBe('old-token');
  });
});
