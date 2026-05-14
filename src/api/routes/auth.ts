/**
 * Authentication API Routes
 *
 * POST /api/auth/login      — Login with username/password, returns JWT in HTTP-only cookie
 * POST /api/auth/logout     — Clear session cookie
 * GET  /api/auth/me          — Validate session, return current user info
 * GET  /api/auth/users       — List all users (admin only)
 */

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {
  getUserByUsername,
  getUserById,
  updateLastLogin,
  createSession,
  invalidateUserSessions,
  logAudit,
  listUsers,
} from '../../db/postgres';

const JWT_SECRET = process.env.JWT_SECRET || 'levelup-jwt-secret-change-in-production';
const JWT_EXPIRY = '24h';
const COOKIE_NAME = 'levelup_session';
const COOKIE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

/* -------------------------------------------------------------------------- */
/*  In-Memory Rate Limiter (brute-force protection)                           */
/* -------------------------------------------------------------------------- */

interface RateLimitEntry {
  attempts: number;
  firstAttempt: number;
  blockedUntil: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;   // 15 minutes
const BLOCK_DURATION = 15 * 60 * 1000; // 15 minutes block

function checkRateLimit(ip: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry) return { allowed: true };

  // Check if currently blocked
  if (entry.blockedUntil > now) {
    return { allowed: false, retryAfterMs: entry.blockedUntil - now };
  }

  // Reset if window expired
  if (now - entry.firstAttempt > WINDOW_MS) {
    rateLimitMap.delete(ip);
    return { allowed: true };
  }

  return { allowed: entry.attempts < MAX_ATTEMPTS };
}

function recordAttempt(ip: string, success: boolean): void {
  const now = Date.now();

  if (success) {
    rateLimitMap.delete(ip);
    return;
  }

  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    rateLimitMap.set(ip, { attempts: 1, firstAttempt: now, blockedUntil: 0 });
    return;
  }

  entry.attempts++;
  if (entry.attempts >= MAX_ATTEMPTS) {
    entry.blockedUntil = now + BLOCK_DURATION;
    console.warn(`[Auth] IP ${ip} blocked for ${BLOCK_DURATION / 1000}s after ${MAX_ATTEMPTS} failed attempts`);
  }
}

// Cleanup stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.firstAttempt > WINDOW_MS && entry.blockedUntil < now) {
      rateLimitMap.delete(ip);
    }
  }
}, 30 * 60 * 1000);

/* -------------------------------------------------------------------------- */
/*  Helper: extract IP                                                        */
/* -------------------------------------------------------------------------- */

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function createAuthRouter(): Router {
  const router = Router();

  /* ── Login ──────────────────────────────────────────────────── */
  router.post('/login', async (req: Request, res: Response) => {
    const ip = getClientIp(req);

    // Rate limit check
    const rateCheck = checkRateLimit(ip);
    if (!rateCheck.allowed) {
      const retryAfter = Math.ceil((rateCheck.retryAfterMs || BLOCK_DURATION) / 1000);
      console.warn(`[Auth] Rate limited: ${ip}`);
      return res.status(429).json({
        success: false,
        error: 'Too many login attempts. Please try again later.',
        retryAfterSeconds: retryAfter,
      });
    }

    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password are required' });
      }

      // Find user
      const user = await getUserByUsername(username);
      if (!user) {
        recordAttempt(ip, false);
        // Deliberate vague message — don't reveal if username exists
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      // Compare password
      const passwordMatch = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatch) {
        recordAttempt(ip, false);

        await logAudit({
          user_id: user.id,
          username: user.username,
          action: 'login_failed',
          ip_address: ip,
          user_agent: req.headers['user-agent'] || '',
          details: { reason: 'invalid_password' },
        });

        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      // Success — clear rate limit
      recordAttempt(ip, true);

      // Generate JWT
      const tokenPayload = {
        userId: user.id,
        username: user.username,
        role: user.role,
        company: user.company_name,
      };
      const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRY });

      // Create session record
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await createSession({
        user_id: user.id,
        token_hash: tokenHash,
        ip_address: ip,
        user_agent: req.headers['user-agent'] || '',
        expires_at: new Date(Date.now() + COOKIE_MAX_AGE),
      });

      // Update last login
      await updateLastLogin(user.id);

      // Audit log
      await logAudit({
        user_id: user.id,
        username: user.username,
        action: 'login_success',
        ip_address: ip,
        user_agent: req.headers['user-agent'] || '',
      });

      // Set HTTP-only cookie
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE,
        path: '/',
      });

      console.log(`[Auth] Login success: ${user.username} (role: ${user.role})`);

      res.json({
        success: true,
        data: {
          userId: user.id,
          username: user.username,
          role: user.role,
          company: user.company_name,
        },
      });
    } catch (err: any) {
      console.error('[Auth] Login error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  /* ── Logout ─────────────────────────────────────────────────── */
  router.post('/logout', async (req: Request, res: Response) => {
    try {
      const token = req.cookies?.[COOKIE_NAME];
      if (token) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET) as any;
          await invalidateUserSessions(decoded.userId);

          await logAudit({
            user_id: decoded.userId,
            username: decoded.username,
            action: 'logout',
            ip_address: getClientIp(req),
            user_agent: req.headers['user-agent'] || '',
          });
        } catch {
          // Token expired or invalid — just clear cookie
        }
      }

      res.clearCookie(COOKIE_NAME, { path: '/' });
      res.json({ success: true, message: 'Logged out successfully' });
    } catch (err: any) {
      console.error('[Auth] Logout error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  /* ── Session Validation (GET /me) ───────────────────────────── */
  router.get('/me', async (req: Request, res: Response) => {
    try {
      const token = req.cookies?.[COOKIE_NAME];
      if (!token) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
      }

      let decoded: any;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (err: any) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        return res.status(401).json({ success: false, error: 'Session expired' });
      }

      // Verify user still exists and is active
      const user = await getUserById(decoded.userId);
      if (!user || !user.is_active) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        return res.status(401).json({ success: false, error: 'Account deactivated' });
      }

      res.json({
        success: true,
        data: {
          userId: user.id,
          username: user.username,
          role: user.role,
          company: user.company_name,
          lastLogin: user.last_login,
        },
      });
    } catch (err: any) {
      console.error('[Auth] /me error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  /* ── List Users (admin only) ────────────────────────────────── */
  router.get('/users', async (req: Request, res: Response) => {
    try {
      const token = req.cookies?.[COOKIE_NAME];
      if (!token) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
      }

      let decoded: any;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch {
        return res.status(401).json({ success: false, error: 'Session expired' });
      }

      if (decoded.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Admin access required' });
      }

      const users = await listUsers();
      res.json({ success: true, data: users });
    } catch (err: any) {
      console.error('[Auth] List users error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}
