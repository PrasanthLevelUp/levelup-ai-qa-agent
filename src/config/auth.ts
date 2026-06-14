/**
 * Centralized authentication / session configuration.
 *
 * SINGLE SOURCE OF TRUTH for the JWT signing+verification secret and the
 * session cookie. Every module that signs or verifies the `levelup_session`
 * token MUST import `JWT_SECRET` from here and never re-read
 * `process.env.JWT_SECRET` locally, so the whole backend provably uses one
 * identical secret.
 *
 * ─── Why this module exists (production incident) ──────────────────────────
 * The session cookie is signed by THIS backend and is also verified by the
 * dashboard's Next.js `middleware.ts`. If the secret differs between any two
 * verifiers, a freshly issued token fails verification and the user can log in
 * but every subsequent authenticated request (e.g. `GET /api/auth/me`) returns
 * 401 — surfacing in the UI as "Signed in, but your session could not be
 * established."
 *
 * The previous code scattered
 *     const JWT_SECRET = process.env.JWT_SECRET || 'levelup-jwt-secret-change-in-production';
 * across four files (auth route + session/company middleware + dashboard
 * middleware). That weak silent fallback is the real hazard: if `JWT_SECRET`
 * is unset on ONE service, it quietly boots with the default while the other
 * service uses its configured secret → the two secrets drift apart and every
 * token mismatches, with no error at startup to reveal the misconfiguration.
 *
 * This module removes the silent fallback in production: if `JWT_SECRET` is
 * missing or too short, the server refuses to start (fail fast) instead of
 * booting with an insecure, mismatch-prone default. In development a known
 * fallback is still allowed (with a loud warning) so local setup stays easy.
 */

/** Dev-only fallback. NEVER used when NODE_ENV === 'production'. */
const DEV_FALLBACK_SECRET = 'levelup-jwt-secret-change-in-production';

/** Minimum acceptable secret length (32 chars ≈ the entropy of `openssl rand -base64 24`). */
export const MIN_JWT_SECRET_LENGTH = 32;

function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';
  const tooShort = !secret || secret.length < MIN_JWT_SECRET_LENGTH;

  if (tooShort) {
    if (isProduction) {
      // Fail fast: a misconfigured prod deploy must crash loudly at boot rather
      // than serve traffic with a secret that won't match the dashboard's.
      throw new Error(
        'FATAL: JWT_SECRET must be set and at least ' +
          `${MIN_JWT_SECRET_LENGTH} characters in production. ` +
          'Generate one with `openssl rand -base64 48` and set the IDENTICAL value on ' +
          'EVERY service that issues or verifies the session cookie (this API AND the dashboard).',
      );
    }

    // Non-production: allow the dev fallback so local dev works without setup,
    // but make insecure-secret usage impossible to miss in the logs.
    console.warn(
      `[auth-config] WARNING: JWT_SECRET is ${secret ? 'too short' : 'not set'}; ` +
        'falling back to an INSECURE development secret. Never run production like this. ' +
        'Set JWT_SECRET (e.g. `openssl rand -base64 48`) — and use the same value on the dashboard.',
    );
    return secret || DEV_FALLBACK_SECRET;
  }

  return secret as string;
}

/**
 * The validated JWT secret. Resolved once at module load so a misconfigured
 * production deploy fails at startup, not on the first login attempt.
 */
export const JWT_SECRET = resolveJwtSecret();

/** JWT lifetime. Kept in sync with COOKIE_MAX_AGE below. */
export const JWT_EXPIRY = '24h';

/** Name of the HTTP-only session cookie set on login. */
export const COOKIE_NAME = 'levelup_session';

/** Session cookie / token max age in milliseconds (24 hours). */
export const COOKIE_MAX_AGE = 24 * 60 * 60 * 1000;
