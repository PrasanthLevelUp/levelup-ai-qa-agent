# Security Architecture — LevelUp AI QA Platform

**Version:** 2.0 (Post-Audit Redesign)
**Date:** May 28, 2026
**Status:** Proposed

---

## 1. Overview

This document describes the target security architecture addressing all findings from the Security Audit Report. It covers credential management, data isolation, access control, encryption, and audit logging.

---

## 2. Credential Management (Addresses CRIT-01, CRIT-02, HIGH-06, HIGH-08)

### 2.1 New `user_credentials` Table

Replaces the current approach of storing credentials in `notification_configs.config` JSONB.

```sql
CREATE TABLE user_credentials (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  credential_type VARCHAR(50) NOT NULL,     -- 'github', 'gitlab', 'jira', 'slack', etc.
  label           VARCHAR(255),              -- User-friendly name: "My GitHub (work)"
  encrypted_value TEXT NOT NULL,             -- AES-256-GCM encrypted JSON
  iv              VARCHAR(32) NOT NULL,      -- Initialization vector (hex)
  auth_tag        VARCHAR(32) NOT NULL,      -- GCM authentication tag (hex)
  metadata        JSONB DEFAULT '{}',        -- Non-sensitive metadata (username, scopes, etc.)
  expires_at      TIMESTAMPTZ,               -- Token expiry if applicable
  last_used_at    TIMESTAMPTZ,
  last_rotated_at TIMESTAMPTZ,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, company_id, credential_type, label)
);

CREATE INDEX idx_user_creds_user ON user_credentials(user_id);
CREATE INDEX idx_user_creds_company ON user_credentials(company_id);
CREATE INDEX idx_user_creds_type ON user_credentials(credential_type);
```

### 2.2 Encryption Module

New utility: `src/utils/crypto.ts`

```typescript
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_ENV = 'CREDENTIAL_ENCRYPTION_KEY'; // Must be 32 bytes hex (64 chars)

function getKey(): Buffer {
  const hexKey = process.env[KEY_ENV];
  if (!hexKey || hexKey.length !== 64) {
    throw new Error(`${KEY_ENV} must be a 64-character hex string (32 bytes)`);
  }
  return Buffer.from(hexKey, 'hex');
}

export function encryptCredential(plaintext: string): { encrypted: string; iv: string; authTag: string } {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return { encrypted, iv: iv.toString('hex'), authTag };
}

export function decryptCredential(encrypted: string, iv: string, authTag: string): string {
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
```

### 2.3 Credential Resolution Hierarchy

When an operation needs a GitHub token:

```
1. User's personal token (user_credentials WHERE user_id = ? AND credential_type = 'github')
2. Company fallback token (user_credentials WHERE credential_type = 'github' AND is_company_default = true)
3. Environment variable (process.env.GITHUB_TOKEN)
4. Reject with clear error message
```

Each level is logged with the resolution source so admins know which token was used.

---

## 3. Role-Based Access Control (Addresses HIGH-02)

### 3.1 New Tables

```sql
-- Seed with default roles
INSERT INTO roles (name, slug, description, permissions, is_system) VALUES
  ('Admin', 'admin', 'Full access to all features', '{
    "projects": ["create", "read", "update", "delete"],
    "repositories": ["create", "read", "update", "delete"],
    "scripts": ["create", "read", "update", "delete", "execute"],
    "knowledge": ["create", "read", "update", "delete"],
    "test_coverage": ["create", "read", "update", "delete"],
    "settings": ["read", "update"],
    "billing": ["read", "update"],
    "users": ["create", "read", "update", "delete"],
    "credentials": ["create", "read", "update", "delete", "view_all"],
    "audit_logs": ["read"]
  }', true),
  ('Member', 'member', 'Standard team member access', '{
    "projects": ["read", "update"],
    "repositories": ["read"],
    "scripts": ["create", "read", "update"],
    "knowledge": ["create", "read", "update"],
    "test_coverage": ["create", "read"],
    "settings": ["read"],
    "credentials": ["create", "read", "update"]
  }', true),
  ('Viewer', 'viewer', 'Read-only access', '{
    "projects": ["read"],
    "repositories": ["read"],
    "scripts": ["read"],
    "knowledge": ["read"],
    "test_coverage": ["read"],
    "settings": ["read"]
  }', true);

-- User ↔ Role mapping (per company)
CREATE TABLE user_roles (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id    INTEGER NOT NULL REFERENCES roles(id),
  granted_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, company_id)
);

CREATE INDEX idx_user_roles_user ON user_roles(user_id);
CREATE INDEX idx_user_roles_company ON user_roles(company_id);
```

