/**
 * Credential Encryption Utilities
 *
 * Uses AES-256-GCM for authenticated encryption of sensitive data (tokens, API keys, etc.).
 * Encryption key MUST be provided via CREDENTIAL_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 *
 * Security properties:
 *  - AES-256-GCM provides both confidentiality and integrity
 *  - Random IV per encryption (no IV reuse)
 *  - GCM auth tag prevents tampering
 *  - Never logs decrypted values
 */

import crypto from 'crypto';
import { logger } from './logger';

const MOD = 'crypto';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const KEY_ENV = 'CREDENTIAL_ENCRYPTION_KEY';

let _keyBuffer: Buffer | null = null;

function getKey(): Buffer {
  if (_keyBuffer) return _keyBuffer;

  const hexKey = process.env[KEY_ENV];
  if (!hexKey) {
    // In development/test, generate a deterministic key (NOT for production)
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `FATAL: ${KEY_ENV} environment variable is required in production. ` +
        `Generate with: openssl rand -hex 32`
      );
    }
    logger.warn(MOD, `${KEY_ENV} not set — using development fallback key. DO NOT USE IN PRODUCTION.`);
    _keyBuffer = crypto.createHash('sha256').update('levelup-dev-key-not-for-production').digest();
    return _keyBuffer;
  }

  if (hexKey.length !== 64) {
    throw new Error(`${KEY_ENV} must be exactly 64 hex characters (32 bytes). Got ${hexKey.length} chars.`);
  }

  _keyBuffer = Buffer.from(hexKey, 'hex');
  return _keyBuffer;
}

export interface EncryptedPayload {
  /** Hex-encoded ciphertext */
  encrypted: string;
  /** Hex-encoded initialization vector */
  iv: string;
  /** Hex-encoded GCM authentication tag */
  authTag: string;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns the encrypted value, IV, and auth tag (all hex-encoded).
 *
 * Usage:
 * ```ts
 * const result = encryptCredential(JSON.stringify({ token: 'ghp_xxx' }));
 * // Store result.encrypted, result.iv, result.authTag in DB
 * ```
 */
export function encryptCredential(plaintext: string): EncryptedPayload {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

/**
 * Decrypt a previously encrypted value.
 * Throws if the data has been tampered with (GCM auth check).
 *
 * Usage:
 * ```ts
 * const plaintext = decryptCredential(row.encrypted_value, row.iv, row.auth_tag);
 * const config = JSON.parse(plaintext);
 * ```
 */
export function decryptCredential(encrypted: string, iv: string, authTag: string): string {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Check if the encryption key is configured.
 * Returns true if a proper key is available (including dev fallback in non-prod).
 */
export function isEncryptionConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

/** Clear the cached key (useful for testing) */
export function _resetKeyCache(): void {
  _keyBuffer = null;
}
