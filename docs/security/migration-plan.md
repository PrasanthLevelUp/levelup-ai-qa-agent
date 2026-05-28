# Security Migration Plan

**Date:** May 28, 2026
**Status:** Ready for Review

---

## Overview

This plan describes how to migrate the existing production database from the current insecure credential storage model to the new encrypted, per-user credential architecture — with zero downtime.

---

## Pre-Migration Checklist

- [ ] Generate `CREDENTIAL_ENCRYPTION_KEY` (32 bytes / 64 hex chars): `openssl rand -hex 32`
- [ ] Generate strong `JWT_SECRET` (64+ chars): `openssl rand -base64 48`
- [ ] Store both in Railway environment variables (NOT in `.env` files)
- [ ] Back up the production database
- [ ] Test migration on staging first

---

## Migration Steps

### Step 1: Deploy Schema Changes

Create all new tables and columns in a non-breaking way (additive only):

```sql
-- 1a. user_credentials table
CREATE TABLE IF NOT EXISTS user_credentials (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  credential_type VARCHAR(50) NOT NULL,
  label           VARCHAR(255) DEFAULT 'default',
  encrypted_value TEXT NOT NULL,
  iv              VARCHAR(32) NOT NULL,
  auth_tag        VARCHAR(32) NOT NULL,
  metadata        JSONB DEFAULT '{}',
  is_company_default BOOLEAN DEFAULT false,
  expires_at      TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ,
  last_rotated_at TIMESTAMPTZ,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, company_id, credential_type, label)
);
CREATE INDEX IF NOT EXISTS idx_user_creds_user ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_creds_company ON user_credentials(company_id);
CREATE INDEX IF NOT EXISTS idx_user_creds_type ON user_credentials(credential_type);

-- 1b. user_roles table
CREATE TABLE IF NOT EXISTS user_roles (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id    INTEGER NOT NULL REFERENCES roles(id),
  granted_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_company ON user_roles(company_id);

-- 1c. Seed default roles (idempotent)
INSERT INTO roles (name, slug, description, permissions, is_system)
VALUES
  ('Admin', 'admin', 'Full access', '{"*": ["*"]}', true),
  ('Member', 'member', 'Standard access', '{"projects": ["read","update"], "scripts": ["create","read","update"], "knowledge": ["create","read","update"], "test_coverage": ["create","read"]}', true),
  ('Viewer', 'viewer', 'Read-only access', '{"projects": ["read"], "scripts": ["read"], "knowledge": ["read"], "test_coverage": ["read"]}', true)
ON CONFLICT (slug) DO NOTHING;

-- 1d. Add created_by to resource tables
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='generated_scripts' AND column_name='created_by') THEN
    ALTER TABLE generated_scripts ADD COLUMN created_by INTEGER REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='test_requirements' AND column_name='created_by') THEN
    ALTER TABLE test_requirements ADD COLUMN created_by INTEGER REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='knowledge_items' AND column_name='created_by') THEN
    ALTER TABLE knowledge_items ADD COLUMN created_by INTEGER REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='project_contexts' AND column_name='created_by') THEN
    ALTER TABLE project_contexts ADD COLUMN created_by INTEGER REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pr_automations' AND column_name='created_by') THEN
    ALTER TABLE pr_automations ADD COLUMN created_by INTEGER REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='webhook_configs' AND column_name='created_by') THEN
    ALTER TABLE webhook_configs ADD COLUMN created_by INTEGER REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='rca_analyses' AND column_name='created_by') THEN
    ALTER TABLE rca_analyses ADD COLUMN created_by INTEGER REFERENCES users(id);
  END IF;
END $$;

-- 1e. Add audit_logs enhancements
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='audit_logs' AND column_name='company_id') THEN
    ALTER TABLE audit_logs ADD COLUMN company_id INTEGER REFERENCES companies(id);
  END IF;
END $$;
```

### Step 2: Migrate Existing Credentials

Run a one-time migration script to:
1. Read all rows from `notification_configs` with credential data
2. Encrypt the sensitive fields using the new encryption module
3. Insert into `user_credentials` table (assign to the admin user of each company)
4. Mark as `is_company_default = true`

