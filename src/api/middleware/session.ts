/**
 * Session Validation Middleware
 *
 * Extracts userId from the JWT session cookie and validates the session
 * against the database. Attaches req.userId and req.username if valid.
 *
 * This middleware is OPTIONAL (non-blocking): if no session is present,
 * the request proceeds without userId. This allows API key-only auth to
 * continue working while session-based auth gets enhanced security.
 *
 * Must run AFTER companyMiddleware (which already parses the JWT).
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getPool } from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'session-middleware';
const JWT_SECRET = process.env.JWT_SECRET || 'levelup-jwt-secret-change-in-production';
const COOKIE_NAME = 'levelup_session';

export async function sessionMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Extract JWT from cookie
    const cookieHeader = req.headers.cookie || '';
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map(c => {
        const [k, ...v] = c.trim().split('=');
        return [k, v.join('=')];
      }),
    );
    const token = cookies[COOKIE_NAME];

    if (!token) {
      // No session — proceed without userId (API key only)
      next();
      return;
    }

    // Verify JWT
    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      // Invalid/expired JWT — proceed without userId
      next();
      return;
    }

    if (!decoded.userId) {
      next();
      return;
    }

    // Validate session exists in DB (prevents revoked session reuse)
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, user_id FROM sessions
       WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW()
       LIMIT 1`,
      [tokenHash, decoded.userId],
    );

    if (rows.length === 0) {
      // Session revoked or expired in DB — proceed without userId
      logger.debug(MOD, 'Session not found in DB', { userId: decoded.userId });
      next();
      return;
    }

    // Valid session — attach user info to request
    (req as any).userId = decoded.userId;
    (req as any).username = decoded.username;
    (req as any).userRole = decoded.role;

    next();
  } catch (err) {
    // Never block on session validation errors
    logger.error(MOD, 'Session validation failed', { error: (err as Error).message });
    next();
  }
}
