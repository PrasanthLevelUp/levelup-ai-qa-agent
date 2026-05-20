/**
 * Enterprise API Key Service
 * Generates, hashes, verifies, and revokes per-company API keys.
 * Keys are stored as SHA-256 hashes — raw key shown once at creation.
 * Format: lvlp_live_<32-char-hex> or lvlp_test_<32-char-hex>
 */

import * as crypto from 'crypto';
import { getPool } from '../../db/postgres';
const pool = getPool();
import { logger } from '../../utils/logger';

const MOD = 'api-key-service';

export type ApiKeyScope = 'ingest:write' | 'jobs:read' | 'jobs:trigger' | 'healing:read' | 'scripts:generate' | 'admin';

export interface ApiKeyRecord {
  id: number;
  company_id: number;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: ApiKeyScope[];
  rate_limit: number;
  is_active: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  company_name?: string;
}

/**
 * Hash an API key using SHA-256.
 */
function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Generate a new API key for a company.
 * Returns the raw key (shown once) + the stored record.
 */
export async function generateApiKey(
  companyId: number,
  name: string,
  scopes: ApiKeyScope[] = ['ingest:write'],
  rateLimit: number = 1000,
  expiresInDays?: number,
): Promise<{ rawKey: string; record: ApiKeyRecord }> {
  const randomPart = crypto.randomBytes(24).toString('hex'); // 48 hex chars
  const rawKey = `lvlp_live_${randomPart}`;
  const prefix = rawKey.slice(0, 14); // "lvlp_live_XXXX" — visible prefix for identification
  const keyHash = hashKey(rawKey);

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
    : null;

  const result = await pool.query(
    `INSERT INTO api_keys (company_id, name, prefix, key_hash, scopes, rate_limit, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [companyId, name, prefix, keyHash, JSON.stringify(scopes), rateLimit, expiresAt],
  );

  const record = rowToApiKey(result.rows[0]);
  logger.info(MOD, 'API key generated', { companyId, name, prefix, scopes });

  return { rawKey, record };
}

/**
 * Verify an API key and return the associated company context.
 * Returns null if the key is invalid, inactive, or expired.
 */
export async function verifyApiKey(rawKey: string): Promise<ApiKeyRecord | null> {
  if (!rawKey || !rawKey.startsWith('lvlp_')) return null;

  const keyHash = hashKey(rawKey);

  const result = await pool.query(
    `SELECT ak.*, c.name as company_name
     FROM api_keys ak
     JOIN companies c ON c.id = ak.company_id
     WHERE ak.key_hash = $1
       AND ak.is_active = true
       AND c.is_active = true
       AND (ak.expires_at IS NULL OR ak.expires_at > NOW())`,
    [keyHash],
  );

  if (result.rows.length === 0) return null;

  // Update last_used_at (fire-and-forget)
  pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [result.rows[0].id]).catch(() => {});

  return rowToApiKey(result.rows[0]);
}

/**
 * Check if an API key has a specific scope.
 */
export function hasScope(apiKey: ApiKeyRecord, scope: ApiKeyScope): boolean {
  return apiKey.scopes.includes('admin') || apiKey.scopes.includes(scope);
}

/**
 * List all API keys for a company (without hashes).
 */
export async function listApiKeys(companyId: number): Promise<Omit<ApiKeyRecord, 'key_hash'>[]> {
  const result = await pool.query(
    `SELECT id, company_id, name, prefix, scopes, rate_limit, is_active, last_used_at, expires_at, created_at
     FROM api_keys
     WHERE company_id = $1
     ORDER BY created_at DESC`,
    [companyId],
  );
  return result.rows.map(r => ({
    id: r.id,
    company_id: r.company_id,
    name: r.name,
    prefix: r.prefix,
    key_hash: '[REDACTED]',
    scopes: parseScopes(r.scopes),
    rate_limit: r.rate_limit,
    is_active: r.is_active,
    last_used_at: r.last_used_at,
    expires_at: r.expires_at,
    created_at: r.created_at,
  }));
}

/**
 * Revoke (deactivate) an API key.
 */
export async function revokeApiKey(keyId: number, companyId: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE api_keys SET is_active = false WHERE id = $1 AND company_id = $2`,
    [keyId, companyId],
  );
  if ((result.rowCount ?? 0) > 0) {
    logger.info(MOD, 'API key revoked', { keyId, companyId });
    return true;
  }
  return false;
}

function rowToApiKey(row: any): ApiKeyRecord {
  return {
    id: row.id,
    company_id: row.company_id,
    name: row.name,
    prefix: row.prefix,
    key_hash: row.key_hash,
    scopes: parseScopes(row.scopes),
    rate_limit: row.rate_limit,
    is_active: row.is_active,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    company_name: row.company_name,
  };
}

function parseScopes(raw: any): ApiKeyScope[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}
