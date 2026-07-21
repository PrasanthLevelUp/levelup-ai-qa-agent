/**
 * Company-Scoping Middleware
 * Extracts company_id from:
 *  1. x-company-id header (set by dashboard proxy)
 *  2. JWT cookie (company claim → look up company_id)
 *  3. Falls back to default company (id=1) if none found
 *
 * Attaches req.companyId (number) for downstream handlers.
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getPool, isCompanyActive } from '../../db/postgres';
import { logger } from '../../utils/logger';
import { JWT_SECRET, COOKIE_NAME } from '../../config/auth';

const MOD = 'company-middleware';

// Cache company name → id lookups to avoid repeated DB hits
const companyCache = new Map<string, number>();
let defaultCompanyId: number | null = null;

/**
 * Kill-switch allow-list. Suspended companies are still permitted to reach
 * these route groups so they can (a) authenticate, (b) view their own billing
 * / subscription state, and (c) be managed by the founder-admin. Every other
 * product API is blocked while suspended.
 */
const SUSPEND_ALLOWED_PREFIXES = ['/api/auth', '/api/billing', '/api/companies'];

function isSuspendAllowedPath(req: Request): boolean {
  const base = req.baseUrl || req.originalUrl || '';
  return SUSPEND_ALLOWED_PREFIXES.some(p => base.startsWith(p));
}

async function resolveDefaultCompanyId(): Promise<number> {
  if (defaultCompanyId !== null) return defaultCompanyId;
  const pool = getPool();
  const { rows } = await pool.query(`SELECT id FROM companies WHERE slug = 'default' LIMIT 1`);
  const resolved: number = rows[0]?.id ?? 1;
  defaultCompanyId = resolved;
  return resolved;
}

async function resolveCompanyIdByName(companyName: string): Promise<number | null> {
  if (companyCache.has(companyName)) return companyCache.get(companyName)!;
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.id FROM companies c
     JOIN users u ON u.company_id = c.id
     WHERE u.company_name = $1 LIMIT 1`,
    [companyName],
  );
  if (rows.length > 0) {
    companyCache.set(companyName, rows[0].id);
    return rows[0].id;
  }
  // Try direct company name match
  const { rows: rows2 } = await pool.query(
    `SELECT id FROM companies WHERE name = $1 LIMIT 1`,
    [companyName],
  );
  if (rows2.length > 0) {
    companyCache.set(companyName, rows2[0].id);
    return rows2[0].id;
  }
  return null;
}

/** Resolve the company id for this request from header → JWT cookie → default. */
async function resolveCompanyId(req: Request): Promise<number> {
  // 1. Explicit header from dashboard proxy
  const headerCompanyId = req.headers['x-company-id'];
  if (headerCompanyId) {
    const cid = parseInt(String(headerCompanyId), 10);
    if (!isNaN(cid) && cid > 0) return cid;
  }

  // 2. Extract from JWT cookie
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    }),
  );
  const token = cookies[COOKIE_NAME];
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      if (decoded.companyId) return decoded.companyId;
      if (decoded.company) {
        const resolved = await resolveCompanyIdByName(decoded.company);
        if (resolved) return resolved;
      }
    } catch {
      // JWT invalid — fall through to default
    }
  }

  // 3. Default company
  return resolveDefaultCompanyId();
}

export async function companyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const companyId = await resolveCompanyId(req);
    (req as any).companyId = companyId;

    // Kill-switch: suspended companies are blocked from all product APIs.
    // Auth / billing / founder-admin routes stay reachable so the customer can
    // still see their status and the founder can re-activate them.
    if (!isSuspendAllowedPath(req)) {
      const active = await isCompanyActive(companyId);
      if (!active) {
        res.status(403).json({
          success: false,
          error: 'Subscription suspended',
          code: 'SUBSCRIPTION_SUSPENDED',
          message: 'This account has been suspended. Please contact support to reactivate.',
        });
        return;
      }
    }

    next();
  } catch (err) {
    logger.error(MOD, 'Company resolution failed, using default', { error: err });
    (req as any).companyId = 1;
    next();
  }
}

/** Clear cached lookups (useful after company creation) */
export function clearCompanyCache(): void {
  companyCache.clear();
  defaultCompanyId = null;
}