### 3.2 Permission Middleware

```typescript
// src/api/middleware/rbac.ts
export function requirePermission(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as any).userId;
    const companyId = (req as any).companyId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const userRole = await getUserRole(userId, companyId);
    const permissions = userRole?.permissions || {};
    const allowed = permissions[resource]?.includes(action);
    
    if (!allowed) {
      await logAudit({
        user_id: userId,
        action: 'permission_denied',
        resource,
        details: { action, role: userRole?.slug }
      });
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        required: `${resource}:${action}`
      });
    }
    
    next();
  };
}
```

### 3.3 Usage Pattern

```typescript
// In route files:
router.delete('/:id', requirePermission('projects', 'delete'), async (req, res) => { ... });
router.post('/generate', requirePermission('test_coverage', 'create'), async (req, res) => { ... });
```

---

## 4. Enhanced Authentication (Addresses CRIT-03, CRIT-04, HIGH-04)

### 4.1 Mandatory JWT Secret

```typescript
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('FATAL: JWT_SECRET must be set and at least 32 characters');
}
```

### 4.2 Session Database Validation

Every authenticated request validates the session exists and is not expired:

```typescript
// In companyMiddleware or new sessionMiddleware:
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const session = await getValidSession(tokenHash);
if (!session || session.expires_at < new Date()) {
  return res.status(401).json({ error: 'Session expired or revoked' });
}
(req as any).userId = session.user_id;
```

### 4.3 Company Middleware — Strict Mode

```typescript
// Remove fallback to company_id=1
// If no valid company resolution → reject the request
if (!companyId) {
  return res.status(401).json({ 
    error: 'Could not resolve company. Please log in again.' 
  });
}
```

---

## 5. Data Isolation (Addresses HIGH-01)

### 5.1 Resource Ownership

Add `created_by` to all major tables:

```sql
ALTER TABLE generated_scripts ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE test_requirements ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE knowledge_items ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE pr_automations ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE project_contexts ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE webhook_configs ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE rca_analyses ADD COLUMN created_by INTEGER REFERENCES users(id);
```

### 5.2 Visibility Model

```
Private: Only creator can see/edit (default for credentials)
Team: All members in the company can see (default for scripts, test cases)
Public: Visible to all (for shared knowledge items, company templates)
```

```sql
ALTER TABLE generated_scripts ADD COLUMN visibility VARCHAR(20) DEFAULT 'team';
ALTER TABLE knowledge_items ADD COLUMN visibility VARCHAR(20) DEFAULT 'team';
```

---

## 6. SQL Injection Prevention (Addresses CRIT-05)

### 6.1 Parameterized Query Pattern

Replace all string interpolation:

```typescript
// BEFORE (unsafe):
const cf = companyId ? `WHERE company_id = ${companyId}` : '';
const result = await pool.query(`SELECT * FROM table ${cf}`);

// AFTER (safe):
const params: any[] = [];
let where = '';
if (companyId) {
  params.push(companyId);
  where = `WHERE company_id = $${params.length}`;
}
const result = await pool.query(`SELECT * FROM table ${where}`, params);
```

### 6.2 Query Builder Helper

```typescript
// src/db/query-builder.ts
export class QueryFilter {
  private conditions: string[] = [];
  private params: any[] = [];
  
  addIf(condition: boolean, sql: string, value: any): this {
    if (condition) {
      this.params.push(value);
      this.conditions.push(sql.replace('?', `$${this.params.length}`));
    }
    return this;
  }
  
  whereClause(): string {
    return this.conditions.length > 0 ? `WHERE ${this.conditions.join(' AND ')}` : '';
  }
  
  andClause(): string {
    return this.conditions.length > 0 ? `AND ${this.conditions.join(' AND ')}` : '';
  }
  
  values(): any[] { return this.params; }
}
```

---

## 7. Audit Logging (Addresses MED-02)

### 7.1 Comprehensive Audit Events

```typescript
// Audit all sensitive operations:
const AUDIT_EVENTS = {
  // Auth
  'auth.login_success', 'auth.login_failed', 'auth.logout',
  'auth.session_expired', 'auth.permission_denied',
  
  // Credentials
  'credential.created', 'credential.deleted', 'credential.used',
  'credential.rotated', 'credential.expired',
  
  // Resources
  'project.created', 'project.deleted', 'project.updated',
  'script.generated', 'script.deleted',
  'test_coverage.generated',
  'knowledge.created', 'knowledge.deleted',
  'repo.connected', 'repo.disconnected',
  
  // Admin
  'user.created', 'user.deactivated', 'user.role_changed',
  'settings.updated', 'billing.changed',
  
  // GitHub
  'github.pr_created', 'github.repo_listed', 'github.token_used',
};
```

