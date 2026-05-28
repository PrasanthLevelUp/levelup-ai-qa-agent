# Security Audit Report — LevelUp AI QA Platform

**Date:** May 28, 2026
**Auditor:** Abacus AI Security Review
**Scope:** Full stack — Backend (`levelup-ai-qa-agent`) + Frontend (`levelup-ai-qa-dashboard`)
**Classification:** CONFIDENTIAL

---

## Executive Summary

This comprehensive security audit identified **7 Critical**, **9 High**, **6 Medium**, and **5 Low** severity findings across the LevelUp AI QA Platform. The most urgent issue is **company-wide credential sharing** — GitHub PATs added by one user are accessible to ALL team members in the same company, creating significant breach risk.

The platform has a solid foundation (bcrypt password hashing, JWT sessions, API key auth, rate limiting on login), but lacks enterprise-grade data isolation, encryption at rest for credentials, per-user credential scoping, and role-based access control enforcement.

### Risk Rating: **HIGH**

**Immediate action required before production launch.**

---

## Table of Contents

1. [Critical Findings](#1-critical-findings)
2. [High Severity Findings](#2-high-severity-findings)
3. [Medium Severity Findings](#3-medium-severity-findings)
4. [Low Severity Findings](#4-low-severity-findings)
5. [Architecture Assessment](#5-architecture-assessment)
6. [What's Working Well](#6-whats-working-well)
7. [Fix Priority Matrix](#7-fix-priority-matrix)

---

## 1. Critical Findings

### CRIT-01: GitHub Tokens Stored Company-Wide, Not Per-User

| Field | Value |
|-------|-------|
| **Severity** | 🔴 CRITICAL |
| **Component** | Backend — `notification_configs` table, `github-service.ts` |
| **Impact** | Any team member can use any other member's GitHub PAT |
| **Fix Effort** | 3-5 days |

**Current Behavior:**
GitHub PATs are stored in the `notification_configs` table via `upsertNotificationConfig()`. The storage key is `(tool_type, company_id)` — meaning there's ONE GitHub token per company. When ANY user in the company connects GitHub, their PAT replaces the previous one and becomes usable by ALL team members.

```sql
-- Current: notification_configs
-- One record per (tool_type, company_id) — company-wide!
INSERT INTO notification_configs (tool_type, config, company_id)
VALUES ('github', '{"token": "ghp_xxxxx"}', 1)
ON CONFLICT (tool_type, COALESCE(company_id, 0)) DO UPDATE ...
```

**Attack Scenario:** User A (developer) connects their GitHub account with broad repo access. User B (QA tester) can now use User A's token to access all of User A's private repos, create PRs, read code, etc. — without User A knowing.

**Evidence:**
- `src/integrations/github-service.ts:135-145` — `getToken()` fetches from `notification_configs` by company, not user
- `src/db/postgres.ts:2991-3012` — `upsertNotificationConfig()` uses company-level unique constraint
- `src/api/routes/github.ts` — All endpoints use `companyId` to resolve token, not `userId`

---

### CRIT-02: Credentials Stored in Plaintext (No Encryption at Rest)

| Field | Value |
|-------|-------|
| **Severity** | 🔴 CRITICAL |
| **Component** | Backend — `notification_configs.config` (JSONB), `project_contexts.credentials` (TEXT) |
| **Impact** | Database breach exposes all tokens, API keys, webhook secrets |
| **Fix Effort** | 2-3 days |

**Current Behavior:**
Sensitive credentials are stored as plaintext JSON in the database:

- **`notification_configs.config`** — Contains GitHub PATs (`ghp_xxx`), Slack bot tokens (`xoxb-xxx`), Jira API tokens, GitLab tokens, Teams webhook URLs — all in plaintext JSONB
- **`project_contexts.credentials`** — Contains application credentials (usernames/passwords for test environments) in plaintext TEXT column

**No encryption functions exist anywhere in the codebase.** A search for `encrypt`, `decrypt`, `AES`, `cipher` found zero results related to credential storage.

**Evidence:**
- `src/db/postgres.ts:472-485` — `notification_configs` table, `config JSONB DEFAULT '{}'`
- `src/db/postgres.ts:354-369` — `project_contexts` table, `credentials TEXT`
- Zero hits for encryption utility functions in entire codebase

---

### CRIT-03: Default JWT Secret in Production Code

| Field | Value |
|-------|-------|
| **Severity** | 🔴 CRITICAL |
| **Component** | `src/api/middleware/company.ts`, `src/api/routes/auth.ts` |
| **Impact** | JWT forgery if default secret is used in production |
| **Fix Effort** | 1 hour |

**Current Code:**
```typescript
// company.ts line 19
const JWT_SECRET = process.env.JWT_SECRET || 'levelup-jwt-secret-change-in-production';

// auth.ts line 23
const JWT_SECRET = process.env.JWT_SECRET || 'levelup-jwt-secret-change-in-production';
```

If `JWT_SECRET` env var is not set (which happens in dev/staging), anyone can forge valid JWT tokens with arbitrary `companyId`, `userId`, and `role: 'admin'`.

---

### CRIT-04: Company Middleware Falls Back to Default Company (ID=1)

| Field | Value |
|-------|-------|
| **Severity** | 🔴 CRITICAL |
| **Component** | `src/api/middleware/company.ts:100-106` |
| **Impact** | Unauthenticated requests get assigned company_id=1, potentially accessing real data |
| **Fix Effort** | 2-4 hours |

**Current Code:**
```typescript
// If no company header and no JWT cookie:
(req as any).companyId = await resolveDefaultCompanyId(); // returns 1
// Error fallback:
(req as any).companyId = 1;
```

This means requests without proper authentication (failed JWT, missing headers) still get a valid `companyId` and can potentially access company 1's data through any downstream handler.

---

### CRIT-05: SQL Injection via String Interpolation in company_id Filtering

| Field | Value |
|-------|-------|
| **Severity** | 🔴 CRITICAL |
| **Component** | `src/db/postgres.ts` — multiple functions |
| **Impact** | SQL injection in 30+ query functions |
| **Fix Effort** | 2-3 days |

**Current Pattern (UNSAFE):**
```typescript
// Found in 30+ functions:
const cf = companyId ? `WHERE company_id = ${companyId}` : '';
const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
```

While `companyId` comes from middleware (usually an integer), the pattern is unsafe because:
1. The value is directly interpolated, not parameterized
2. If middleware is bypassed or manipulated, SQL injection is possible
3. The `days` parameter is also interpolated: `` `INTERVAL '${days} days'` ``

**Evidence:**
- `postgres.ts:1934` — `WHERE company_id = ${companyId}`
- `postgres.ts:2162` — `WHERE company_id = ${companyId}`
- `postgres.ts:2277` — `INTERVAL '${days} days'`
- `postgres.ts:2312-2313` — `WHERE ... company_id = ${companyId}`
- 25+ more instances throughout the file

---

### CRIT-06: Notification Config Deletion Without Company Scope Check

| Field | Value |
|-------|-------|
| **Severity** | 🔴 CRITICAL |
| **Component** | `src/db/postgres.ts:3014-3018`, `src/api/routes/notifications.ts` |
| **Impact** | Any authenticated user can delete ANY company's notification configs |
| **Fix Effort** | 1 hour |

```typescript
// postgres.ts — No company_id check!
export async function deleteNotificationConfig(id: number): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM notification_configs WHERE id = $1`, [id]
  );
  return (result.rowCount ?? 0) > 0;
}
```

The delete endpoint takes just an `id` parameter. No validation that the notification config belongs to the requesting user's company.

---

### CRIT-07: Webhook Endpoints Without Rate Limiting

| Field | Value |
|-------|-------|
| **Severity** | 🔴 CRITICAL |
| **Component** | `/api/webhook`, `/api/ci-webhooks`, `/api/ingest`, `/api/hooks` |
| **Impact** | DDoS via webhook spam; resource exhaustion creating unlimited healing jobs |
| **Fix Effort** | 1 day |

Four endpoint groups are exposed without `authMiddleware`:
```typescript
// server.ts lines 143-156 — NO authMiddleware
app.use('/api/webhook', createWebhookRouter(jobQueue, repoManager));
app.use('/api/ci-webhooks', createCIWebhookRouter(jobQueue));
app.use('/api/ingest', ...createIngestRouter(jobQueue));
app.use('/api/hooks', hooksRouter);
```

While webhooks validate signatures when secrets are configured, there's no rate limiting. An attacker could spam these endpoints to create unlimited healing jobs, consuming AI API credits and database resources.

---

## 2. High Severity Findings

### HIGH-01: No User-Level Data Isolation (Missing user_id)

| Field | Value |
|-------|-------|
| **Severity** | 🟠 HIGH |
| **Impact** | All team members see all data within a company |
| **Fix Effort** | 3-5 days |

**Tables missing `user_id` / `created_by` column:**
| Table | Has company_id | Has user_id/created_by |
|-------|:---:|:---:|
| `notification_configs` | ✅ | ❌ |
| `project_contexts` | ✅ | ❌ |
| `generated_scripts` | ✅ | ❌ |
| `test_requirements` | ✅ | ❌ |
| `repositories` | ✅ | ❌ |
| `knowledge_items` | ✅ | ❌ |
| `rca_analyses` | ✅ | ❌ |
| `pr_automations` | ✅ | ❌ |
| `webhook_configs` | ✅ | ❌ |

Every resource within a company is visible/editable by every team member. There's no concept of "my scripts" vs "team scripts" or "my test cases" vs "shared test cases."

---

### HIGH-02: No Role-Based Access Control Enforcement

| Field | Value |
|-------|-------|
| **Severity** | 🟠 HIGH |
| **Impact** | Any authenticated user has full admin capabilities |
| **Fix Effort** | 3-5 days |

**Current State:**
- A `roles` table exists in the schema but is **never populated or queried**
- No `user_roles` join table exists
- Users have a `role` column (values: `'admin'`, `'client'`) but it's only checked in ONE place: `GET /api/auth/users` (admin-only user listing)
- ALL other operations (delete projects, manage repos, change settings, access billing) have ZERO role checks

**Evidence:**
- `roles` table defined at `postgres.ts:737` — but no seed data, no queries
- `grep` for `isAdmin`, `hasPermission`, `requireAdmin`, `requireRole` returns only 1 hit: `auth.ts:304` (`decoded.role !== 'admin'`)
- All API routes use only `authMiddleware` (validates API key) + `companyMiddleware` (resolves tenant), but no permission checks

---

### HIGH-03: API Key Authentication is Shared, Not User-Specific

| Field | Value |
|-------|-------|
| **Severity** | 🟠 HIGH |
| **Impact** | Cannot identify which user performed an action via API |
| **Fix Effort** | 2 days |

The `authMiddleware` validates against `API_KEYS` environment variable — a comma-separated list of keys. All keys are equivalent; there's no mapping to specific users or scopes. The middleware sets `req.apiKeyName = 'key_1'` etc., but this doesn't link to any user identity.

The `api_keys` table in the database (with `company_id`, `scopes`, `rate_limit`) exists but is **only used for webhook/ingest authentication**, not for the main API. The main API uses the environment variable approach.

---

### HIGH-04: Session Tokens Not Validated Against Database

| Field | Value |
|-------|-------|
| **Severity** | 🟠 HIGH |
| **Impact** | Revoked sessions remain valid until JWT expiry |
| **Fix Effort** | 1 day |

Sessions are created in the `sessions` table during login, and `invalidateUserSessions()` is called on logout. However, the `/api/auth/me` endpoint and the `companyMiddleware` only verify the JWT signature — they never check if the session still exists in the database.

This means:
- After logout, the JWT cookie is cleared client-side, but the token itself remains valid
- If an attacker captures a JWT, it works even after the user logs out
- Admin deactivating a user doesn't immediately revoke their session

---

### HIGH-05: No CSRF Protection

| Field | Value |
|-------|-------|
| **Severity** | 🟠 HIGH |
| **Impact** | Cross-site request forgery on state-changing operations |
| **Fix Effort** | 1 day |

The session is stored in an HTTP-only cookie with `sameSite: 'lax'`. While `lax` provides some protection against CSRF via `POST` from cross-origin, it does not protect against:
- Subdomains performing requests
- GET requests that trigger state changes
- Scenarios where the cookie is set to `sameSite: 'none'` for cross-origin API access

No CSRF token mechanism exists in the application.

---

### HIGH-06: project_contexts.credentials Stores Plaintext App Passwords

| Field | Value |
|-------|-------|
| **Severity** | 🟠 HIGH |
| **Impact** | Test environment credentials exposed in database |
| **Fix Effort** | 1 day |

`project_contexts.credentials` (TEXT) stores login credentials for applications under test. These are plaintext and returned in API responses without sanitization. If the API for project contexts is queried, full credentials are exposed.

---

### HIGH-07: No Input Validation/Sanitization on Most Endpoints

| Field | Value |
|-------|-------|
| **Severity** | 🟠 HIGH |
| **Impact** | Stored XSS, injection attacks, data integrity issues |
| **Fix Effort** | 3-4 days |

Most route handlers accept user input without validation beyond basic existence checks (`if (!title)` etc.). There's no:
- Schema validation (no Zod, Joi, or JSON Schema)
- HTML/XSS sanitization on stored text fields
- Length limits enforced at the application layer
- Type coercion validation

---

### HIGH-08: Webhook Secrets Stored in Plaintext

| Field | Value |
|-------|-------|
| **Severity** | 🟠 HIGH |
| **Impact** | Webhook secrets exposed in database breach |
| **Fix Effort** | 1 day |

`webhook_configs.webhook_secret` is `VARCHAR(255) NOT NULL` — stored as plaintext. These secrets validate incoming webhooks from GitHub/CI providers. If compromised, an attacker can forge webhook events.

---

### HIGH-09: No Global Rate Limiting on API

| Field | Value |
|-------|-------|
| **Severity** | 🟠 HIGH |
| **Impact** | API abuse, AI credit exhaustion, DoS |
| **Fix Effort** | 1 day |

Rate limiting exists ONLY on the login endpoint (5 attempts per 15 minutes). There is no rate limiting on:
- Test generation endpoints (each consuming AI tokens/credits)
- Script generation endpoints
- Knowledge management endpoints
- File operations
- Any other API endpoint

An attacker with a valid API key could exhaust AI credits, fill disk with generated scripts, or overwhelm the database.

---

## 3. Medium Severity Findings

### MED-01: Frontend Exposes Backend API Key in Server Environment

| Field | Value |
|-------|-------|
| **Severity** | 🟡 MEDIUM |
| **Impact** | API key visible in server memory/process |
| **Fix Effort** | Low |

`lib/backend-api.ts` and `lib/backend-proxy.ts` read `BACKEND_API_KEY` from environment. While this is server-side only (Next.js API routes), if the frontend were misconfigured to expose env vars to the client bundle, the API key would leak.

---

### MED-02: Audit Log Coverage is Incomplete

| Field | Value |
|-------|-------|
| **Severity** | 🟡 MEDIUM |
| **Impact** | Cannot track who performed sensitive operations |
| **Fix Effort** | 2 days |

`audit_logs` table exists and is used for login/logout events. However, audit logging is NOT implemented for:
- GitHub token connection/disconnection
- Project creation/deletion
- Script generation
- Knowledge item changes
- Repository configuration changes
- Billing operations

---

### MED-03: No Request ID / Correlation ID for Tracing

| Field | Value |
|-------|-------|
| **Severity** | 🟡 MEDIUM |
| **Impact** | Cannot trace requests across frontend → backend for debugging |
| **Fix Effort** | 1 day |

---

### MED-04: Error Messages May Leak Internal Details

| Field | Value |
|-------|-------|
| **Severity** | 🟡 MEDIUM |
| **Impact** | Stack traces, file paths, DB errors visible to clients |
| **Fix Effort** | 1 day |

The error handler includes stack traces in non-production environments. Some route handlers also return raw error messages: `res.status(500).json({ error: error.message })`.

---

### MED-05: No Content Security Policy (CSP) Headers

| Field | Value |
|-------|-------|
| **Severity** | 🟡 MEDIUM |
| **Impact** | XSS attack surface increased |
| **Fix Effort** | 1 day |

No security headers (CSP, X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security) are set on API responses.

---

### MED-06: JWT Expiry is 24 Hours (Too Long for Sensitive Platform)

| Field | Value |
|-------|-------|
| **Severity** | 🟡 MEDIUM |
| **Impact** | Stolen tokens have a long validity window |
| **Fix Effort** | 1 hour |

JWT expiry is set to 24h. For a platform with credential access, 4-8 hours would be more appropriate, with a refresh token mechanism.

---

## 4. Low Severity Findings

### LOW-01: CORS Configuration Allows Credentials from Multiple Origins

Not fully audited — depends on `cors()` configuration in server.ts.

### LOW-02: No Password Complexity Requirements

User creation in `users.ts` accepts any password without complexity validation (length, special chars, etc.).

### LOW-03: Bcrypt Cost Factor Not Explicitly Set

Password hashing uses `bcrypt.hash(password, 10)` — cost factor 10 is acceptable but could be 12 for higher security.

### LOW-04: No Account Lockout After Failed API Key Attempts

The API key middleware rejects invalid keys but doesn't track/block repeated failures from the same IP.

### LOW-05: Database Connection Pool Doesn't Enforce SSL

No `ssl: { rejectUnauthorized: true }` found in pool configuration.

---

## 5. Architecture Assessment

### Current Authentication Flow

```
Frontend (Next.js)
  ↓ POST /api/auth/login (proxy)
Backend (Express)
  ↓ Validate username/password (bcrypt)
  ↓ Generate JWT (userId, role, companyId)
  ↓ Set HTTP-only cookie
  ↓ Create session in sessions table

Subsequent Requests:
Frontend → POST /api/xxx (proxy)
  ↓ backendProxy adds: Cookie + Authorization: Bearer API_KEY
Backend:
  ↓ authMiddleware → validates API_KEY (from env var)
  ↓ companyMiddleware → extracts companyId from JWT cookie
  ↓ Route handler → uses (req as any).companyId
```

### Current Data Isolation Model

```
Level 1: Company (✅ Implemented, mostly)
  - Most tables have company_id
  - company_id resolved from JWT or header
  
Level 2: Project (✅ Partially Implemented)
  - project_id middleware exists
  - Only some routes use it

Level 3: User (❌ NOT Implemented)
  - No user_id on resource tables
  - No "created_by" tracking
  - No personal vs shared resources

Level 4: Role-Based (❌ NOT Implemented)
  - roles table exists but empty/unused
  - No permission checks on any endpoint
```

---

## 6. What's Working Well

| Area | Status | Notes |
|------|--------|-------|
| Password Hashing | ✅ Good | bcrypt with cost 10 |
| Session Management | ✅ Good | HTTP-only cookies, sameSite: lax, secure in prod |
| Login Rate Limiting | ✅ Good | 5 attempts/15min window, IP-based |
| API Key Model | ✅ Good | `api_keys` table with scopes, hashing, expiry |
| Audit Logging (Login) | ✅ Good | Login success/failure, IP, user-agent logged |
| Webhook Signature Validation | ✅ Good | HMAC SHA-256 verification when configured |
| Sensitive Field Masking | ✅ Good | `sanitizeConfig()` masks tokens in API responses |
| Company Isolation (Basic) | ✅ Mostly | company_id on most tables, middleware resolves it |

---

## 7. Fix Priority Matrix

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| **P0 — Immediate** | CRIT-01: Per-user credentials | 3-5 days | Blocks production |
| **P0 — Immediate** | CRIT-02: Encrypt credentials at rest | 2-3 days | Blocks production |
| **P0 — Immediate** | CRIT-03: Remove default JWT secret | 1 hour | Blocks production |
| **P0 — Immediate** | CRIT-05: Fix SQL injection patterns | 2-3 days | Blocks production |
| **P1 — This Sprint** | CRIT-04: Fix company fallback to reject | 4 hours | High risk |
| **P1 — This Sprint** | CRIT-06: Scope notification delete | 1 hour | High risk |
| **P1 — This Sprint** | CRIT-07: Rate limit webhooks | 1 day | DDoS risk |
| **P1 — This Sprint** | HIGH-02: RBAC enforcement | 3-5 days | Enterprise blocker |
| **P1 — This Sprint** | HIGH-04: Session DB validation | 1 day | Security gap |
| **P1 — This Sprint** | HIGH-07: Input validation | 3-4 days | Injection risk |
| **P1 — This Sprint** | HIGH-09: Global rate limiting | 1 day | Abuse risk |
| **P2 — Next Sprint** | HIGH-01: User-level data isolation | 3-5 days | Team feature |
| **P2 — Next Sprint** | HIGH-03: User-specific API keys | 2 days | Audit trail |
| **P2 — Next Sprint** | HIGH-05: CSRF protection | 1 day | Defense in depth |
| **P2 — Next Sprint** | HIGH-06: Encrypt project credentials | 1 day | Data protection |
| **P2 — Next Sprint** | HIGH-08: Encrypt webhook secrets | 1 day | Data protection |
| **P2 — Next Sprint** | MED-02: Complete audit logging | 2 days | Compliance |
| **P3 — Backlog** | MED-03 through MED-06 | 2-3 days | Polish |
| **P3 — Backlog** | LOW-01 through LOW-05 | 1-2 days | Best practice |

---

## Appendix: Files Audited

### Backend (`levelup-ai-qa-agent`)
- `src/db/postgres.ts` — Full schema, all queries
- `src/api/middleware/auth.ts` — API key middleware
- `src/api/middleware/company.ts` — Company resolution
- `src/api/middleware/project-context.ts` — Project scoping
- `src/api/middleware/license.ts` — Subscription checks
- `src/api/routes/auth.ts` — Login/logout/session
- `src/api/routes/notifications.ts` — Credential storage
- `src/api/routes/github.ts` — GitHub integration
- `src/api/routes/users.ts` — User management
- `src/api/routes/hooks.ts` — Webhook receivers
- `src/api/server.ts` — Route registration
- `src/integrations/github-service.ts` — GitHub API client
- `src/api/services/api-key-service.ts` — API key management

### Frontend (`levelup-ai-qa-dashboard`)
- `lib/backend-api.ts` — Backend API client
- `lib/backend-proxy.ts` — Proxy with cookie forwarding
- `app/api/auth/*/route.ts` — Auth proxy routes

---

*This report should be treated as confidential. Share only with authorized personnel.*