```typescript
// scripts/migrate-credentials.ts
import { getPool } from '../src/db/postgres';
import { encryptCredential } from '../src/utils/crypto';

async function migrateCredentials() {
  const pool = getPool();
  
  // Get all notification configs with credentials
  const { rows: configs } = await pool.query(
    `SELECT nc.*, c.id as resolved_company_id 
     FROM notification_configs nc
     LEFT JOIN companies c ON c.id = nc.company_id
     WHERE nc.config IS NOT NULL AND nc.config != '{}'`
  );
  
  for (const config of configs) {
    const companyId = config.resolved_company_id || config.company_id || 1;
    
    // Find admin user for this company (or first user)
    const { rows: users } = await pool.query(
      `SELECT id FROM users WHERE company_id = $1 AND role = 'admin' LIMIT 1`,
      [companyId]
    );
    const adminId = users[0]?.id;
    if (!adminId) {
      console.warn(`No admin found for company ${companyId}, skipping`);
      continue;
    }
    
    // Encrypt the credential config
    const { encrypted, iv, authTag } = encryptCredential(
      JSON.stringify(config.config)
    );
    
    // Extract non-sensitive metadata
    const metadata: any = {};
    if (config.config.username) metadata.username = config.config.username;
    if (config.config.webhookUrl) metadata.hasWebhookUrl = true;
    
    await pool.query(
      `INSERT INTO user_credentials 
       (user_id, company_id, credential_type, label, encrypted_value, iv, auth_tag, metadata, is_company_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       ON CONFLICT (user_id, company_id, credential_type, label) DO NOTHING`,
      [adminId, companyId, config.tool_type, 'default', encrypted, iv, authTag, JSON.stringify(metadata)]
    );
    
    console.log(`Migrated ${config.tool_type} for company ${companyId} → user ${adminId}`);
  }
  
  console.log('Migration complete. Old notification_configs NOT deleted (kept for rollback).');
}

migrateCredentials().catch(console.error);
```

### Step 3: Assign Default Roles to Existing Users

```sql
-- Assign 'admin' role to users with role='admin'
INSERT INTO user_roles (user_id, company_id, role_id)
SELECT u.id, u.company_id, r.id
FROM users u
CROSS JOIN roles r
WHERE u.role = 'admin' AND r.slug = 'admin' AND u.company_id IS NOT NULL
ON CONFLICT (user_id, company_id) DO NOTHING;

-- Assign 'member' role to users with role='client' or NULL
INSERT INTO user_roles (user_id, company_id, role_id)
SELECT u.id, u.company_id, r.id
FROM users u
CROSS JOIN roles r
WHERE (u.role = 'client' OR u.role IS NULL) AND r.slug = 'member' AND u.company_id IS NOT NULL
ON CONFLICT (user_id, company_id) DO NOTHING;
```

### Step 4: Deploy Code Changes

Deploy the new code that:
1. Uses `user_credentials` table for credential lookups (with fallback to `notification_configs`)
2. Enforces RBAC middleware
3. Uses parameterized queries
4. Validates sessions against DB
5. Requires JWT_SECRET in env

**Backward compatibility:** Keep `notification_configs` read path as fallback for 1 release cycle.

### Step 5: Verify and Cleanup

After confirming migration success:
1. Remove fallback to `notification_configs` for credential lookups
2. Optionally: truncate `notification_configs.config` (set to `'{}'`)
3. Encrypt `project_contexts.credentials` (same approach)
4. Encrypt `webhook_configs.webhook_secret`

---

## Rollback Plan

If migration fails:
1. The old `notification_configs` table is never modified during migration
2. Revert code to previous version (reads from `notification_configs` directly)
3. Drop new tables: `user_credentials`, `user_roles` (no data loss)
4. Remove `created_by` columns (optional, they're nullable)

---

## Timeline

| Week | Action | Risk |
|------|--------|------|
| Week 1, Day 1-2 | Deploy schema changes + encryption module | Low — additive only |
| Week 1, Day 3 | Run credential migration script (staging) | Medium — test thoroughly |
| Week 1, Day 4 | Deploy new credential lookup code (with fallback) | Low — fallback in place |
| Week 1, Day 5 | Run credential migration script (production) | Medium |
| Week 2, Day 1-3 | Deploy RBAC + SQL fixes + rate limiting | Medium |
| Week 2, Day 4-5 | Deploy frontend user-specific connection UI | Low |
| Week 3 | Remove fallback paths, cleanup old data | Low |
| Week 4 | Audit + penetration testing | N/A |

---

## Environment Variables Required

```bash
# MANDATORY — generate with: openssl rand -hex 32
CREDENTIAL_ENCRYPTION_KEY=<64-char-hex-string>

# MANDATORY — generate with: openssl rand -base64 48
JWT_SECRET=<strong-random-string-64+chars>

# Already exists (keep)
API_KEYS=<comma-separated-api-keys>
```

---

*Test this entire plan on staging before production deployment.*