### 7.2 Middleware-Based Logging

```typescript
// Auto-log all state-changing API calls
export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const originalEnd = res.end;
    res.end = function(...args: any[]) {
      logAudit({
        user_id: (req as any).userId,
        action: `${req.method} ${req.path}`,
        resource: req.path.split('/')[3], // e.g., 'projects', 'scripts'
        resource_id: req.params.id,
        ip_address: getClientIp(req),
        user_agent: req.headers['user-agent'],
        details: { status: res.statusCode },
      }).catch(() => {}); // Never block on audit
      return originalEnd.apply(res, args);
    };
  }
  next();
}
```

---

## 8. API Security (Addresses CRIT-07, HIGH-05, HIGH-07, HIGH-09)

### 8.1 Global Rate Limiting

```typescript
import rateLimit from 'express-rate-limit';

// General API rate limit
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  keyGenerator: (req) => (req as any).companyId || getClientIp(req),
  message: { error: 'Rate limit exceeded. Please try again later.' },
}));

// Expensive operations (AI generation)
const aiRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  keyGenerator: (req) => `${(req as any).companyId}-ai`,
  message: { error: 'AI generation rate limit exceeded.' },
});

app.use('/api/test-coverage/generate', aiRateLimit);
app.use('/api/scripts/generate', aiRateLimit);

// Webhook rate limit
app.use('/api/webhook', rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Webhook rate limit exceeded.' },
}));
```

### 8.2 Input Validation with Zod

```typescript
import { z } from 'zod';

const generateSchema = z.object({
  title: z.string().min(3).max(500),
  description: z.string().min(10).max(10000),
  jiraId: z.string().max(50).optional(),
  coverageTypes: z.array(z.enum([
    'positive', 'negative', 'edge_cases', 'boundary', 'security',
    'api', 'ui', 'mobile', 'accessibility', 'performance',
    'integration', 'regression', 'cross_browser', 'data_validation',
    'role_based', 'localization'
  ])).optional(),
  knowledgeItemIds: z.array(z.number().int().positive()).max(20).optional(),
  useRepoIntelligence: z.boolean().optional(),
  repoId: z.string().max(500).optional(),
  includeCoverageGaps: z.boolean().optional(),
});

// Middleware:
export function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues,
      });
    }
    req.body = result.data; // Use parsed/cleaned data
    next();
  };
}
```

### 8.3 Security Headers

```typescript
import helmet from 'helmet';
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: true,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
```

---

## 9. Frontend Security (Addresses PHASE 4)

### 9.1 User-Specific Connection UI

```
Before: "Connect GitHub" → stores company-wide
After:  "Connect YOUR GitHub" → stores per-user

Status display:
Before: "Connected ✓"
After:  "Connected as @PrasanthLevelUp (your personal token)"
```

### 9.2 Settings Separation

```
Personal Settings:
  - My GitHub connection
  - My notification preferences
  - My API keys

Company Settings (Admin only):
  - Team members & roles
  - Default integrations
  - Billing & subscription
  - Audit logs
```

---

## 10. Implementation Order

```
Phase 1 (Week 1): Critical Fixes
  ├── Encryption module (crypto.ts)
  ├── user_credentials table + migration
  ├── Fix JWT secret to be mandatory
  ├── Fix company middleware to reject (no fallback)
  ├── Parameterize SQL queries (company_id patterns)
  └── Rate limiting on webhooks + API

Phase 2 (Week 2): Access Control
  ├── user_roles table + seed roles
  ├── RBAC middleware
  ├── Session DB validation
  ├── Resource ownership (created_by columns)
  └── Scope notification delete to company

Phase 3 (Week 3): Comprehensive Security
  ├── Zod input validation on all routes
  ├── Comprehensive audit logging
  ├── Security headers (helmet)
  ├── CSRF token mechanism
  └── Frontend: user-specific connections UI

Phase 4 (Week 4): Polish & Compliance
  ├── Migrate existing credentials to encrypted storage
  ├── Data export / deletion APIs (GDPR)
  ├── Security documentation
  └── Penetration testing
```

---

*This architecture document should be reviewed and approved before implementation.*
