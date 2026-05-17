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
import { getPool } from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'company-middleware';
const JWT_SECRET = process.env.JWT_SECRET || 'levelup-jwt-secret-change-in-production';
const COOKIE_NAME = 'levelup_session';

// Cache company name → id lookups to avoid repeated DB hits
const companyCache = new Map<string, number>();
let defaultCompanyId: number | null = null;

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

export async function companyMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // 1. Explicit header from dashboard proxy
    const headerCompanyId = req.headers['x-company-id'];
    if (headerCompanyId) {
      const cid = parseInt(String(headerCompanyId), 10);
      if (!isNaN(cid) && cid > 0) {
        (req as any).companyId = cid;
        next();
        return;
      }
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
        if (decoded.companyId) {
          (req as any).companyId = decoded.companyId;
          next();
          return;
        }
        if (decoded.company) {
          const resolved = await resolveCompanyIdByName(decoded.company);
          if (resolved) {
            (req as any).companyId = resolved;
            next();
            return;
          }
        }
      } catch {
        // JWT invalid — fall through to default
      }
    }

    // 3. Default company
    (req as any).companyId = await resolveDefaultCompanyId();
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
