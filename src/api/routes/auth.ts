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
/*
 * IMPORTANT — why the bucket is keyed on (ip + username), not ip alone:
 *
 * Many teams sit behind a single shared egress IP (corporate NAT, office Wi-Fi,
 * VPN, or a cloud reverse-proxy that collapses client IPs). If the limiter keys
 * solely on IP, a handful of mistyped passwords by ANY teammate exhausts the
 * shared bucket and locks out the ENTIRE team — including users supplying the
 * correct password. That is a self-inflicted, team-wide outage.
 *
 * Fix: scope the per-account limiter to (ip + username). One user's failures can
 * never block a different account. A separate, far more generous per-IP safety
 * net still deters credential-stuffing (many distinct accounts from one IP), and
 * known office/VPN IPs can be allow-listed via LOGIN_RATE_LIMIT_IP_ALLOWLIST.
 */

interface RateLimitEntry {
  attempts: number;
  firstAttempt: number;
  blockedUntil: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Per-account limiter (ip + username): the primary brute-force guard.
const MAX_ATTEMPTS = envInt('LOGIN_RATE_LIMIT_MAX', 5);
const WINDOW_MS = envInt('LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);   // 15 minutes
const BLOCK_DURATION = envInt('LOGIN_RATE_LIMIT_BLOCK_MS', 15 * 60 * 1000); // 15 minutes block

// Per-IP safety net: deliberately generous so shared-IP teams are not punished
// for individual mistakes, while still catching distributed credential-stuffing
// (one IP hammering many different accounts).
const IP_MAX_ATTEMPTS = envInt('LOGIN_RATE_LIMIT_IP_MAX', 50);

// IPs that should never be rate limited (e.g. trusted office / VPN egress).
const IP_ALLOWLIST = new Set(
  (process.env.LOGIN_RATE_LIMIT_IP_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// account bucket: key = `${ip}|${username}`   ·   ip bucket: key = ip
const rateLimitMap = new Map<string, RateLimitEntry>();
const ipLimitMap = new Map<string, RateLimitEntry>();

function evaluateEntry(
  map: Map<string, RateLimitEntry>,
  key: string,
  max: number,
  now: number,
): { allowed: boolean; retryAfterMs?: number } {
  const entry = map.get(key);
  if (!entry) return { allowed: true };

  if (entry.blockedUntil > now) {
    return { allowed: false, retryAfterMs: entry.blockedUntil - now };
  }
  if (now - entry.firstAttempt > WINDOW_MS) {
    map.delete(key);
    return { allowed: true };
  }
  return { allowed: entry.attempts < max };
}

function recordEntry(
  map: Map<string, RateLimitEntry>,
  key: string,
  max: number,
  now: number,
): void {
  const entry = map.get(key);
  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    map.set(key, { attempts: 1, firstAttempt: now, blockedUntil: 0 });
    return;
  }
  entry.attempts++;
  if (entry.attempts >= max) {
    entry.blockedUntil = now + BLOCK_DURATION;
  }
}

function acctKey(ip: string, username: string): string {
  return `${ip}|${(username || '').toLowerCase()}`;
}

function checkRateLimit(ip: string, username: string): { allowed: boolean; retryAfterMs?: number } {
  if (IP_ALLOWLIST.has(ip)) return { allowed: true };
  const now = Date.now();

  // Account-scoped check first (this is what protects a normal user).
  const acct = evaluateEntry(rateLimitMap, acctKey(ip, username), MAX_ATTEMPTS, now);
  if (!acct.allowed) return acct;

  // Generous per-IP safety net for credential-stuffing across many accounts.
  return evaluateEntry(ipLimitMap, ip, IP_MAX_ATTEMPTS, now);
}

function recordAttempt(ip: string, username: string, success: boolean): void {
  if (IP_ALLOWLIST.has(ip)) return;
  const now = Date.now();
  const key = acctKey(ip, username);

  if (success) {
    // Clear this account's bucket only; leave the IP safety-net counter intact
    // so a successful login can't be used to reset a stuffing attack.
    rateLimitMap.delete(key);
    return;
  }

  recordEntry(rateLimitMap, key, MAX_ATTEMPTS, now);
  recordEntry(ipLimitMap, ip, IP_MAX_ATTEMPTS, now);

  const acct = rateLimitMap.get(key);
  if (acct && acct.attempts >= MAX_ATTEMPTS) {
    console.warn(`[Auth] Account bucket ${key} blocked for ${BLOCK_DURATION / 1000}s after ${MAX_ATTEMPTS} failed attempts`);
  }
}

// Cleanup stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const map of [rateLimitMap, ipLimitMap]) {
    for (const [key, entry] of map) {
      if (now - entry.firstAttempt > WINDOW_MS && entry.blockedUntil < now) {
        map.delete(key);
      }
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
    const { username, password } = req.body;

    // Rate limit check — scoped to (ip + username) so one teammate's failed
    // attempts can never lock out a different account on a shared egress IP.
    const rateCheck = checkRateLimit(ip, username);
    if (!rateCheck.allowed) {
      const retryAfter = Math.ceil((rateCheck.retryAfterMs || BLOCK_DURATION) / 1000);
      console.warn(`[Auth] Rate limited: ip=${ip} user=${username}`);
      return res.status(429).json({
        success: false,
        error: 'Too many login attempts. Please try again later.',
        retryAfterSeconds: retryAfter,
      });
    }

    try {
      if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password are required' });
      }

      // Find user
      const user = await getUserByUsername(username);
      if (!user) {
        recordAttempt(ip, username, false);
        // Deliberate vague message — don't reveal if username exists
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      // Compare password
      const passwordMatch = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatch) {
        recordAttempt(ip, username, false);

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
      recordAttempt(ip, username, true);

      // Generate JWT
      const tokenPayload = {
        userId: user.id,
        username: user.username,
        role: user.role,
        company: user.company_name,
        companyId: user.company_id,
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
