/**
 * PostgreSQL database layer for the self-healing QA agent.
 * Replaces SQLite for production Railway deployment.
 */

import { Pool, type PoolClient } from 'pg';
import { logger } from '../utils/logger';

const MOD = 'postgres';

export interface TestExecution {
  test_name: string;
  status: string;
  error_message?: string;
  screenshot_path?: string;
  github_commit_sha?: string;
  duration_ms?: number;
  healing_attempted?: boolean;
  healing_succeeded?: boolean;
}

export interface HealingAction {
  test_execution_id: number;
  test_name: string;
  failed_locator: string;
  healed_locator?: string;
  healing_strategy: 'rule_based' | 'database_pattern' | 'ai_reasoning';
  ai_tokens_used?: number;
  success?: boolean;
  confidence?: number;
  error_context?: string;
  validation_status?: 'approved' | 'rejected' | 'reverted';
  validation_reason?: string;
  patch_path?: string;
}

export interface LearnedPattern {
  test_name: string;
  error_pattern: string;
  failed_locator: string;
  healed_locator: string;
  solution_strategy: string;
  confidence?: number;
  avg_tokens_saved?: number;
}

export interface HistoricalStats {
  total_executions: number;
  total_healings: number;
  success_rate: string;
  total_tokens: number;
  tokens_saved: string;
  learned_patterns: number;
  strategy_breakdown: { rule_based: number; database_pattern: number; ai_reasoning: number };
}

let pool: Pool | null = null;

function getConnectionString(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return url;
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getConnectionString(),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: process.env['DATABASE_SSL'] === 'false' ? false : { rejectUnauthorized: false },
    });
    logger.info(MOD, 'PostgreSQL pool initialized');
  }
  return pool;
}

/** All tables that MUST exist for the application to function correctly. */
const REQUIRED_TABLES = [
  // Core
  'companies', 'users', 'roles', 'sessions', 'audit_logs',
  // Test execution & healing
  'test_executions', 'healing_actions', 'learned_patterns', 'healing_jobs',
  // Notifications
  'notification_configs', 'notification_logs',
  // Billing
  'plans', 'subscriptions', 'subscription_usage', 'billing_events', 'payment_methods',
  // Script generation
  'project_contexts', 'generated_scripts', 'dom_snapshots', 'selector_scores',
  'workflow_maps', 'generated_projects',
  // PR automation
  'pr_automations',
  // RCA
  'rca_analyses',
  // Token & AI usage
  'token_usage', 'ai_usage_logs',
  // DOM Memory ↔ Healing
  'selector_history',
  // API keys & ingestion
  'api_keys', 'ingestion_logs',
  // Repository intelligence
  'repository_contexts', 'code_chunks',
  // Test coverage
  'test_requirements', 'generated_test_scenarios', 'generated_test_cases',
  // Knowledge
  'application_knowledge', 'knowledge_items', 'knowledge_relationships',
  // Projects
  'projects', 'repositories',
  // Webhooks
  'webhook_configs', 'webhook_events', 'release_windows',
];

export async function initDb(): Promise<void> {
  console.log('🔧 [DB] initDb() called — connecting to PostgreSQL...');
  const client = await getPool().connect();
  console.log('🔧 [DB] Connected to PostgreSQL pool');
  try {
    // Quick connection test
    const now = await client.query('SELECT NOW() AS t');
    console.log(`🔧 [DB] Connection verified: ${now.rows[0]?.t}`);

    logger.info(MOD, '🚀 Starting database schema initialization...');
    console.log('🔧 [DB] Running initSchema...');
    await initSchema(client);
    logger.info(MOD, '✅ PostgreSQL schema initialized');
    console.log('✅ [DB] initSchema completed');

    // Verify all required tables exist post-init
    await verifySchema(client);
  } catch (err: any) {
    console.error('⚠️ [DB] initDb encountered errors:', err?.message, err?.code, err?.detail);
    logger.error(MOD, 'initDb encountered errors (non-fatal — server continues)', {
      error: err?.message, code: err?.code, detail: err?.detail,
    });
    // Do NOT throw — let the server start so healthcheck passes.
    // Individual table errors are already logged by safeExec.
    // Use GET /api/health/database to check which tables are missing.
  } finally {
    client.release();
  }
}

/**
 * Verify all required tables exist in the database.
 * Logs warnings for any missing tables — does NOT throw.
 */
async function verifySchema(client: PoolClient): Promise<void> {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  const existing = new Set(rows.map((r: any) => r.table_name));
  const missing = REQUIRED_TABLES.filter(t => !existing.has(t));

  if (missing.length > 0) {
    logger.error(MOD, `❌ Missing tables after init: ${missing.join(', ')}`, { missing, total: REQUIRED_TABLES.length, found: existing.size });
  } else {
    logger.info(MOD, `✅ All ${REQUIRED_TABLES.length} required tables verified`, { total: REQUIRED_TABLES.length });
  }
}

/**
 * Health check: returns the status of every required table.
 * Used by GET /api/health/database
 */
export async function getDatabaseHealth(): Promise<{
  healthy: boolean;
  tables: { name: string; exists: boolean; rowCount?: number }[];
  totalRequired: number;
  totalFound: number;
  missingTables: string[];
}> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const existing = new Set(rows.map((r: any) => r.table_name));
    const missing = REQUIRED_TABLES.filter(t => !existing.has(t));

    const tables = REQUIRED_TABLES.map(name => ({
      name,
      exists: existing.has(name),
    }));

    return {
      healthy: missing.length === 0,
      tables,
      totalRequired: REQUIRED_TABLES.length,
      totalFound: REQUIRED_TABLES.filter(t => existing.has(t)).length,
      missingTables: missing,
    };
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info(MOD, 'PostgreSQL pool closed');
  }
}

/**
 * Execute a single SQL statement with error isolation.
 * Logs success/failure for each statement — never lets one failure kill the rest.
 */
async function safeExec(client: PoolClient, label: string, sql: string): Promise<boolean> {
  try {
    await client.query(sql);
    return true;
  } catch (err: any) {
    console.error(`❌ [DB] Failed: ${label} — ${err?.code}: ${err?.message}`);
    logger.error(MOD, `Schema statement failed: ${label}`, {
      code: err?.code, message: err?.message, detail: err?.detail, hint: err?.hint,
    });
    return false;
  }
}

async function initSchema(client: PoolClient): Promise<void> {
  let ok = 0;
  let fail = 0;
  const run = async (label: string, sql: string) => {
    (await safeExec(client, label, sql)) ? ok++ : fail++;
  };

  // ─── Phase 1: Core tables (no foreign-key dependencies) ─────────
  console.log('🔧 [DB] Phase 1: Core tables...');

  await run('test_executions', `CREATE TABLE IF NOT EXISTS test_executions (
    id SERIAL PRIMARY KEY,
    test_name TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    screenshot_path TEXT,
    github_commit_sha TEXT,
    duration_ms INTEGER DEFAULT 0,
    healing_attempted BOOLEAN DEFAULT FALSE,
    healing_succeeded BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('healing_actions', `CREATE TABLE IF NOT EXISTS healing_actions (
    id SERIAL PRIMARY KEY,
    test_execution_id INTEGER NOT NULL REFERENCES test_executions(id),
    test_name TEXT NOT NULL,
    failed_locator TEXT NOT NULL,
    healed_locator TEXT,
    healing_strategy TEXT NOT NULL,
    ai_tokens_used INTEGER DEFAULT 0,
    success BOOLEAN DEFAULT FALSE,
    confidence REAL DEFAULT 0,
    error_context TEXT,
    validation_status TEXT,
    validation_reason TEXT,
    patch_path TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('learned_patterns', `CREATE TABLE IF NOT EXISTS learned_patterns (
    id SERIAL PRIMARY KEY,
    test_name TEXT NOT NULL,
    error_pattern TEXT NOT NULL,
    failed_locator TEXT NOT NULL,
    healed_locator TEXT NOT NULL,
    solution_strategy TEXT NOT NULL,
    confidence REAL DEFAULT 0,
    success_count INTEGER DEFAULT 1,
    failure_count INTEGER DEFAULT 0,
    usage_count INTEGER DEFAULT 0,
    avg_tokens_saved INTEGER DEFAULT 0,
    last_used TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(test_name, error_pattern, failed_locator)
  )`);

  await run('healing_jobs', `CREATE TABLE IF NOT EXISTS healing_jobs (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    repository_url TEXT,
    branch TEXT DEFAULT 'main',
    commit_sha TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    progress TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    result TEXT,
    error TEXT
  )`);

  await run('token_usage', `CREATE TABLE IF NOT EXISTS token_usage (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    engine TEXT NOT NULL,
    tokens_used INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('rca_analyses', `CREATE TABLE IF NOT EXISTS rca_analyses (
    id SERIAL PRIMARY KEY,
    test_execution_id INTEGER REFERENCES test_executions(id),
    job_id TEXT,
    test_name TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    classification TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    confidence REAL DEFAULT 0,
    suggested_fix TEXT,
    affected_component TEXT,
    is_flaky BOOLEAN DEFAULT FALSE,
    flaky_reason TEXT,
    summary TEXT,
    technical_details TEXT,
    tokens_used INTEGER DEFAULT 0,
    model TEXT DEFAULT 'gpt-4o-mini',
    analysis_time_ms INTEGER DEFAULT 0,
    healing_attempted BOOLEAN DEFAULT FALSE,
    healing_succeeded BOOLEAN DEFAULT FALSE,
    healed_locator TEXT,
    healing_strategy TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('pr_automations', `CREATE TABLE IF NOT EXISTS pr_automations (
    id SERIAL PRIMARY KEY,
    job_id TEXT NOT NULL,
    pr_url TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    branch_name TEXT NOT NULL,
    commit_sha TEXT,
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    files_changed TEXT[],
    healing_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'open',
    merged_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ─── Phase 2: Project contexts & script gen (critical for the 42P01 bug) ───
  console.log('🔧 [DB] Phase 2: Project contexts & script gen...');

  await run('project_contexts', `CREATE TABLE IF NOT EXISTS project_contexts (
    id SERIAL PRIMARY KEY,
    company_id INTEGER,
    name VARCHAR(500) NOT NULL,
    app_url TEXT NOT NULL,
    framework TEXT,
    auth_method TEXT,
    selector_strategy TEXT,
    app_description TEXT,
    navigation_flow TEXT,
    custom_rules TEXT,
    credentials TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('generated_scripts', `CREATE TABLE IF NOT EXISTS generated_scripts (
    id SERIAL PRIMARY KEY,
    company_id INTEGER,
    project_context_id INTEGER REFERENCES project_contexts(id) ON DELETE SET NULL,
    url TEXT NOT NULL,
    page_type TEXT,
    workflow_graph JSONB,
    instructions TEXT,
    script_content TEXT,
    test_plan JSONB,
    validation_status TEXT DEFAULT 'pending',
    reliability_score REAL DEFAULT 0,
    review_score REAL,
    review_issues JSONB,
    tokens_used INTEGER DEFAULT 0,
    model TEXT,
    generation_time_ms INTEGER,
    files_generated JSONB,
    negative_tests_included BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('dom_snapshots', `CREATE TABLE IF NOT EXISTS dom_snapshots (
    id SERIAL PRIMARY KEY,
    script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
    page_url TEXT NOT NULL,
    html_snapshot TEXT,
    elements_count INTEGER DEFAULT 0,
    page_type TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('selector_scores', `CREATE TABLE IF NOT EXISTS selector_scores (
    id SERIAL PRIMARY KEY,
    script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
    selector TEXT NOT NULL,
    score REAL DEFAULT 0,
    strategy TEXT,
    element_type TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('workflow_maps', `CREATE TABLE IF NOT EXISTS workflow_maps (
    id SERIAL PRIMARY KEY,
    script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
    source_page TEXT,
    target_page TEXT,
    action TEXT,
    link_text TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('generated_projects', `CREATE TABLE IF NOT EXISTS generated_projects (
    id SERIAL PRIMARY KEY,
    script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
    project_dir TEXT,
    file_count INTEGER DEFAULT 0,
    total_size INTEGER DEFAULT 0,
    structure JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ─── Phase 3: Auth, notifications, multi-tenant ─────────────────
  console.log('🔧 [DB] Phase 3: Auth & multi-tenant...');

  await run('users', `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(50) DEFAULT 'client',
    company_name VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('audit_logs', `CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    username VARCHAR(100),
    action TEXT NOT NULL,
    resource TEXT,
    resource_id TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('sessions', `CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('notification_configs', `CREATE TABLE IF NOT EXISTS notification_configs (
    id SERIAL PRIMARY KEY,
    tool_type TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    status TEXT DEFAULT 'connected',
    config JSONB DEFAULT '{}',
    connected_at TIMESTAMPTZ,
    last_tested_at TIMESTAMPTZ,
    last_test_result TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('notification_logs', `CREATE TABLE IF NOT EXISTS notification_logs (
    id SERIAL PRIMARY KEY,
    tool_type TEXT NOT NULL,
    event_type TEXT NOT NULL,
    channel TEXT,
    message_preview TEXT,
    status TEXT DEFAULT 'sent',
    error TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('companies', `CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    slug VARCHAR(100) NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ─── Phase 4: Add company_id columns to existing tables ─────────
  console.log('🔧 [DB] Phase 4: Company ID migrations...');

  await run('company_id_alters', `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='test_executions' AND column_name='company_id') THEN
      ALTER TABLE test_executions ADD COLUMN company_id INTEGER REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='healing_actions' AND column_name='company_id') THEN
      ALTER TABLE healing_actions ADD COLUMN company_id INTEGER REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='learned_patterns' AND column_name='company_id') THEN
      ALTER TABLE learned_patterns ADD COLUMN company_id INTEGER REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='healing_jobs' AND column_name='company_id') THEN
      ALTER TABLE healing_jobs ADD COLUMN company_id INTEGER REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='token_usage' AND column_name='company_id') THEN
      ALTER TABLE token_usage ADD COLUMN company_id INTEGER REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='rca_analyses' AND column_name='company_id') THEN
      ALTER TABLE rca_analyses ADD COLUMN company_id INTEGER REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pr_automations' AND column_name='company_id') THEN
      ALTER TABLE pr_automations ADD COLUMN company_id INTEGER REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='generated_scripts' AND column_name='company_id') THEN
      ALTER TABLE generated_scripts ADD COLUMN company_id INTEGER REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notification_configs' AND column_name='company_id') THEN
      ALTER TABLE notification_configs ADD COLUMN company_id INTEGER REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notification_logs' AND column_name='company_id') THEN
      ALTER TABLE notification_logs ADD COLUMN company_id INTEGER REFERENCES companies(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='company_id') THEN
      ALTER TABLE users ADD COLUMN company_id INTEGER REFERENCES companies(id);
    END IF;
  END $$`);

  // ─── Phase 5: Indexes ───────────────────────────────────────────
  console.log('🔧 [DB] Phase 5: Indexes...');

  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_exec_status ON test_executions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_exec_test_name ON test_executions(test_name)`,
    `CREATE INDEX IF NOT EXISTS idx_heal_exec_id ON healing_actions(test_execution_id)`,
    `CREATE INDEX IF NOT EXISTS idx_heal_strategy ON healing_actions(healing_strategy)`,
    `CREATE INDEX IF NOT EXISTS idx_pattern_locator ON learned_patterns(failed_locator)`,
    `CREATE INDEX IF NOT EXISTS idx_pattern_test_name ON learned_patterns(test_name)`,
    `CREATE INDEX IF NOT EXISTS idx_pattern_error ON learned_patterns(error_pattern)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_status ON healing_jobs(status)`,
    `CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(date)`,
    `CREATE INDEX IF NOT EXISTS idx_rca_test_name ON rca_analyses(test_name)`,
    `CREATE INDEX IF NOT EXISTS idx_rca_classification ON rca_analyses(classification)`,
    `CREATE INDEX IF NOT EXISTS idx_rca_job_id ON rca_analyses(job_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rca_exec_id ON rca_analyses(test_execution_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pr_job_id ON pr_automations(job_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pr_status ON pr_automations(status)`,
    `CREATE INDEX IF NOT EXISTS idx_pc_company ON project_contexts(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pc_active ON project_contexts(is_active) WHERE is_active = true`,
    `CREATE INDEX IF NOT EXISTS idx_gs_url ON generated_scripts(url)`,
    `CREATE INDEX IF NOT EXISTS idx_gs_created ON generated_scripts(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_gs_company ON generated_scripts(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_gs_project_ctx ON generated_scripts(project_context_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dom_script ON dom_snapshots(script_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sel_script ON selector_scores(script_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wf_script ON workflow_maps(script_id)`,
    `CREATE INDEX IF NOT EXISTS idx_gp_script ON generated_projects(script_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
    `CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_notif_tool ON notification_configs(tool_type)`,
    `CREATE INDEX IF NOT EXISTS idx_notif_log_type ON notification_logs(tool_type)`,
    `CREATE INDEX IF NOT EXISTS idx_notif_log_created ON notification_logs(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_exec_company ON test_executions(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_heal_company ON healing_actions(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pattern_company ON learned_patterns(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_company ON healing_jobs(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_token_company ON token_usage(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rca_company ON rca_analyses(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pr_company ON pr_automations(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_notif_config_company ON notification_configs(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_notif_log_company ON notification_logs(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id)`,
  ];
  for (const idx of indexes) {
    await safeExec(client, idx.match(/idx_\w+/)?.[0] || 'index', idx);
  }

  // ─── Phase 6: API keys, ingestion, billing, roles ───────────────
  console.log('🔧 [DB] Phase 6: API keys, billing, roles...');

  await run('api_keys', `CREATE TABLE IF NOT EXISTS api_keys (
    id            SERIAL PRIMARY KEY,
    company_id    INTEGER NOT NULL REFERENCES companies(id),
    name          VARCHAR(255) NOT NULL,
    prefix        VARCHAR(20) NOT NULL,
    key_hash      VARCHAR(64) NOT NULL UNIQUE,
    scopes        JSONB DEFAULT '["ingest:write"]',
    rate_limit    INTEGER DEFAULT 1000,
    is_active     BOOLEAN DEFAULT TRUE,
    last_used_at  TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('ingestion_logs', `CREATE TABLE IF NOT EXISTS ingestion_logs (
    id            SERIAL PRIMARY KEY,
    company_id    INTEGER NOT NULL REFERENCES companies(id),
    provider      VARCHAR(50) NOT NULL,
    build_id      VARCHAR(255),
    repo_url      TEXT,
    branch        VARCHAR(255),
    commit_sha    VARCHAR(64),
    total_tests   INTEGER DEFAULT 0,
    passed_tests  INTEGER DEFAULT 0,
    failed_tests  INTEGER DEFAULT 0,
    skipped_tests INTEGER DEFAULT 0,
    status        VARCHAR(20) DEFAULT 'received',
    healing_job_id VARCHAR(255),
    error_message TEXT,
    metadata      JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    completed_at  TIMESTAMPTZ
  )`);

  await run('plans', `CREATE TABLE IF NOT EXISTS plans (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    slug          VARCHAR(50) UNIQUE NOT NULL,
    price_usd_monthly    NUMERIC(10,2) DEFAULT 0,
    price_usd_annually   NUMERIC(10,2) DEFAULT 0,
    price_inr_monthly    NUMERIC(10,2) DEFAULT 0,
    price_inr_annually   NUMERIC(10,2) DEFAULT 0,
    credits_monthly      INTEGER NOT NULL DEFAULT 0,
    max_users            INTEGER NOT NULL DEFAULT 1,
    max_repos            INTEGER NOT NULL DEFAULT 1,
    max_jobs_per_month   INTEGER NOT NULL DEFAULT 25,
    retention_days       INTEGER NOT NULL DEFAULT 7,
    features             JSONB DEFAULT '{}',
    is_active            BOOLEAN DEFAULT TRUE,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('subscriptions', `CREATE TABLE IF NOT EXISTS subscriptions (
    id                     SERIAL PRIMARY KEY,
    company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    plan_id                INTEGER NOT NULL REFERENCES plans(id),
    status                 VARCHAR(20) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','trialing','past_due','cancelled','expired')),
    billing_cycle          VARCHAR(10) NOT NULL DEFAULT 'monthly'
                           CHECK (billing_cycle IN ('monthly','annually')),
    currency               VARCHAR(3) NOT NULL DEFAULT 'USD',
    current_period_start   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_period_end     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    cancelled_at           TIMESTAMPTZ,
    payment_gateway        VARCHAR(20) DEFAULT 'stripe',
    gateway_subscription_id VARCHAR(255),
    gateway_customer_id    VARCHAR(255),
    created_at             TIMESTAMPTZ DEFAULT NOW(),
    updated_at             TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('subscription_usage', `CREATE TABLE IF NOT EXISTS subscription_usage (
    id              SERIAL PRIMARY KEY,
    subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
    company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    operation       VARCHAR(50) NOT NULL,
    credits_used    INTEGER NOT NULL DEFAULT 0,
    metadata        JSONB DEFAULT '{}',
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('billing_events', `CREATE TABLE IF NOT EXISTS billing_events (
    id                  SERIAL PRIMARY KEY,
    company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    subscription_id     INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
    event_type          VARCHAR(50) NOT NULL,
    amount              NUMERIC(10,2) DEFAULT 0,
    currency            VARCHAR(3) DEFAULT 'USD',
    gateway             VARCHAR(20),
    gateway_event_id    VARCHAR(255),
    invoice_number      VARCHAR(50),
    status              VARCHAR(20) DEFAULT 'completed',
    description         TEXT,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('payment_methods', `CREATE TABLE IF NOT EXISTS payment_methods (
    id              SERIAL PRIMARY KEY,
    company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    type            VARCHAR(20) NOT NULL DEFAULT 'card',
    last_four       VARCHAR(4),
    brand           VARCHAR(20),
    exp_month       INTEGER,
    exp_year        INTEGER,
    is_default      BOOLEAN DEFAULT FALSE,
    gateway         VARCHAR(20) DEFAULT 'stripe',
    gateway_pm_id   VARCHAR(255),
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Billing indexes
  const billingIndexes = [
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_company ON subscriptions(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_usage_company ON subscription_usage(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_usage_period ON subscription_usage(period_start, period_end)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_usage_operation ON subscription_usage(operation)`,
    `CREATE INDEX IF NOT EXISTS idx_billing_events_company ON billing_events(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_billing_events_type ON billing_events(event_type)`,
    `CREATE INDEX IF NOT EXISTS idx_payment_methods_company ON payment_methods(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_company ON api_keys(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ingest_company ON ingestion_logs(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ingest_status ON ingestion_logs(status)`,
    `CREATE INDEX IF NOT EXISTS idx_ingest_created ON ingestion_logs(created_at DESC)`,
  ];
  for (const idx of billingIndexes) {
    await safeExec(client, idx.match(/idx_\w+/)?.[0] || 'billing_index', idx);
  }

  await run('roles', `CREATE TABLE IF NOT EXISTS roles (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(50) NOT NULL,
    slug          VARCHAR(50) UNIQUE NOT NULL,
    description   TEXT,
    permissions   JSONB DEFAULT '{}',
    is_system     BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ─── Phase 7: Repository Intelligence Engine ────────────────────
  console.log('🔧 [DB] Phase 7: Repository Intelligence...');

  await run('repository_contexts', `CREATE TABLE IF NOT EXISTS repository_contexts (
    id              SERIAL PRIMARY KEY,
    repo_id         VARCHAR(500) NOT NULL,
    company_id      INTEGER REFERENCES companies(id),
    profile         JSONB NOT NULL DEFAULT '{}',
    scan_duration_ms INTEGER DEFAULT 0,
    profile_version  INTEGER DEFAULT 1,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_repo_ctx_repo_company',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_ctx_repo_company ON repository_contexts(repo_id, COALESCE(company_id, 0))`);
  await safeExec(client, 'idx_repo_ctx_company',
    `CREATE INDEX IF NOT EXISTS idx_repo_ctx_company ON repository_contexts(company_id)`);

  await run('code_chunks', `CREATE TABLE IF NOT EXISTS code_chunks (
    id              SERIAL PRIMARY KEY,
    repo_context_id INTEGER REFERENCES repository_contexts(id) ON DELETE CASCADE,
    file_path       VARCHAR(1000) NOT NULL,
    chunk_type      VARCHAR(50) NOT NULL,
    chunk_name      VARCHAR(500) NOT NULL,
    content         TEXT NOT NULL,
    line_start      INTEGER,
    line_end        INTEGER,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_code_chunks_repo',
    `CREATE INDEX IF NOT EXISTS idx_code_chunks_repo ON code_chunks(repo_context_id)`);
  await safeExec(client, 'idx_code_chunks_type',
    `CREATE INDEX IF NOT EXISTS idx_code_chunks_type ON code_chunks(chunk_type)`);

  // ─── Phase 8: Projects & DB-based Repositories ───────────────────
  console.log('🔧 [DB] Phase 8: Projects & Repositories...');

  await run('projects', `CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_projects_company',
    `CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id)`);
  await safeExec(client, 'uq_project_name_company',
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_project_name_company ON projects(company_id, name)`);

  await run('repositories', `CREATE TABLE IF NOT EXISTS repositories (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    branch VARCHAR(255) DEFAULT 'main',
    type VARCHAR(50) DEFAULT 'web',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_repos_project',
    `CREATE INDEX IF NOT EXISTS idx_repos_project ON repositories(project_id)`);
  await safeExec(client, 'idx_repos_company',
    `CREATE INDEX IF NOT EXISTS idx_repos_company ON repositories(company_id)`);

  // ─── Phase 9: Webhook Configs & Events (Autonomous CI Healing) ───
  console.log('🔧 [DB] Phase 9: Webhooks...');

  await run('webhook_configs', `CREATE TABLE IF NOT EXISTS webhook_configs (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE SET NULL,
    webhook_secret VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    events_received INTEGER DEFAULT 0,
    last_event_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_wh_project',
    `CREATE INDEX IF NOT EXISTS idx_wh_project ON webhook_configs(project_id)`);
  await safeExec(client, 'uq_wh_project_repo',
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_project_repo ON webhook_configs(project_id, COALESCE(repository_id, 0))`);

  await run('webhook_events', `CREATE TABLE IF NOT EXISTS webhook_events (
    id SERIAL PRIMARY KEY,
    webhook_config_id INTEGER REFERENCES webhook_configs(id) ON DELETE SET NULL,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    action VARCHAR(100),
    repo_url TEXT,
    branch VARCHAR(255),
    commit_sha VARCHAR(64),
    workflow_name VARCHAR(255),
    workflow_conclusion VARCHAR(50),
    test_failures JSONB,
    healing_job_id VARCHAR(100),
    payload_summary JSONB,
    status VARCHAR(50) DEFAULT 'received',
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_whe_company',
    `CREATE INDEX IF NOT EXISTS idx_whe_company ON webhook_events(company_id)`);
  await safeExec(client, 'idx_whe_status',
    `CREATE INDEX IF NOT EXISTS idx_whe_status ON webhook_events(status)`);

  // ─── Phase 10: Release Cycle Architecture ───
  console.log('🔧 [DB] Phase 10: Release Cycles...');

  await run('release_windows', `CREATE TABLE IF NOT EXISTS release_windows (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    status VARCHAR(50) DEFAULT 'planned',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_rw_project',
    `CREATE INDEX IF NOT EXISTS idx_rw_project ON release_windows(project_id)`);
  await safeExec(client, 'idx_rw_status',
    `CREATE INDEX IF NOT EXISTS idx_rw_status ON release_windows(status)`);

  console.log(`🔧 [DB] Table creation complete: ${ok} succeeded, ${fail} failed`);

  // Seed default plans & roles
  // ─── Phase 9: Selector History (DOM Memory ↔ Healing integration) ───
  console.log('🔧 [DB] Phase 9: Selector History tracking...');
  await run('selector_history', `CREATE TABLE IF NOT EXISTS selector_history (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    company_id INTEGER REFERENCES companies(id),
    page_url TEXT,
    selector TEXT NOT NULL,
    previous_selector TEXT,
    element_type TEXT,
    element_identifier TEXT,
    change_type TEXT DEFAULT 'observed',
    source TEXT DEFAULT 'scan',
    stability_score REAL DEFAULT 1.0,
    metadata JSONB DEFAULT '{}',
    captured_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Indexes for fast lookups during healing
  for (const idx of [
    `CREATE INDEX IF NOT EXISTS idx_sel_hist_selector ON selector_history(selector)`,
    `CREATE INDEX IF NOT EXISTS idx_sel_hist_project ON selector_history(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sel_hist_element ON selector_history(element_identifier)`,
    `CREATE INDEX IF NOT EXISTS idx_sel_hist_captured ON selector_history(captured_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sel_hist_proj_sel ON selector_history(project_id, selector)`,
  ]) {
    await safeExec(client, idx.match(/idx_\w+/)![0], idx);
  }

  // ─── Phase 11: Application Intelligence ───────────────────────
  console.log('🔧 [DB] Phase 11: Application Intelligence...');

  await safeExec(client, 'application_profiles', `CREATE TABLE IF NOT EXISTS application_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base_url VARCHAR(500) NOT NULL,
    app_fingerprint VARCHAR(100),
    crawl_data JSONB NOT NULL DEFAULT '{}',
    auth_required BOOLEAN DEFAULT false,
    auth_config JSONB,
    crawled_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
    page_count INTEGER DEFAULT 0,
    total_elements INTEGER DEFAULT 0,
    total_forms INTEGER DEFAULT 0,
    total_interactive INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'fresh' CHECK (status IN ('fresh','expiring','expired','crawling','error')),
    error_message TEXT,
    company_id INTEGER REFERENCES companies(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(base_url, COALESCE(company_id, 0))
  )`);
  await safeExec(client, 'idx_app_profiles_base_url',
    `CREATE INDEX IF NOT EXISTS idx_app_profiles_base_url ON application_profiles(base_url)`);
  await safeExec(client, 'idx_app_profiles_company',
    `CREATE INDEX IF NOT EXISTS idx_app_profiles_company ON application_profiles(company_id)`);
  await safeExec(client, 'idx_app_profiles_status',
    `CREATE INDEX IF NOT EXISTS idx_app_profiles_status ON application_profiles(status)`);
  await safeExec(client, 'idx_app_profiles_expires',
    `CREATE INDEX IF NOT EXISTS idx_app_profiles_expires ON application_profiles(expires_at)`);

  await safeExec(client, 'page_snapshots', `CREATE TABLE IF NOT EXISTS page_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID REFERENCES application_profiles(id) ON DELETE CASCADE,
    page_url VARCHAR(500) NOT NULL,
    page_title VARCHAR(500),
    page_type VARCHAR(50),
    dom_structure JSONB DEFAULT '{}',
    selectors JSONB DEFAULT '{}',
    elements_count INTEGER DEFAULT 0,
    forms_count INTEGER DEFAULT 0,
    interactive_count INTEGER DEFAULT 0,
    screenshot_key VARCHAR(500),
    crawled_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_page_snapshots_profile',
    `CREATE INDEX IF NOT EXISTS idx_page_snapshots_profile ON page_snapshots(profile_id)`);
  await safeExec(client, 'idx_page_snapshots_url',
    `CREATE INDEX IF NOT EXISTS idx_page_snapshots_url ON page_snapshots(page_url)`);

  await safeExec(client, 'selector_patterns', `CREATE TABLE IF NOT EXISTS selector_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern_type VARCHAR(50) NOT NULL CHECK (pattern_type IN (
      'login_form','navigation','data_table','search_form','modal_dialog',
      'dropdown_menu','pagination','file_upload','date_picker','accordion',
      'tabs','toast_notification','card_layout','sidebar','breadcrumb'
    )),
    pattern_name VARCHAR(200),
    selectors JSONB NOT NULL DEFAULT '[]',
    element_signatures JSONB DEFAULT '{}',
    confidence_score FLOAT DEFAULT 0.5,
    usage_count INTEGER DEFAULT 0,
    success_rate FLOAT DEFAULT 0.0,
    last_used_at TIMESTAMPTZ,
    company_id INTEGER REFERENCES companies(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_selector_patterns_type',
    `CREATE INDEX IF NOT EXISTS idx_selector_patterns_type ON selector_patterns(pattern_type)`);
  await safeExec(client, 'idx_selector_patterns_company',
    `CREATE INDEX IF NOT EXISTS idx_selector_patterns_company ON selector_patterns(company_id)`);
  await safeExec(client, 'idx_selector_patterns_confidence',
    `CREATE INDEX IF NOT EXISTS idx_selector_patterns_confidence ON selector_patterns(confidence_score DESC)`);

  // ─── Phase 12: Multi-Project Isolation ──────────────────────────
  console.log('🔧 [DB] Phase 12: Multi-Project Isolation...');

  // Add project_id to intelligence tables
  await safeExec(client, 'phase12_project_id_alters', `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='application_profiles' AND column_name='project_id') THEN
      ALTER TABLE application_profiles ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='page_snapshots' AND column_name='project_id') THEN
      ALTER TABLE page_snapshots ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='selector_patterns' AND column_name='project_id') THEN
      ALTER TABLE selector_patterns ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='selector_patterns' AND column_name='is_shared') THEN
      ALTER TABLE selector_patterns ADD COLUMN is_shared BOOLEAN DEFAULT false;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='application_profiles' AND column_name='settings') THEN
      ALTER TABLE application_profiles ADD COLUMN settings JSONB DEFAULT '{}';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='knowledge_items' AND column_name='project_id') THEN
      ALTER TABLE knowledge_items ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='knowledge_relationships' AND column_name='project_id') THEN
      ALTER TABLE knowledge_relationships ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
  END $$`);

  await safeExec(client, 'idx_app_profiles_project',
    `CREATE INDEX IF NOT EXISTS idx_app_profiles_project ON application_profiles(project_id)`);
  await safeExec(client, 'idx_page_snapshots_project',
    `CREATE INDEX IF NOT EXISTS idx_page_snapshots_project ON page_snapshots(project_id)`);
  await safeExec(client, 'idx_selector_patterns_project',
    `CREATE INDEX IF NOT EXISTS idx_selector_patterns_project ON selector_patterns(project_id)`);
  await safeExec(client, 'idx_selector_patterns_shared',
    `CREATE INDEX IF NOT EXISTS idx_selector_patterns_shared ON selector_patterns(is_shared) WHERE is_shared = true`);
  await safeExec(client, 'idx_ki_project',
    `CREATE INDEX IF NOT EXISTS idx_ki_project ON knowledge_items(project_id)`);
  await safeExec(client, 'idx_kr_project',
    `CREATE INDEX IF NOT EXISTS idx_kr_project ON knowledge_relationships(project_id)`);

  // Composite unique: one profile per URL per project (or per company if no project)
  await safeExec(client, 'uq_app_profile_url_project',
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_app_profile_url_project ON application_profiles(base_url, COALESCE(project_id, 0), COALESCE(company_id, 0))`);

  console.log('🔧 [DB] Seeding plans & roles...');
  await seedDefaultPlans(client);
  await seedDefaultRoles(client);

  // Ensure default company exists and backfill orphaned data
  console.log('🔧 [DB] Running migrations...');
  await migrateDefaultCompany(client);

  console.log(`✅ [DB] initSchema complete (${ok} ok, ${fail} errors)`);
}

/* -------------------------------------------------------------------------- */
/*  Multi-tenant Migration Helper                                             */
/* -------------------------------------------------------------------------- */

async function migrateDefaultCompany(client: PoolClient): Promise<void> {
  // Ensure "Default" company exists
  const { rows } = await client.query(
    `INSERT INTO companies (name, slug) VALUES ('Default', 'default')
     ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
     RETURNING id`
  );
  const defaultId = rows[0].id;
  console.log(`🔧 [DB] Default company ID: ${defaultId}`);

  // Backfill any rows without company_id (each individually, non-fatal)
  const tables = [
    'test_executions', 'healing_actions', 'learned_patterns',
    'healing_jobs', 'token_usage', 'rca_analyses', 'pr_automations',
    'generated_scripts', 'notification_configs', 'notification_logs', 'users',
  ];
  for (const t of tables) {
    await safeExec(client, `backfill_${t}`,
      `UPDATE ${t} SET company_id = ${defaultId} WHERE company_id IS NULL`);
  }

  // Migrate notification_configs unique constraint
  await safeExec(client, 'notif_constraint_migration', `
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'notification_configs_tool_type_key'
          AND conrelid = 'notification_configs'::regclass
      ) THEN
        ALTER TABLE notification_configs DROP CONSTRAINT notification_configs_tool_type_key;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_tool_company
          ON notification_configs (tool_type, COALESCE(company_id, 0));
      END IF;
    END $$`);

  // ── Add project_id to existing tables ──
  console.log('🔧 [DB] Migration: Adding project_id columns...');
  await safeExec(client, 'project_id_alters', `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='project_contexts' AND column_name='project_id') THEN
      ALTER TABLE project_contexts ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='generated_scripts' AND column_name='project_id') THEN
      ALTER TABLE generated_scripts ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='test_executions' AND column_name='project_id') THEN
      ALTER TABLE test_executions ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='healing_actions' AND column_name='project_id') THEN
      ALTER TABLE healing_actions ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='healing_jobs' AND column_name='project_id') THEN
      ALTER TABLE healing_jobs ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='rca_analyses' AND column_name='project_id') THEN
      ALTER TABLE rca_analyses ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='test_requirements' AND column_name='project_id') THEN
      ALTER TABLE test_requirements ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='repository_contexts' AND column_name='project_id') THEN
      ALTER TABLE repository_contexts ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
  END $$`);
  const projectIdIndexes = [
    `CREATE INDEX IF NOT EXISTS idx_pc_project ON project_contexts(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_gs_project ON generated_scripts(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_exec_project ON test_executions(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_heal_project ON healing_actions(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_project ON healing_jobs(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rca_project ON rca_analyses(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_test_req_project ON test_requirements(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_repo_ctx_project ON repository_contexts(project_id)`,
  ];
  for (const idx of projectIdIndexes) {
    await safeExec(client, idx.match(/idx_\w+/)?.[0] || 'project_index', idx);
  }

  // ── Add release cycle + repo role columns ──
  console.log('🔧 [DB] Migration: Adding release cycle columns...');
  await safeExec(client, 'release_cycle_alters', `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='release_cycle_type') THEN
      ALTER TABLE projects ADD COLUMN release_cycle_type VARCHAR(50) DEFAULT 'continuous';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='release_cycle_days') THEN
      ALTER TABLE projects ADD COLUMN release_cycle_days INTEGER DEFAULT 14;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='release_day_of_week') THEN
      ALTER TABLE projects ADD COLUMN release_day_of_week INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='release_timezone') THEN
      ALTER TABLE projects ADD COLUMN release_timezone VARCHAR(50) DEFAULT 'UTC';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='overview_default_range') THEN
      ALTER TABLE projects ADD COLUMN overview_default_range VARCHAR(20) DEFAULT '7d';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='repositories' AND column_name='role') THEN
      ALTER TABLE repositories ADD COLUMN role VARCHAR(50) DEFAULT 'primary';
    END IF;
  END $$`);

  // Seed default project for existing data
  await safeExec(client, 'seed_default_project', `
    INSERT INTO projects (company_id, name, description)
    SELECT id, 'Default Project', 'Auto-created default project'
    FROM companies
    WHERE NOT EXISTS (SELECT 1 FROM projects WHERE company_id = companies.id AND name = 'Default Project')
  `);

  // ── Test Coverage Intelligence tables (individual, resilient) ──
  console.log('🔧 [DB] Migration: Test Coverage tables...');

  await safeExec(client, 'test_requirements', `CREATE TABLE IF NOT EXISTS test_requirements (
    id SERIAL PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    description TEXT NOT NULL,
    jira_id VARCHAR(100),
    business_flow TEXT,
    acceptance_criteria TEXT,
    api_docs TEXT,
    release_notes TEXT,
    module VARCHAR(200),
    feature_type VARCHAR(100),
    risk_level VARCHAR(20) DEFAULT 'medium',
    analysis JSONB,
    company_id INTEGER REFERENCES companies(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_test_requirements_company',
    `CREATE INDEX IF NOT EXISTS idx_test_requirements_company ON test_requirements(company_id)`);

  await safeExec(client, 'generated_test_scenarios', `CREATE TABLE IF NOT EXISTS generated_test_scenarios (
    id SERIAL PRIMARY KEY,
    requirement_id INTEGER NOT NULL REFERENCES test_requirements(id) ON DELETE CASCADE,
    scenario TEXT NOT NULL,
    coverage_type VARCHAR(50) NOT NULL,
    priority VARCHAR(10) DEFAULT 'P1',
    risk_area VARCHAR(200),
    company_id INTEGER REFERENCES companies(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_gen_scenarios_req',
    `CREATE INDEX IF NOT EXISTS idx_gen_scenarios_req ON generated_test_scenarios(requirement_id)`);

  await safeExec(client, 'generated_test_cases', `CREATE TABLE IF NOT EXISTS generated_test_cases (
    id SERIAL PRIMARY KEY,
    scenario_id INTEGER NOT NULL REFERENCES generated_test_scenarios(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    preconditions TEXT,
    steps JSONB NOT NULL DEFAULT '[]',
    expected_result TEXT NOT NULL,
    test_data TEXT,
    priority VARCHAR(10) DEFAULT 'P1',
    severity VARCHAR(20) DEFAULT 'major',
    tags JSONB DEFAULT '[]',
    automation_ready BOOLEAN DEFAULT false,
    automation_complexity VARCHAR(20) DEFAULT 'medium',
    selector_availability VARCHAR(20) DEFAULT 'unknown',
    company_id INTEGER REFERENCES companies(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_gen_cases_scenario',
    `CREATE INDEX IF NOT EXISTS idx_gen_cases_scenario ON generated_test_cases(scenario_id)`);

  await safeExec(client, 'application_knowledge', `CREATE TABLE IF NOT EXISTS application_knowledge (
    id SERIAL PRIMARY KEY,
    module VARCHAR(200) NOT NULL,
    workflow TEXT,
    business_rules TEXT,
    dependencies TEXT,
    apis TEXT,
    historical_bugs TEXT,
    company_id INTEGER REFERENCES companies(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_app_knowledge_company',
    `CREATE INDEX IF NOT EXISTS idx_app_knowledge_company ON application_knowledge(company_id)`);
  await safeExec(client, 'idx_app_knowledge_module',
    `CREATE INDEX IF NOT EXISTS idx_app_knowledge_module ON application_knowledge(module)`);

  // ── Knowledge Management tables (individual, resilient) ──
  console.log('🔧 [DB] Migration: Knowledge Management tables...');

  await safeExec(client, 'knowledge_items', `CREATE TABLE IF NOT EXISTS knowledge_items (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id),
    category VARCHAR(50) NOT NULL CHECK (category IN (
      'business_rule','workflow','architecture','dependency','integration',
      'automation','manual_test','bug_pattern','domain'
    )),
    title VARCHAR(500) NOT NULL,
    description TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',
    related_modules TEXT[] DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
    priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
    created_by VARCHAR(200),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_ki_company', `CREATE INDEX IF NOT EXISTS idx_ki_company ON knowledge_items(company_id)`);
  await safeExec(client, 'idx_ki_category', `CREATE INDEX IF NOT EXISTS idx_ki_category ON knowledge_items(category)`);
  await safeExec(client, 'idx_ki_status', `CREATE INDEX IF NOT EXISTS idx_ki_status ON knowledge_items(status)`);
  await safeExec(client, 'idx_ki_tags', `CREATE INDEX IF NOT EXISTS idx_ki_tags ON knowledge_items USING GIN(tags)`);
  await safeExec(client, 'idx_ki_modules', `CREATE INDEX IF NOT EXISTS idx_ki_modules ON knowledge_items USING GIN(related_modules)`);
  await safeExec(client, 'idx_ki_search',
    `CREATE INDEX IF NOT EXISTS idx_ki_search ON knowledge_items USING GIN(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')))`);

  await safeExec(client, 'knowledge_relationships', `CREATE TABLE IF NOT EXISTS knowledge_relationships (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id),
    source_knowledge_id INTEGER NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    target_knowledge_id INTEGER NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    relationship_type VARCHAR(30) NOT NULL CHECK (relationship_type IN (
      'depends_on','related_to','implements','blocks','duplicates'
    )),
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(source_knowledge_id, target_knowledge_id, relationship_type)
  )`);
  await safeExec(client, 'idx_kr_source', `CREATE INDEX IF NOT EXISTS idx_kr_source ON knowledge_relationships(source_knowledge_id)`);
  await safeExec(client, 'idx_kr_target', `CREATE INDEX IF NOT EXISTS idx_kr_target ON knowledge_relationships(target_knowledge_id)`);
  await safeExec(client, 'idx_kr_company', `CREATE INDEX IF NOT EXISTS idx_kr_company ON knowledge_relationships(company_id)`);

  // ── AI Usage Logging ──
  console.log('🔧 [DB] Migration: AI Usage tables...');

  await safeExec(client, 'ai_usage_logs', `CREATE TABLE IF NOT EXISTS ai_usage_logs (
    id SERIAL PRIMARY KEY,
    model TEXT NOT NULL,
    tokens_used INTEGER NOT NULL,
    cost_usd DECIMAL(10, 6) NOT NULL,
    feature TEXT NOT NULL,
    task_type TEXT,
    user_id TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await safeExec(client, 'idx_ai_usage_date', `CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage_logs(DATE(created_at))`);
  await safeExec(client, 'idx_ai_usage_feature', `CREATE INDEX IF NOT EXISTS idx_ai_usage_feature ON ai_usage_logs(feature)`);
  await safeExec(client, 'idx_ai_usage_user', `CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage_logs(user_id)`);
  await safeExec(client, 'idx_ai_usage_model', `CREATE INDEX IF NOT EXISTS idx_ai_usage_model ON ai_usage_logs(model)`);

  // ── Column migrations for existing databases ──
  console.log('🔧 [DB] Migration: Column additions...');
  const migrations = [
    `ALTER TABLE generated_scripts ADD COLUMN IF NOT EXISTS company_id INTEGER`,
    `ALTER TABLE generated_scripts ADD COLUMN IF NOT EXISTS project_context_id INTEGER REFERENCES project_contexts(id) ON DELETE SET NULL`,
  ];
  for (const sql of migrations) {
    await safeExec(client, 'migration_alter', sql);
  }

  console.log('✅ [DB] migrateDefaultCompany complete');
}

/* -------------------------------------------------------------------------- */
/*  Billing – Seed Default Plans                                              */
/* -------------------------------------------------------------------------- */

async function seedDefaultPlans(client: PoolClient): Promise<void> {
  const plans = [
    {
      name: 'Free POC', slug: 'free',
      price_usd_monthly: 0, price_usd_annually: 0,
      price_inr_monthly: 0, price_inr_annually: 0,
      credits_monthly: 50, max_users: 1, max_repos: 1,
      max_jobs_per_month: 25, retention_days: 7,
      features: { healing_types: ['rule_based'], basic_reports: true, community_support: true },
    },
    {
      name: 'Starter', slug: 'starter',
      price_usd_monthly: 149, price_usd_annually: 1490,
      price_inr_monthly: 12499, price_inr_annually: 124990,
      credits_monthly: 500, max_users: 5, max_repos: 5,
      max_jobs_per_month: 200, retention_days: 30,
      features: { healing_types: ['rule_based', 'database_pattern', 'ai_reasoning'], rca: true, pr_automation: true, email_support: true },
    },
    {
      name: 'Growth', slug: 'growth',
      price_usd_monthly: 999, price_usd_annually: 9990,
      price_inr_monthly: 83499, price_inr_annually: 834990,
      credits_monthly: 5000, max_users: 25, max_repos: -1,
      max_jobs_per_month: -1, retention_days: 90,
      features: { healing_types: ['rule_based', 'database_pattern', 'ai_reasoning'], rca: true, pr_automation: true, script_generation: true, coverage_generation: true, release_signoff: true, priority_support: true, sso: true },
    },
    {
      name: 'Enterprise', slug: 'enterprise',
      price_usd_monthly: 0, price_usd_annually: 0,
      price_inr_monthly: 0, price_inr_annually: 0,
      credits_monthly: -1, max_users: -1, max_repos: -1,
      max_jobs_per_month: -1, retention_days: 365,
      features: { healing_types: ['rule_based', 'database_pattern', 'ai_reasoning'], rca: true, pr_automation: true, script_generation: true, coverage_generation: true, release_signoff: true, dedicated_support: true, sso: true, custom_sla: true, on_premise: true },
    },
  ];

  for (const p of plans) {
    await client.query(
      `INSERT INTO plans (name, slug, price_usd_monthly, price_usd_annually, price_inr_monthly, price_inr_annually, credits_monthly, max_users, max_repos, max_jobs_per_month, retention_days, features)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (slug) DO UPDATE SET
         name=$1, price_usd_monthly=$3, price_usd_annually=$4, price_inr_monthly=$5, price_inr_annually=$6,
         credits_monthly=$7, max_users=$8, max_repos=$9, max_jobs_per_month=$10, retention_days=$11,
         features=$12, updated_at=NOW()`,
      [p.name, p.slug, p.price_usd_monthly, p.price_usd_annually, p.price_inr_monthly, p.price_inr_annually,
       p.credits_monthly, p.max_users, p.max_repos, p.max_jobs_per_month, p.retention_days, JSON.stringify(p.features)]
    );
  }
  logger.info(MOD, 'Default plans seeded/updated');
}

async function seedDefaultRoles(client: PoolClient): Promise<void> {
  const roles = [
    {
      name: 'Owner', slug: 'owner',
      description: 'Full platform access with billing and team management',
      permissions: {
        platform: ['view_dashboard','manage_repos','configure_settings','manage_integrations'],
        testing: ['run_tests','view_results','manage_healing','approve_fixes'],
        billing: ['view_billing','manage_subscription','manage_payment_methods','view_invoices'],
        team: ['invite_members','remove_members','assign_roles','view_audit_logs'],
        intelligence: ['view_rca','generate_scripts','manage_coverage','release_signoff','view_learning'],
      },
      is_system: true,
    },
    {
      name: 'QA Manager', slug: 'qa_manager',
      description: 'Test management and team oversight',
      permissions: {
        platform: ['view_dashboard','manage_repos','configure_settings'],
        testing: ['run_tests','view_results','manage_healing','approve_fixes'],
        billing: ['view_billing','view_invoices'],
        team: ['invite_members','assign_roles','view_audit_logs'],
        intelligence: ['view_rca','generate_scripts','manage_coverage','release_signoff','view_learning'],
      },
      is_system: true,
    },
    {
      name: 'QA Engineer', slug: 'qa_engineer',
      description: 'Day-to-day testing and healing operations',
      permissions: {
        platform: ['view_dashboard','manage_repos'],
        testing: ['run_tests','view_results','manage_healing'],
        billing: ['view_billing'],
        team: [],
        intelligence: ['view_rca','generate_scripts','manage_coverage','view_learning'],
      },
      is_system: true,
    },
    {
      name: 'Viewer', slug: 'viewer',
      description: 'Read-only access to dashboards and reports',
      permissions: {
        platform: ['view_dashboard'],
        testing: ['view_results'],
        billing: ['view_billing'],
        team: [],
        intelligence: ['view_rca','view_learning'],
      },
      is_system: true,
    },
  ];

  for (const r of roles) {
    await client.query(
      `INSERT INTO roles (name, slug, description, permissions, is_system)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE SET
         name=$1, description=$3, permissions=$4, is_system=$5`,
      [r.name, r.slug, r.description, JSON.stringify(r.permissions), r.is_system]
    );
  }
  logger.info(MOD, 'Default roles seeded/updated');
}

/* -------------------------------------------------------------------------- */
/*  Billing – Plans CRUD                                                      */
/* -------------------------------------------------------------------------- */

export async function getPlans(): Promise<any[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM plans WHERE is_active = TRUE ORDER BY price_usd_monthly ASC`
  );
  return rows;
}

export async function getPlanById(id: number): Promise<any | null> {
  const { rows } = await getPool().query(`SELECT * FROM plans WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getPlanBySlug(slug: string): Promise<any | null> {
  const { rows } = await getPool().query(`SELECT * FROM plans WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

/* -------------------------------------------------------------------------- */
/*  Billing – Subscriptions CRUD                                              */
/* -------------------------------------------------------------------------- */

export async function getSubscription(companyId: number): Promise<any | null> {
  const { rows } = await getPool().query(
    `SELECT s.*, p.name as plan_name, p.slug as plan_slug, p.credits_monthly, p.max_users, p.max_repos,
            p.max_jobs_per_month, p.retention_days, p.features as plan_features
     FROM subscriptions s
     JOIN plans p ON s.plan_id = p.id
     WHERE s.company_id = $1 AND s.status IN ('active','trialing')
     ORDER BY s.created_at DESC LIMIT 1`,
    [companyId]
  );
  return rows[0] || null;
}

export async function createSubscription(data: {
  companyId: number; planId: number; billingCycle?: string; currency?: string;
  gateway?: string; gatewaySubId?: string; gatewayCustomerId?: string;
}): Promise<number> {
  const cycle = data.billingCycle || 'monthly';
  const interval = cycle === 'annually' ? '365 days' : '30 days';
  const { rows } = await getPool().query(
    `INSERT INTO subscriptions (company_id, plan_id, billing_cycle, currency, payment_gateway, gateway_subscription_id, gateway_customer_id, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + $8::interval)
     RETURNING id`,
    [data.companyId, data.planId, cycle, data.currency || 'USD', data.gateway || 'stripe',
     data.gatewaySubId || null, data.gatewayCustomerId || null, interval]
  );
  return rows[0].id;
}

export async function updateSubscription(subId: number, updates: {
  planId?: number; status?: string; billingCycle?: string; cancelledAt?: string;
}): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const vals: any[] = [];
  let i = 1;
  if (updates.planId !== undefined) { sets.push(`plan_id = $${i++}`); vals.push(updates.planId); }
  if (updates.status !== undefined) { sets.push(`status = $${i++}`); vals.push(updates.status); }
  if (updates.billingCycle !== undefined) { sets.push(`billing_cycle = $${i++}`); vals.push(updates.billingCycle); }
  if (updates.cancelledAt !== undefined) { sets.push(`cancelled_at = $${i++}`); vals.push(updates.cancelledAt); }
  vals.push(subId);
  await getPool().query(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

export async function cancelSubscription(companyId: number): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
     WHERE company_id = $1 AND status IN ('active','trialing')`,
    [companyId]
  );
  return (rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------- */
/*  Billing – Usage Tracking                                                  */
/* -------------------------------------------------------------------------- */

/** Credit cost map for each operation type */
export const CREDIT_COSTS: Record<string, number> = {
  rule_based: 0,
  database_pattern: 1,
  ai_reasoning: 5,
  rca_analysis: 3,
  script_generation: 10,
  coverage_generation: 8,
  release_signoff: 5,
  pr_automation: 3,
};

export async function trackUsage(companyId: number, operation: string, creditsUsed: number, metadata?: Record<string, any>): Promise<number> {
  const sub = await getSubscription(companyId);
  const subId = sub?.id || null;
  const periodStart = sub?.current_period_start || new Date().toISOString();
  const periodEnd = sub?.current_period_end || new Date(Date.now() + 30 * 86400000).toISOString();

  const { rows } = await getPool().query(
    `INSERT INTO subscription_usage (subscription_id, company_id, operation, credits_used, metadata, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [subId, companyId, operation, creditsUsed, JSON.stringify(metadata || {}), periodStart, periodEnd]
  );
  return rows[0].id;
}

export async function getUsageSummary(companyId: number): Promise<{
  totalCreditsUsed: number; creditsAllowed: number; creditsRemaining: number;
  totalOperations: number; periodStart: string; periodEnd: string;
}> {
  const sub = await getSubscription(companyId);
  const creditsAllowed = sub?.credits_monthly ?? 50;
  const periodStart = sub?.current_period_start || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const periodEnd = sub?.current_period_end || new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString();

  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(credits_used), 0) as total_credits, COUNT(*) as total_ops
     FROM subscription_usage
     WHERE company_id = $1 AND created_at >= $2 AND created_at <= $3`,
    [companyId, periodStart, periodEnd]
  );
  const totalCreditsUsed = parseInt(rows[0].total_credits);
  return {
    totalCreditsUsed,
    creditsAllowed: creditsAllowed === -1 ? 999999 : creditsAllowed,
    creditsRemaining: creditsAllowed === -1 ? 999999 : Math.max(0, creditsAllowed - totalCreditsUsed),
    totalOperations: parseInt(rows[0].total_ops),
    periodStart, periodEnd,
  };
}

export async function getUsageBreakdown(companyId: number): Promise<Array<{
  operation: string; count: number; credits: number;
}>> {
  const sub = await getSubscription(companyId);
  const periodStart = sub?.current_period_start || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  const { rows } = await getPool().query(
    `SELECT operation, COUNT(*)::int as count, COALESCE(SUM(credits_used), 0)::int as credits
     FROM subscription_usage
     WHERE company_id = $1 AND created_at >= $2
     GROUP BY operation ORDER BY credits DESC`,
    [companyId, periodStart]
  );
  return rows;
}

export async function getUsageTrend(companyId: number, days: number = 30): Promise<Array<{
  date: string; operations: number; credits: number;
}>> {
  const { rows } = await getPool().query(
    `SELECT DATE(created_at) as date, COUNT(*)::int as operations, COALESCE(SUM(credits_used), 0)::int as credits
     FROM subscription_usage
     WHERE company_id = $1 AND created_at >= NOW() - $2::int * INTERVAL '1 day'
     GROUP BY DATE(created_at) ORDER BY date ASC`,
    [companyId, days]
  );
  return rows;
}

export async function checkCredits(companyId: number, requiredCredits: number = 0): Promise<{
  allowed: boolean; remaining: number; total: number; used: number;
}> {
  const usage = await getUsageSummary(companyId);
  return {
    allowed: usage.creditsRemaining >= requiredCredits,
    remaining: usage.creditsRemaining,
    total: usage.creditsAllowed,
    used: usage.totalCreditsUsed,
  };
}

/* -------------------------------------------------------------------------- */
/*  Billing – Billing Events / Invoices                                       */
/* -------------------------------------------------------------------------- */

export async function logBillingEvent(data: {
  companyId: number; subscriptionId?: number; eventType: string; amount?: number;
  currency?: string; gateway?: string; gatewayEventId?: string; invoiceNumber?: string;
  status?: string; description?: string; metadata?: Record<string, any>;
}): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO billing_events (company_id, subscription_id, event_type, amount, currency, gateway, gateway_event_id, invoice_number, status, description, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [data.companyId, data.subscriptionId || null, data.eventType, data.amount || 0,
     data.currency || 'USD', data.gateway || null, data.gatewayEventId || null,
     data.invoiceNumber || null, data.status || 'completed', data.description || null,
     JSON.stringify(data.metadata || {})]
  );
  return rows[0].id;
}

export async function getBillingEvents(companyId: number, limit: number = 50): Promise<any[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM billing_events WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [companyId, limit]
  );
  return rows;
}

export async function getInvoices(companyId: number): Promise<any[]> {
  const { rows } = await getPool().query(
    `SELECT be.*, p.name as plan_name, s.billing_cycle
     FROM billing_events be
     LEFT JOIN subscriptions s ON be.subscription_id = s.id
     LEFT JOIN plans p ON s.plan_id = p.id
     WHERE be.company_id = $1 AND be.event_type IN ('invoice','payment','charge')
     ORDER BY be.created_at DESC`,
    [companyId]
  );
  return rows;
}

/* -------------------------------------------------------------------------- */
/*  Billing – Payment Methods                                                 */
/* -------------------------------------------------------------------------- */

export async function getPaymentMethods(companyId: number): Promise<any[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM payment_methods WHERE company_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [companyId]
  );
  return rows;
}

export async function addPaymentMethod(data: {
  companyId: number; type?: string; lastFour?: string; brand?: string;
  expMonth?: number; expYear?: number; isDefault?: boolean; gateway?: string; gatewayPmId?: string;
}): Promise<number> {
  // If this is default, un-default others
  if (data.isDefault) {
    await getPool().query(`UPDATE payment_methods SET is_default = FALSE WHERE company_id = $1`, [data.companyId]);
  }
  const { rows } = await getPool().query(
    `INSERT INTO payment_methods (company_id, type, last_four, brand, exp_month, exp_year, is_default, gateway, gateway_pm_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [data.companyId, data.type || 'card', data.lastFour || null, data.brand || null,
     data.expMonth || null, data.expYear || null, data.isDefault || false,
     data.gateway || 'stripe', data.gatewayPmId || null]
  );
  return rows[0].id;
}

export async function removePaymentMethod(id: number, companyId: number): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM payment_methods WHERE id = $1 AND company_id = $2`, [id, companyId]
  );
  return (rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------- */
/*  Billing – Ensure Free Plan on New Company                                 */
/* -------------------------------------------------------------------------- */

export async function ensureFreePlan(companyId: number): Promise<void> {
  const existing = await getSubscription(companyId);
  if (existing) return;
  const freePlan = await getPlanBySlug('free');
  if (!freePlan) return;
  await createSubscription({ companyId, planId: freePlan.id, billingCycle: 'monthly', currency: 'USD' });
  logger.info(MOD, `Auto-assigned Free plan to company ${companyId}`);
}

/* -------------------------------------------------------------------------- */
/*  Company CRUD                                                              */
/* -------------------------------------------------------------------------- */

export async function createCompany(name: string, slug: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return rows[0].id;
}

export async function getCompanies(): Promise<Array<{ id: number; name: string; slug: string; is_active: boolean; created_at: string }>> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, name, slug, is_active, created_at FROM companies ORDER BY name`
  );
  return rows;
}

export async function getCompanyById(id: number): Promise<{ id: number; name: string; slug: string; is_active: boolean } | null> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT id, name, slug, is_active FROM companies WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getCompanyBySlug(slug: string): Promise<{ id: number; name: string; slug: string; is_active: boolean } | null> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT id, name, slug, is_active FROM companies WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

export async function updateCompany(id: number, data: { name?: string; is_active?: boolean }): Promise<void> {
  const pool = getPool();
  const sets: string[] = ['updated_at = NOW()'];
  const vals: any[] = [];
  let idx = 1;
  if (data.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(data.name); }
  if (data.is_active !== undefined) { sets.push(`is_active = $${idx++}`); vals.push(data.is_active); }
  vals.push(id);
  await pool.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
}

/* -------------------------------------------------------------------------- */
/*  Test Executions                                                           */
/* -------------------------------------------------------------------------- */

export async function logExecution(data: TestExecution, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO test_executions
      (test_name, status, error_message, screenshot_path, github_commit_sha, duration_ms, healing_attempted, healing_succeeded, company_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id`,
    [
      data.test_name,
      data.status,
      data.error_message ?? null,
      data.screenshot_path ?? null,
      data.github_commit_sha ?? null,
      data.duration_ms ?? 0,
      data.healing_attempted ?? false,
      data.healing_succeeded ?? false,
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function updateExecution(id: number, fields: Partial<TestExecution>): Promise<void> {
  const allowed: Array<keyof TestExecution> = [
    'status', 'error_message', 'screenshot_path', 'github_commit_sha', 'duration_ms', 'healing_attempted', 'healing_succeeded',
  ];

  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = $${paramIdx}`);
      values.push(fields[key]);
      paramIdx++;
    }
  }

  if (updates.length === 0) return;

  values.push(id);
  await getPool().query(
    `UPDATE test_executions SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
    values,
  );
}

/* -------------------------------------------------------------------------- */
/*  Healing Actions                                                           */
/* -------------------------------------------------------------------------- */

export async function logHealing(data: HealingAction, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO healing_actions
      (test_execution_id, test_name, failed_locator, healed_locator, healing_strategy, ai_tokens_used,
       success, confidence, error_context, validation_status, validation_reason, patch_path, company_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING id`,
    [
      data.test_execution_id,
      data.test_name,
      data.failed_locator,
      data.healed_locator ?? null,
      data.healing_strategy,
      data.ai_tokens_used ?? 0,
      data.success ?? false,
      data.confidence ?? 0,
      data.error_context ?? null,
      data.validation_status ?? null,
      data.validation_reason ?? null,
      data.patch_path ?? null,
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

/* -------------------------------------------------------------------------- */
/*  Learned Patterns                                                          */
/* -------------------------------------------------------------------------- */

export async function lookupPattern(input: {
  failed_locator: string;
  test_name: string;
  error_pattern: string;
}): Promise<{
  healed_locator: string;
  confidence: number;
  strategy: string;
  usage_count: number;
} | null> {
  // Try exact match first
  const exact = await getPool().query(
    `SELECT healed_locator, confidence, solution_strategy, usage_count
    FROM learned_patterns
    WHERE failed_locator = $1 AND test_name = $2
    ORDER BY success_count DESC, usage_count DESC, last_used DESC
    LIMIT 1`,
    [input.failed_locator, input.test_name],
  );

  let row = exact.rows[0];

  if (!row) {
    // Try fuzzy match
    const fuzzy = await getPool().query(
      `SELECT healed_locator, confidence, solution_strategy, usage_count
      FROM learned_patterns
      WHERE failed_locator = $1 OR (test_name = $2 AND error_pattern LIKE $3)
      ORDER BY success_count DESC, usage_count DESC, last_used DESC
      LIMIT 1`,
      [input.failed_locator, input.test_name, `%${input.error_pattern.slice(0, 120)}%`],
    );
    row = fuzzy.rows[0];
  }

  if (!row) return null;

  // Update usage count
  await getPool().query(
    `UPDATE learned_patterns
    SET usage_count = usage_count + 1, last_used = NOW()
    WHERE failed_locator = $1 AND healed_locator = $2`,
    [input.failed_locator, row.healed_locator],
  );

  return {
    healed_locator: row.healed_locator,
    confidence: row.confidence,
    strategy: row.solution_strategy,
    usage_count: row.usage_count + 1,
  };
}

export async function storePattern(data: LearnedPattern, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO learned_patterns
      (test_name, error_pattern, failed_locator, healed_locator, solution_strategy, confidence, avg_tokens_saved, company_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT(test_name, error_pattern, failed_locator)
    DO UPDATE SET
      healed_locator = EXCLUDED.healed_locator,
      solution_strategy = EXCLUDED.solution_strategy,
      confidence = EXCLUDED.confidence,
      success_count = learned_patterns.success_count + 1,
      usage_count = learned_patterns.usage_count + 1,
      avg_tokens_saved = (learned_patterns.avg_tokens_saved + EXCLUDED.avg_tokens_saved) / 2,
      last_used = NOW()
    RETURNING id`,
    [
      data.test_name,
      data.error_pattern.slice(0, 250),
      data.failed_locator,
      data.healed_locator,
      data.solution_strategy,
      data.confidence ?? 0,
      data.avg_tokens_saved ?? 0,
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

/* -------------------------------------------------------------------------- */
/*  Historical Stats                                                          */
/* -------------------------------------------------------------------------- */

export async function getHistoricalStats(companyId?: number): Promise<HistoricalStats> {
  const p = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';

  const [execRes, healRes, successRes, tokenRes, patternRes, strategyRes] = await Promise.all([
    p.query(`SELECT COUNT(*) as c FROM test_executions ${cf}`),
    p.query(`SELECT COUNT(*) as c FROM healing_actions ${cf}`),
    p.query(`SELECT COUNT(*) as c FROM healing_actions WHERE success = true ${cfAnd}`),
    p.query(`SELECT COALESCE(SUM(ai_tokens_used), 0) as t FROM healing_actions ${cf}`),
    p.query(`SELECT COUNT(*) as c FROM learned_patterns ${cf}`),
    p.query(`SELECT healing_strategy, COUNT(*) as c FROM healing_actions ${cf} GROUP BY healing_strategy`),
  ]);

  const totalExecutions = parseInt(execRes.rows[0].c, 10);
  const totalHealings = parseInt(healRes.rows[0].c, 10);
  const successHealings = parseInt(successRes.rows[0].c, 10);
  const totalTokens = parseInt(tokenRes.rows[0].t, 10);
  const patternCount = parseInt(patternRes.rows[0].c, 10);

  const breakdown = { rule_based: 0, database_pattern: 0, ai_reasoning: 0 };
  for (const row of strategyRes.rows) {
    const strategy = row.healing_strategy as keyof typeof breakdown;
    if (strategy in breakdown) {
      breakdown[strategy] = parseInt(row.c, 10);
    }
  }

  const successRate = totalHealings > 0 ? `${((successHealings / totalHealings) * 100).toFixed(1)}%` : 'N/A';
  const tokensSaved = totalHealings > 0
    ? `~${(breakdown.rule_based + breakdown.database_pattern) * 500} est.`
    : 'N/A';

  return {
    total_executions: totalExecutions,
    total_healings: totalHealings,
    success_rate: successRate,
    total_tokens: totalTokens,
    tokens_saved: tokensSaved,
    learned_patterns: patternCount,
    strategy_breakdown: breakdown,
  };
}

/* -------------------------------------------------------------------------- */
/*  Token Usage                                                               */
/* -------------------------------------------------------------------------- */

export async function logTokenUsage(engine: string, tokensUsed: number, costUsd: number, companyId?: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await getPool().query(
    `INSERT INTO token_usage (date, engine, tokens_used, cost_usd, company_id) VALUES ($1, $2, $3, $4, $5)`,
    [today, engine, tokensUsed, costUsd, companyId ?? null],
  );
}

export async function getTokensUsedToday(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const result = await getPool().query(
    `SELECT COALESCE(SUM(tokens_used), 0) AS total FROM token_usage WHERE date = $1`,
    [today],
  );
  return parseInt(result.rows[0].total, 10);
}

export async function getDailyCostUsd(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const result = await getPool().query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM token_usage WHERE date = $1`,
    [today],
  );
  return parseFloat(result.rows[0].total);
}

/* -------------------------------------------------------------------------- */
/*  Jobs Persistence                                                          */
/* -------------------------------------------------------------------------- */

export async function persistJob(job: {
  id: string;
  repositoryId: string;
  repositoryUrl?: string;
  branch: string;
  commit?: string;
  status: string;
  progress: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: any;
  error?: string;
  companyId?: number;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO healing_jobs
      (id, repository_id, repository_url, branch, commit_sha, status, progress,
       created_at, started_at, completed_at, result, error, company_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT(id) DO UPDATE SET
      status = EXCLUDED.status,
      progress = EXCLUDED.progress,
      started_at = EXCLUDED.started_at,
      completed_at = EXCLUDED.completed_at,
      result = EXCLUDED.result,
      error = EXCLUDED.error`,
    [
      job.id,
      job.repositoryId,
      job.repositoryUrl ?? null,
      job.branch,
      job.commit ?? null,
      job.status,
      job.progress,
      job.createdAt,
      job.startedAt ?? null,
      job.completedAt ?? null,
      job.result ? JSON.stringify(job.result) : null,
      job.error ?? null,
      job.companyId ?? null,
    ],
  );
}

export async function loadJobFromDb(jobId: string): Promise<any | null> {
  const result = await getPool().query('SELECT * FROM healing_jobs WHERE id = $1', [jobId]);
  return result.rows[0] ?? null;
}

export async function loadPersistedJobs(statuses: string[]): Promise<any[]> {
  const result = await getPool().query(
    `SELECT * FROM healing_jobs WHERE status = ANY($1) ORDER BY created_at DESC LIMIT 50`,
    [statuses],
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/*  RCA Analysis Persistence                                                  */
/* -------------------------------------------------------------------------- */

export interface RCARecord {
  id?: number;
  test_execution_id: string;
  job_id: string;
  test_name: string;
  root_cause: string;
  classification: string;
  severity: string;
  confidence: number;
  suggested_fix: string;
  affected_component: string;
  is_flaky: boolean;
  flaky_reason?: string;
  summary: string;
  technical_details?: string;
  tokens_used: number;
  model: string;
  analysis_time_ms: number;
  healing_attempted: boolean;
  healing_succeeded: boolean;
  healed_locator?: string;
  healing_strategy?: string;
  error_message?: string;
  created_at?: string;
}

export async function logRCA(data: RCARecord, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO rca_analyses
      (test_execution_id, job_id, test_name, root_cause, classification, severity,
       confidence, suggested_fix, affected_component, is_flaky, flaky_reason,
       summary, technical_details, tokens_used, model, analysis_time_ms,
       healing_attempted, healing_succeeded, healed_locator, healing_strategy, error_message, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    RETURNING id`,
    [
      data.test_execution_id,
      data.job_id,
      data.test_name,
      data.root_cause,
      data.classification,
      data.severity,
      data.confidence,
      data.suggested_fix,
      data.affected_component,
      data.is_flaky,
      data.flaky_reason ?? null,
      data.summary,
      data.technical_details ?? null,
      data.tokens_used,
      data.model,
      data.analysis_time_ms,
      data.healing_attempted,
      data.healing_succeeded,
      data.healed_locator ?? null,
      data.healing_strategy ?? null,
      data.error_message ?? null,
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function getRCA(executionId: string, companyId?: number): Promise<RCARecord | null> {
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM rca_analyses WHERE test_execution_id = $1 ${cfAnd} ORDER BY created_at DESC LIMIT 1`,
    [executionId],
  );
  return result.rows[0] ?? null;
}

export async function getRCAsForJob(jobId: string, companyId?: number): Promise<RCARecord[]> {
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM rca_analyses WHERE job_id = $1 ${cfAnd} ORDER BY created_at ASC`,
    [jobId],
  );
  return result.rows;
}

export async function getRCAStats(companyId?: number): Promise<{
  total: number;
  byClassification: Record<string, number>;
  bySeverity: Record<string, number>;
  avgConfidence: number;
  flakyCount: number;
  healingSuccessRate: number;
}> {
  const pool = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';

  const totalRes = await pool.query(`SELECT COUNT(*) AS count FROM rca_analyses ${cf}`);
  const total = parseInt(totalRes.rows[0].count, 10);

  const classRes = await pool.query(
    `SELECT classification, COUNT(*) AS count FROM rca_analyses ${cf} GROUP BY classification ORDER BY count DESC`,
  );
  const byClassification: Record<string, number> = {};
  for (const row of classRes.rows) {
    byClassification[row.classification] = parseInt(row.count, 10);
  }

  const sevRes = await pool.query(
    `SELECT severity, COUNT(*) AS count FROM rca_analyses ${cf} GROUP BY severity ORDER BY count DESC`,
  );
  const bySeverity: Record<string, number> = {};
  for (const row of sevRes.rows) {
    bySeverity[row.severity] = parseInt(row.count, 10);
  }

  const avgRes = await pool.query(
    `SELECT COALESCE(AVG(confidence), 0) AS avg FROM rca_analyses ${cf}`,
  );
  const avgConfidence = parseFloat(avgRes.rows[0].avg);

  const flakyRes = await pool.query(
    `SELECT COUNT(*) AS count FROM rca_analyses WHERE is_flaky = true ${cfAnd}`,
  );
  const flakyCount = parseInt(flakyRes.rows[0].count, 10);

  const healRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE healing_attempted = true) AS attempted,
       COUNT(*) FILTER (WHERE healing_succeeded = true) AS succeeded
     FROM rca_analyses ${cf}`,
  );
  const attempted = parseInt(healRes.rows[0].attempted, 10);
  const succeeded = parseInt(healRes.rows[0].succeeded, 10);
  const healingSuccessRate = attempted > 0 ? succeeded / attempted : 0;

  return { total, byClassification, bySeverity, avgConfidence, flakyCount, healingSuccessRate };
}

/* -------------------------------------------------------------------------- */
/*  Flaky Test Analytics                                                      */
/* -------------------------------------------------------------------------- */

export interface FlakyTestSummary {
  test_name: string;
  flaky_count: number;
  total_analyses: number;
  flaky_rate: number;
  latest_reason: string | null;
  latest_severity: string;
  classifications: string[];
  first_seen: string;
  last_seen: string;
  affected_components: string[];
}

export async function getFlakyTests(companyId?: number): Promise<FlakyTestSummary[]> {
  const pool = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await pool.query(`
    WITH flaky_agg AS (
      SELECT
        test_name,
        COUNT(*) FILTER (WHERE is_flaky = true) AS flaky_count,
        COUNT(*) AS total_analyses,
        ARRAY_AGG(DISTINCT classification) FILTER (WHERE classification IS NOT NULL) AS classifications,
        ARRAY_AGG(DISTINCT affected_component) FILTER (WHERE affected_component IS NOT NULL) AS affected_components,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen
      FROM rca_analyses
      ${cf}
      GROUP BY test_name
      HAVING COUNT(*) FILTER (WHERE is_flaky = true) > 0
    ),
    latest_flaky AS (
      SELECT DISTINCT ON (test_name)
        test_name, flaky_reason, severity
      FROM rca_analyses
      WHERE is_flaky = true ${cfAnd}
      ORDER BY test_name, created_at DESC
    )
    SELECT
      f.test_name,
      f.flaky_count,
      f.total_analyses,
      ROUND((f.flaky_count::numeric / NULLIF(f.total_analyses, 0)) * 100, 1) AS flaky_rate,
      l.flaky_reason AS latest_reason,
      COALESCE(l.severity, 'medium') AS latest_severity,
      f.classifications,
      f.first_seen,
      f.last_seen,
      f.affected_components
    FROM flaky_agg f
    LEFT JOIN latest_flaky l ON l.test_name = f.test_name
    ORDER BY f.flaky_count DESC, f.last_seen DESC
  `);
  return result.rows;
}

export async function getFlakyTrend(days: number = 30, companyId?: number): Promise<Array<{ date: string; flaky: number; total: number }>> {
  const pool = getPool();
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await pool.query(`
    SELECT
      DATE(created_at) AS date,
      COUNT(*) FILTER (WHERE is_flaky = true) AS flaky,
      COUNT(*) AS total
    FROM rca_analyses
    WHERE created_at >= NOW() - INTERVAL '${days} days' ${cfAnd}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);
  return result.rows.map(r => ({
    date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
    flaky: parseInt(r.flaky, 10),
    total: parseInt(r.total, 10),
  }));
}

export async function getFlakyHistory(testName: string, companyId?: number): Promise<RCARecord[]> {
  const pool = getPool();
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await pool.query(
    `SELECT * FROM rca_analyses WHERE test_name = $1 ${cfAnd} ORDER BY created_at DESC LIMIT 50`,
    [testName],
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/*  DOM Memory Analytics                                                      */
/* -------------------------------------------------------------------------- */

export async function getDomMemoryStats(companyId?: number): Promise<{
  totalSnapshots: number;
  totalSelectors: number;
  uniquePages: number;
  avgSelectorScore: number;
  totalLocatorChanges: number;
  uniqueHealedLocators: number;
}> {
  const pool = getPool();
  // DOM snapshots/selectors join through generated_scripts for company scope
  const snapCf = companyId ? `WHERE ds.script_id IN (SELECT id FROM generated_scripts WHERE company_id = ${companyId})` : '';
  const selCf = companyId ? `WHERE ss.script_id IN (SELECT id FROM generated_scripts WHERE company_id = ${companyId})` : '';
  const haCf = companyId ? `AND company_id = ${companyId}` : '';
  const [snapRes, selRes, pagesRes, avgRes, changesRes, uniqueHealedRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS c FROM dom_snapshots ds ${snapCf}`),
    pool.query(`SELECT COUNT(*) AS c FROM selector_scores ss ${selCf}`),
    pool.query(`SELECT COUNT(DISTINCT ds.page_url) AS c FROM dom_snapshots ds ${snapCf}`),
    pool.query(`SELECT COALESCE(AVG(ss.score), 0) AS avg FROM selector_scores ss ${selCf}`),
    pool.query(`SELECT COUNT(*) AS c FROM healing_actions WHERE healed_locator IS NOT NULL AND healed_locator != failed_locator ${haCf}`),
    pool.query(`SELECT COUNT(DISTINCT healed_locator) AS c FROM healing_actions WHERE healed_locator IS NOT NULL ${haCf}`),
  ]);
  return {
    totalSnapshots: parseInt(snapRes.rows[0].c, 10),
    totalSelectors: parseInt(selRes.rows[0].c, 10),
    uniquePages: parseInt(pagesRes.rows[0].c, 10),
    avgSelectorScore: parseFloat(parseFloat(avgRes.rows[0].avg).toFixed(2)),
    totalLocatorChanges: parseInt(changesRes.rows[0].c, 10),
    uniqueHealedLocators: parseInt(uniqueHealedRes.rows[0].c, 10),
  };
}

export async function getDomSnapshots(limit = 50, companyId?: number): Promise<any[]> {
  const cf = companyId ? `WHERE gs.company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT ds.*, gs.url AS script_url, gs.test_count
     FROM dom_snapshots ds
     LEFT JOIN generated_scripts gs ON gs.id = ds.script_id
     ${cf}
     ORDER BY ds.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getSelectorHealth(limit = 100, companyId?: number): Promise<any[]> {
  const cfJoin = companyId ? `JOIN generated_scripts gs ON gs.id = ss.script_id AND gs.company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT
       ss.selector,
       ROUND(AVG(ss.score)::numeric, 2) AS avg_score,
       COUNT(*) AS usage_count,
       MAX(ss.strategy) AS strategy,
       MAX(ss.element_type) AS element_type,
       ARRAY_AGG(DISTINCT ss.reason) FILTER (WHERE ss.reason IS NOT NULL) AS reasons,
       MIN(ss.created_at) AS first_seen,
       MAX(ss.created_at) AS last_seen
     FROM selector_scores ss
     ${cfJoin}
     GROUP BY ss.selector
     ORDER BY AVG(ss.score) ASC, COUNT(*) DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getLocatorEvolution(limit = 50, companyId?: number): Promise<any[]> {
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT
       failed_locator,
       healed_locator,
       healing_strategy,
       test_name,
       success,
       confidence,
       COUNT(*) AS occurrence_count,
       MIN(created_at) AS first_seen,
       MAX(created_at) AS last_seen
     FROM healing_actions
     WHERE healed_locator IS NOT NULL ${cfAnd}
     GROUP BY failed_locator, healed_locator, healing_strategy, test_name, success, confidence
     ORDER BY COUNT(*) DESC, MAX(created_at) DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getPageElementTrend(days = 30, companyId?: number): Promise<Array<{ date: string; pages: number; elements: number; snapshots: number }>> {
  const cfJoin = companyId ? `JOIN generated_scripts gs ON gs.id = ds.script_id AND gs.company_id = ${companyId}` : '';
  const result = await getPool().query(`
    SELECT
      DATE(ds.created_at) AS date,
      COUNT(DISTINCT ds.page_url) AS pages,
      COALESCE(SUM(ds.elements_count), 0) AS elements,
      COUNT(*) AS snapshots
    FROM dom_snapshots ds
    ${cfJoin}
    WHERE ds.created_at >= NOW() - INTERVAL '${days} days'
    GROUP BY DATE(ds.created_at)
    ORDER BY date ASC
  `);
  return result.rows.map(r => ({
    date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
    pages: parseInt(r.pages, 10),
    elements: parseInt(r.elements, 10),
    snapshots: parseInt(r.snapshots, 10),
  }));
}

export async function getSelectorScoreDistribution(companyId?: number): Promise<Array<{ range: string; count: number }>> {
  const cfJoin = companyId ? `JOIN generated_scripts gs ON gs.id = ss.script_id AND gs.company_id = ${companyId}` : '';
  const result = await getPool().query(`
    SELECT
      CASE
        WHEN ss.score >= 0.8 THEN 'Excellent (0.8-1.0)'
        WHEN ss.score >= 0.6 THEN 'Good (0.6-0.8)'
        WHEN ss.score >= 0.4 THEN 'Fair (0.4-0.6)'
        WHEN ss.score >= 0.2 THEN 'Poor (0.2-0.4)'
        ELSE 'Critical (0-0.2)'
      END AS range,
      COUNT(*) AS count
    FROM selector_scores ss
    ${cfJoin}
    GROUP BY range
    ORDER BY MIN(ss.score) DESC
  `);
  return result.rows.map(r => ({ range: r.range, count: parseInt(r.count, 10) }));
}

/* -------------------------------------------------------------------------- */
/*  Learning Engine Analytics                                                 */
/* -------------------------------------------------------------------------- */

export async function getLearningStats(companyId?: number): Promise<{
  totalPatterns: number;
  totalUsages: number;
  avgConfidence: number;
  avgTokensSaved: number;
  totalTokensSaved: number;
  topStrategy: string;
  activePatterns: number;
  stalePatterns: number;
}> {
  const pool = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const [totalRes, usageRes, avgRes, tokenRes, stratRes, activeRes, staleRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS c FROM learned_patterns ${cf}`),
    pool.query(`SELECT COALESCE(SUM(usage_count), 0) AS c FROM learned_patterns ${cf}`),
    pool.query(`SELECT COALESCE(AVG(confidence), 0) AS avg FROM learned_patterns ${cf}`),
    pool.query(`SELECT COALESCE(SUM(avg_tokens_saved * usage_count), 0) AS total, COALESCE(AVG(avg_tokens_saved), 0) AS avg FROM learned_patterns ${cf}`),
    pool.query(`SELECT solution_strategy, COUNT(*) AS c FROM learned_patterns ${cf} GROUP BY solution_strategy ORDER BY c DESC LIMIT 1`),
    pool.query(`SELECT COUNT(*) AS c FROM learned_patterns WHERE last_used >= NOW() - INTERVAL '30 days' ${cfAnd}`),
    pool.query(`SELECT COUNT(*) AS c FROM learned_patterns WHERE last_used < NOW() - INTERVAL '90 days' ${cfAnd}`),
  ]);
  return {
    totalPatterns: parseInt(totalRes.rows[0].c, 10),
    totalUsages: parseInt(usageRes.rows[0].c, 10),
    avgConfidence: parseFloat(parseFloat(avgRes.rows[0].avg).toFixed(3)),
    avgTokensSaved: parseFloat(parseFloat(tokenRes.rows[0].avg).toFixed(0)),
    totalTokensSaved: parseInt(tokenRes.rows[0].total, 10),
    topStrategy: stratRes.rows[0]?.solution_strategy || 'N/A',
    activePatterns: parseInt(activeRes.rows[0].c, 10),
    stalePatterns: parseInt(staleRes.rows[0].c, 10),
  };
}

export async function getPatternsList(limit = 100, companyId?: number): Promise<any[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM learned_patterns ${cf} ORDER BY usage_count DESC, success_count DESC, last_used DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getStrategyEffectiveness(companyId?: number): Promise<Array<{
  strategy: string;
  pattern_count: number;
  total_usages: number;
  avg_confidence: number;
  total_successes: number;
  total_failures: number;
  success_rate: number;
  avg_tokens_saved: number;
}>> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(`
    SELECT
      solution_strategy AS strategy,
      COUNT(*) AS pattern_count,
      COALESCE(SUM(usage_count), 0) AS total_usages,
      ROUND(AVG(confidence)::numeric, 3) AS avg_confidence,
      COALESCE(SUM(success_count), 0) AS total_successes,
      COALESCE(SUM(failure_count), 0) AS total_failures,
      CASE WHEN SUM(success_count) + SUM(failure_count) > 0
        THEN ROUND((SUM(success_count)::numeric / (SUM(success_count) + SUM(failure_count))) * 100, 1)
        ELSE 0
      END AS success_rate,
      ROUND(AVG(avg_tokens_saved)::numeric, 0) AS avg_tokens_saved
    FROM learned_patterns
    ${cf}
    GROUP BY solution_strategy
    ORDER BY total_usages DESC
  `);
  return result.rows.map(r => ({
    strategy: r.strategy,
    pattern_count: parseInt(r.pattern_count, 10),
    total_usages: parseInt(r.total_usages, 10),
    avg_confidence: parseFloat(r.avg_confidence),
    total_successes: parseInt(r.total_successes, 10),
    total_failures: parseInt(r.total_failures, 10),
    success_rate: parseFloat(r.success_rate),
    avg_tokens_saved: parseInt(r.avg_tokens_saved, 10),
  }));
}

export async function getLearningVelocity(days = 30, companyId?: number): Promise<Array<{ date: string; new_patterns: number; usages: number }>> {
  const pool = getPool();
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await pool.query(`
    SELECT
      DATE(created_at) AS date,
      COUNT(*) AS new_patterns
    FROM learned_patterns
    WHERE created_at >= NOW() - INTERVAL '${days} days' ${cfAnd}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);
  // Also get usage trend from healing_actions using pattern_match strategy
  const usageResult = await pool.query(`
    SELECT
      DATE(created_at) AS date,
      COUNT(*) AS usages
    FROM healing_actions
    WHERE healing_strategy = 'pattern_match'
      AND created_at >= NOW() - INTERVAL '${days} days' ${cfAnd}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);
  const usageMap: Record<string, number> = {};
  usageResult.rows.forEach(r => {
    const d = r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date);
    usageMap[d] = parseInt(r.usages, 10);
  });

  return result.rows.map(r => {
    const d = r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date);
    return {
      date: d,
      new_patterns: parseInt(r.new_patterns, 10),
      usages: usageMap[d] || 0,
    };
  });
}

export async function getTopPatterns(limit = 10, companyId?: number): Promise<any[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT
       test_name, failed_locator, healed_locator, solution_strategy,
       confidence, success_count, failure_count, usage_count,
       avg_tokens_saved, last_used, created_at
     FROM learned_patterns
     ${cf}
     ORDER BY usage_count DESC, success_count DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/*  PR Automation Persistence                                                 */
/* -------------------------------------------------------------------------- */

export interface PRRecord {
  id?: number;
  job_id: string;
  pr_url: string;
  pr_number: number;
  branch_name: string;
  commit_sha?: string;
  repo_owner: string;
  repo_name: string;
  base_branch: string;
  files_changed?: string[];
  healing_count: number;
  status?: string;
  merged_at?: string;
  created_at?: string;
}

export async function logPR(data: PRRecord, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO pr_automations
      (job_id, pr_url, pr_number, branch_name, commit_sha,
       repo_owner, repo_name, base_branch, files_changed, healing_count, status, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id`,
    [
      data.job_id,
      data.pr_url,
      data.pr_number,
      data.branch_name,
      data.commit_sha ?? null,
      data.repo_owner,
      data.repo_name,
      data.base_branch,
      data.files_changed ?? [],
      data.healing_count,
      data.status ?? 'open',
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function getPRForJob(jobId: string): Promise<PRRecord | null> {
  const result = await getPool().query(
    `SELECT * FROM pr_automations WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

export async function getRecentPRs(limit = 20): Promise<PRRecord[]> {
  const result = await getPool().query(
    `SELECT * FROM pr_automations ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function updatePRStatus(prId: number, status: string, mergedAt?: string): Promise<void> {
  await getPool().query(
    `UPDATE pr_automations SET status = $1, merged_at = $2 WHERE id = $3`,
    [status, mergedAt ?? null, prId],
  );
}

/* -------------------------------------------------------------------------- */
/*  Script Generation Persistence                                            */
/* -------------------------------------------------------------------------- */

export interface GeneratedScriptRecord {
  id?: number;
  url: string;
  page_type?: string;
  workflow_graph?: any;
  instructions?: string;
  script_content?: string;
  test_plan?: any;
  validation_status?: string;
  reliability_score?: number;
  review_score?: number;
  review_issues?: any;
  tokens_used?: number;
  model?: string;
  generation_time_ms?: number;
  files_generated?: any;
  negative_tests_included?: boolean;
  created_at?: string;
}

export async function logGeneratedScript(data: GeneratedScriptRecord, companyId?: number, projectId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO generated_scripts
      (url, page_type, workflow_graph, instructions, script_content, test_plan,
       validation_status, reliability_score, review_score, review_issues,
       tokens_used, model, generation_time_ms, files_generated, negative_tests_included, company_id, project_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    RETURNING id`,
    [
      data.url,
      data.page_type ?? null,
      data.workflow_graph ? JSON.stringify(data.workflow_graph) : null,
      data.instructions ?? null,
      data.script_content ?? null,
      data.test_plan ? JSON.stringify(data.test_plan) : null,
      data.validation_status ?? 'pending',
      data.reliability_score ?? 0,
      data.review_score ?? null,
      data.review_issues ? JSON.stringify(data.review_issues) : null,
      data.tokens_used ?? 0,
      data.model ?? null,
      data.generation_time_ms ?? null,
      data.files_generated ? JSON.stringify(data.files_generated) : null,
      data.negative_tests_included ?? false,
      companyId ?? null,
      projectId ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function getGeneratedScript(id: number, companyId?: number): Promise<GeneratedScriptRecord | null> {
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM generated_scripts WHERE id = $1 ${cfAnd}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getRecentScripts(limit = 20, companyId?: number): Promise<GeneratedScriptRecord[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM generated_scripts ${cf} ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function updateScriptReview(
  scriptId: number,
  reviewScore: number,
  reviewIssues: any[],
): Promise<void> {
  await getPool().query(
    `UPDATE generated_scripts SET review_score = $1, review_issues = $2 WHERE id = $3`,
    [reviewScore, JSON.stringify(reviewIssues), scriptId],
  );
}

export async function logDomSnapshot(data: {
  script_id: number;
  page_url: string;
  html_snapshot?: string;
  elements_count: number;
  page_type?: string;
}): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO dom_snapshots (script_id, page_url, html_snapshot, elements_count, page_type)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id`,
    [data.script_id, data.page_url, data.html_snapshot ?? null, data.elements_count, data.page_type ?? null],
  );
  return result.rows[0].id;
}

export async function logSelectorScores(
  scriptId: number,
  scores: Array<{ selector: string; score: number; strategy: string; element_type?: string; reason?: string }>,
): Promise<void> {
  if (scores.length === 0) return;
  const values: any[] = [];
  const placeholders: string[] = [];
  let idx = 1;
  for (const s of scores) {
    placeholders.push(`($${idx},$${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5})`);
    values.push(scriptId, s.selector, s.score, s.strategy, s.element_type ?? null, s.reason ?? null);
    idx += 6;
  }
  await getPool().query(
    `INSERT INTO selector_scores (script_id, selector, score, strategy, element_type, reason)
    VALUES ${placeholders.join(',')}`,
    values,
  );
}

export async function logWorkflowMaps(
  scriptId: number,
  maps: Array<{ source_page: string; target_page: string; action: string; link_text?: string }>,
): Promise<void> {
  if (maps.length === 0) return;
  const values: any[] = [];
  const placeholders: string[] = [];
  let idx = 1;
  for (const m of maps) {
    placeholders.push(`($${idx},$${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4})`);
    values.push(scriptId, m.source_page, m.target_page, m.action, m.link_text ?? null);
    idx += 5;
  }
  await getPool().query(
    `INSERT INTO workflow_maps (script_id, source_page, target_page, action, link_text)
    VALUES ${placeholders.join(',')}`,
    values,
  );
}

export async function logProjectExport(data: {
  script_id: number;
  project_dir: string;
  file_count: number;
  total_size: number;
  structure?: any;
}): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO generated_projects (script_id, project_dir, file_count, total_size, structure)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id`,
    [data.script_id, data.project_dir, data.file_count, data.total_size, data.structure ? JSON.stringify(data.structure) : null],
  );
  return result.rows[0].id;
}

/* -------------------------------------------------------------------------- */
/*  User Management                                                          */
/* -------------------------------------------------------------------------- */

export interface UserRecord {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  company_name: string | null;
  company_id: number | null;
  is_active: boolean;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

export async function createUser(data: {
  username: string;
  password_hash: string;
  role?: string;
  company_name?: string;
  company_id?: number;
}): Promise<UserRecord> {
  const result = await getPool().query(
    `INSERT INTO users (username, password_hash, role, company_name, company_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *`,
    [data.username, data.password_hash, data.role || 'client', data.company_name || null, data.company_id || null],
  );
  return result.rows[0];
}

export async function getUserByUsername(username: string): Promise<UserRecord | null> {
  const result = await getPool().query(
    `SELECT u.*, c.name AS company_display_name, c.slug AS company_slug
     FROM users u LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.username = $1 AND u.is_active = true`,
    [username],
  );
  return result.rows[0] ?? null;
}

export async function getUserById(id: number): Promise<UserRecord | null> {
  const result = await getPool().query(
    `SELECT u.*, c.name AS company_display_name, c.slug AS company_slug
     FROM users u LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function updateLastLogin(userId: number): Promise<void> {
  await getPool().query(
    `UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1`,
    [userId],
  );
}

export async function listUsers(companyId?: number): Promise<UserRecord[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT id, username, role, company_name, company_id, is_active, last_login, created_at, updated_at
     FROM users ${cf} ORDER BY created_at ASC`,
  );
  return result.rows;
}

export async function deactivateUser(userId: number): Promise<void> {
  await getPool().query(
    `UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1`,
    [userId],
  );
}

/* -------------------------------------------------------------------------- */
/*  Audit Logging                                                            */
/* -------------------------------------------------------------------------- */

export interface AuditLogRecord {
  id?: number;
  user_id: number | null;
  username: string;
  action: string;
  resource?: string;
  resource_id?: string;
  ip_address?: string;
  user_agent?: string;
  details?: any;
  created_at?: string;
}

export async function logAudit(data: AuditLogRecord): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO audit_logs (user_id, username, action, resource, resource_id, ip_address, user_agent, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id`,
    [
      data.user_id,
      data.username,
      data.action,
      data.resource ?? null,
      data.resource_id ?? null,
      data.ip_address ?? null,
      data.user_agent ?? null,
      data.details ? JSON.stringify(data.details) : null,
    ],
  );
  return result.rows[0].id;
}

export async function getAuditLogs(limit = 50, offset = 0): Promise<AuditLogRecord[]> {
  const result = await getPool().query(
    `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/*  Session Management                                                       */
/* -------------------------------------------------------------------------- */

export async function createSession(data: {
  user_id: number;
  token_hash: string;
  ip_address?: string;
  user_agent?: string;
  expires_at: Date;
}): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id`,
    [data.user_id, data.token_hash, data.ip_address ?? null, data.user_agent ?? null, data.expires_at],
  );
  return result.rows[0].id;
}

export async function invalidateUserSessions(userId: number): Promise<void> {
  await getPool().query(
    `DELETE FROM sessions WHERE user_id = $1`,
    [userId],
  );
}

export async function cleanExpiredSessions(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM sessions WHERE expires_at < NOW()`,
  );
  return result.rowCount ?? 0;
}


/* -------------------------------------------------------------------------- */
/*  Notification Configs                                                       */
/* -------------------------------------------------------------------------- */

export interface NotificationConfig {
  id: number;
  tool_type: string;
  display_name: string;
  status: string;
  config: Record<string, any>;
  connected_at: string | null;
  last_tested_at: string | null;
  last_test_result: string | null;
  created_at: string;
  updated_at: string;
}

export async function getNotificationConfigs(companyId?: number): Promise<NotificationConfig[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM notification_configs ${cf} ORDER BY created_at ASC`,
  );
  return result.rows;
}

export async function getNotificationConfigByType(toolType: string, companyId?: number): Promise<NotificationConfig | null> {
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM notification_configs WHERE tool_type = $1 ${cfAnd}`,
    [toolType],
  );
  return result.rows[0] || null;
}

export async function upsertNotificationConfig(data: {
  tool_type: string;
  display_name: string;
  config: Record<string, any>;
}, companyId?: number): Promise<NotificationConfig> {
  const cid = companyId ?? null;
  const result = await getPool().query(
    `INSERT INTO notification_configs (tool_type, display_name, status, config, connected_at, updated_at, company_id)
     VALUES ($1, $2, 'connected', $3, NOW(), NOW(), $4)
     ON CONFLICT (tool_type, COALESCE(company_id, 0))
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       config = EXCLUDED.config,
       status = 'connected',
       connected_at = NOW(),
       updated_at = NOW(),
       last_test_result = NULL
     RETURNING *`,
    [data.tool_type, data.display_name, JSON.stringify(data.config), cid],
  );
  return result.rows[0];
}

export async function deleteNotificationConfig(id: number): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM notification_configs WHERE id = $1`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateNotificationTestResult(
  id: number,
  success: boolean,
): Promise<void> {
  await getPool().query(
    `UPDATE notification_configs
     SET last_tested_at = NOW(),
         last_test_result = $2,
         status = CASE WHEN $2 = 'success' THEN 'connected' ELSE 'error' END,
         updated_at = NOW()
     WHERE id = $1`,
    [id, success ? 'success' : 'failed'],
  );
}

/* -------------------------------------------------------------------------- */
/*  Notification Logs                                                          */
/* -------------------------------------------------------------------------- */

export async function insertNotificationLog(data: {
  tool_type: string;
  event_type: string;
  channel?: string;
  message_preview?: string;
  status: string;
  error?: string;
  metadata?: Record<string, any>;
}, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO notification_logs (tool_type, event_type, channel, message_preview, status, error, metadata, company_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      data.tool_type,
      data.event_type,
      data.channel ?? null,
      data.message_preview ?? null,
      data.status,
      data.error ?? null,
      JSON.stringify(data.metadata ?? {}),
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function getNotificationLogs(limit = 50, companyId?: number): Promise<any[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM notification_logs ${cf} ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}
/* -------------------------------------------------------------------------- */
/*  Vector Similarity Analytics                                               */
/* -------------------------------------------------------------------------- */

export interface SimilarityStats {
  totalComparisons: number;
  avgConfidence: number;
  highConfidenceCount: number;    // >= 0.8
  mediumConfidenceCount: number;  // 0.5 - 0.79
  lowConfidenceCount: number;     // < 0.5
  domCandidateHealings: number;
  semanticMatchRate: number;
  strategyEffectiveness: Array<{
    strategy: string;
    count: number;
    avgConfidence: number;
    successRate: number;
  }>;
}

export async function getSimilarityStats(companyId?: number): Promise<SimilarityStats> {
  const p = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';

  const [totalRes, confRes, highRes, medRes, lowRes, domRes, stratRes] = await Promise.all([
    p.query(`SELECT COUNT(*) as c FROM healing_actions WHERE healed_locator IS NOT NULL ${cfAnd}`),
    p.query(`SELECT COALESCE(AVG(confidence), 0) as avg FROM healing_actions WHERE healed_locator IS NOT NULL ${cfAnd}`),
    p.query(`SELECT COUNT(*) as c FROM healing_actions WHERE confidence >= 0.8 ${cfAnd}`),
    p.query(`SELECT COUNT(*) as c FROM healing_actions WHERE confidence >= 0.5 AND confidence < 0.8 ${cfAnd}`),
    p.query(`SELECT COUNT(*) as c FROM healing_actions WHERE confidence < 0.5 AND confidence > 0 ${cfAnd}`),
    p.query(`SELECT COUNT(*) as c FROM healing_actions WHERE healing_strategy = 'rule_based' AND ai_tokens_used = 0 AND success = true ${cfAnd}`),
    p.query(`
      SELECT healing_strategy,
             COUNT(*) as count,
             ROUND(AVG(confidence)::numeric, 3) as avg_confidence,
             ROUND(SUM(CASE WHEN success THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0), 3) as success_rate
      FROM healing_actions ${cf}
      GROUP BY healing_strategy
      ORDER BY count DESC
    `),
  ]);

  const total = parseInt(totalRes.rows[0].c, 10);
  const domCandidates = parseInt(domRes.rows[0].c, 10);

  return {
    totalComparisons: total,
    avgConfidence: parseFloat(confRes.rows[0].avg) || 0,
    highConfidenceCount: parseInt(highRes.rows[0].c, 10),
    mediumConfidenceCount: parseInt(medRes.rows[0].c, 10),
    lowConfidenceCount: parseInt(lowRes.rows[0].c, 10),
    domCandidateHealings: domCandidates,
    semanticMatchRate: total > 0 ? domCandidates / total : 0,
    strategyEffectiveness: stratRes.rows.map((r: any) => ({
      strategy: r.healing_strategy,
      count: parseInt(r.count, 10),
      avgConfidence: parseFloat(r.avg_confidence) || 0,
      successRate: parseFloat(r.success_rate) || 0,
    })),
  };
}

export interface SimilarityDistribution {
  bucket: string;
  range: string;
  count: number;
  percentage: number;
}

export async function getConfidenceDistribution(companyId?: number): Promise<SimilarityDistribution[]> {
  const p = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';

  const result = await p.query(`
    SELECT
      CASE
        WHEN confidence >= 0.9 THEN '0.9-1.0'
        WHEN confidence >= 0.8 THEN '0.8-0.9'
        WHEN confidence >= 0.7 THEN '0.7-0.8'
        WHEN confidence >= 0.6 THEN '0.6-0.7'
        WHEN confidence >= 0.5 THEN '0.5-0.6'
        WHEN confidence >= 0.4 THEN '0.4-0.5'
        WHEN confidence >= 0.3 THEN '0.3-0.4'
        ELSE '0.0-0.3'
      END as bucket,
      COUNT(*) as count
    FROM healing_actions
    WHERE confidence > 0 ${cfAnd}
    GROUP BY bucket
    ORDER BY bucket DESC
  `);

  const total = result.rows.reduce((s: number, r: any) => s + parseInt(r.count, 10), 0);

  const bucketLabels: Record<string, string> = {
    '0.9-1.0': 'Excellent',
    '0.8-0.9': 'High',
    '0.7-0.8': 'Good',
    '0.6-0.7': 'Moderate',
    '0.5-0.6': 'Fair',
    '0.4-0.5': 'Low',
    '0.3-0.4': 'Poor',
    '0.0-0.3': 'Very Low',
  };

  return result.rows.map((r: any) => ({
    bucket: bucketLabels[r.bucket] || r.bucket,
    range: r.bucket,
    count: parseInt(r.count, 10),
    percentage: total > 0 ? Math.round((parseInt(r.count, 10) / total) * 10000) / 100 : 0,
  }));
}

export interface SimilarityTrend {
  date: string;
  avgConfidence: number;
  totalHealings: number;
  successCount: number;
  domCandidateCount: number;
}

export async function getSimilarityTrend(days: number = 30, companyId?: number): Promise<SimilarityTrend[]> {
  const p = getPool();
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';

  const result = await p.query(`
    SELECT
      DATE(created_at) as date,
      ROUND(AVG(confidence)::numeric, 3) as avg_confidence,
      COUNT(*) as total,
      SUM(CASE WHEN success THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN healing_strategy = 'rule_based' AND ai_tokens_used = 0 AND success THEN 1 ELSE 0 END) as dom_count
    FROM healing_actions
    WHERE created_at >= NOW() - INTERVAL '${days} days' ${cfAnd}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);

  return result.rows.map((r: any) => ({
    date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
    avgConfidence: parseFloat(r.avg_confidence) || 0,
    totalHealings: parseInt(r.total, 10),
    successCount: parseInt(r.success_count, 10),
    domCandidateCount: parseInt(r.dom_count, 10),
  }));
}

export interface TopSimilarityMatch {
  failedLocator: string;
  healedLocator: string;
  confidence: number;
  strategy: string;
  testName: string;
  success: boolean;
  createdAt: string;
}

export async function getTopSimilarityMatches(limit: number = 20, companyId?: number): Promise<TopSimilarityMatch[]> {
  const p = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';

  const result = await p.query(`
    SELECT failed_locator, healed_locator, confidence, healing_strategy,
           test_name, success, created_at
    FROM healing_actions
    ${cf}
    ORDER BY confidence DESC, created_at DESC
    LIMIT $1
  `, [limit]);

  return result.rows.map((r: any) => ({
    failedLocator: r.failed_locator,
    healedLocator: r.healed_locator,
    confidence: parseFloat(r.confidence) || 0,
    strategy: r.healing_strategy,
    testName: r.test_name,
    success: r.success,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

export interface LocatorPairAnalysis {
  failedLocator: string;
  healedLocator: string;
  occurrences: number;
  avgConfidence: number;
  successRate: number;
  strategies: string[];
  lastSeen: string;
}

export async function getLocatorPairAnalysis(limit: number = 20, companyId?: number): Promise<LocatorPairAnalysis[]> {
  const p = getPool();
  const cf = companyId ? `WHERE healed_locator IS NOT NULL ${companyId ? `AND company_id = ${companyId}` : ''}` : 'WHERE healed_locator IS NOT NULL';

  const result = await p.query(`
    SELECT failed_locator, healed_locator,
           COUNT(*) as occurrences,
           ROUND(AVG(confidence)::numeric, 3) as avg_confidence,
           ROUND(SUM(CASE WHEN success THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0), 3) as success_rate,
           ARRAY_AGG(DISTINCT healing_strategy) as strategies,
           MAX(created_at) as last_seen
    FROM healing_actions
    ${cf}
    GROUP BY failed_locator, healed_locator
    ORDER BY occurrences DESC, avg_confidence DESC
    LIMIT $1
  `, [limit]);

  return result.rows.map((r: any) => ({
    failedLocator: r.failed_locator,
    healedLocator: r.healed_locator,
    occurrences: parseInt(r.occurrences, 10),
    avgConfidence: parseFloat(r.avg_confidence) || 0,
    successRate: parseFloat(r.success_rate) || 0,
    strategies: r.strategies || [],
    lastSeen: r.last_seen instanceof Date ? r.last_seen.toISOString() : String(r.last_seen),
  }));
}

export async function getSemanticGroupStats(companyId?: number): Promise<Array<{
  locatorType: string;
  count: number;
  avgConfidence: number;
  successRate: number;
}>> {
  const p = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';

  const result = await p.query(`
    SELECT
      CASE
        WHEN failed_locator LIKE '%[data-testid%' THEN 'data-testid'
        WHEN failed_locator LIKE '%[name=%' THEN 'name attribute'
        WHEN failed_locator LIKE '%[id=%' OR failed_locator LIKE '%#%' THEN 'id selector'
        WHEN failed_locator LIKE '%[class=%' OR failed_locator LIKE '%.%' THEN 'class selector'
        WHEN failed_locator LIKE '%text=%' OR failed_locator LIKE '%getByText%' THEN 'text content'
        WHEN failed_locator LIKE '%getByRole%' THEN 'ARIA role'
        WHEN failed_locator LIKE '%getByLabel%' THEN 'label'
        WHEN failed_locator LIKE '%getByPlaceholder%' THEN 'placeholder'
        WHEN failed_locator LIKE '%xpath%' OR failed_locator LIKE '%//%' THEN 'XPath'
        ELSE 'other'
      END as locator_type,
      COUNT(*) as count,
      ROUND(AVG(confidence)::numeric, 3) as avg_confidence,
      ROUND(SUM(CASE WHEN success THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0), 3) as success_rate
    FROM healing_actions
    ${cf}
    GROUP BY locator_type
    ORDER BY count DESC
  `);

  return result.rows.map((r: any) => ({
    locatorType: r.locator_type,
    count: parseInt(r.count, 10),
    avgConfidence: parseFloat(r.avg_confidence) || 0,
    successRate: parseFloat(r.success_rate) || 0,
  }));
}

/* -------------------------------------------------------------------------- */
/*  Release Risk Data Gathering                                               */
/* -------------------------------------------------------------------------- */

export interface ReleaseRiskInputData {
  totalHealings: number;
  failedHealings: number;
  lowConfidenceHealings: number;
  avgConfidence: number;
  totalExecutions: number;
  failedExecutions: number;
  unhealedFailures: number;
  flakyCount: number;
  totalRCAs: number;
  criticalRCAs: number;
  highRCAs: number;
  mediumRCAs: number;
  recentFailureRate: number;
  previousFailureRate: number;
  moduleStats: Array<{
    module: string;
    failures: number;
    flakyCount: number;
    healingFailures: number;
    criticalRCAs: number;
  }>;
}

export async function getReleaseRiskData(days: number = 30, companyId?: number): Promise<ReleaseRiskInputData> {
  const p = getPool();
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';

  const interval = `${days} days`;

  // Healing metrics (within time window)
  const [healTotal, healFailed, healLowConf, healAvgConf] = await Promise.all([
    p.query(`SELECT COUNT(*) AS c FROM healing_actions WHERE created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
    p.query(`SELECT COUNT(*) AS c FROM healing_actions WHERE success = false AND created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
    p.query(`SELECT COUNT(*) AS c FROM healing_actions WHERE confidence < 0.5 AND confidence > 0 AND created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
    p.query(`SELECT COALESCE(AVG(confidence), 0) AS avg FROM healing_actions WHERE created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
  ]);

  // Execution metrics
  const [execTotal, execFailed, execUnhealed] = await Promise.all([
    p.query(`SELECT COUNT(*) AS c FROM test_executions WHERE created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
    p.query(`SELECT COUNT(*) AS c FROM test_executions WHERE status IN ('failed', 'timedOut') AND created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
    p.query(`SELECT COUNT(*) AS c FROM test_executions WHERE healing_attempted = true AND healing_succeeded = false AND created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
  ]);

  // RCA severity distribution
  const [rcaTotal, rcaFlaky, rcaCritical, rcaHigh, rcaMedium] = await Promise.all([
    p.query(`SELECT COUNT(*) AS c FROM rca_analyses WHERE created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
    p.query(`SELECT COUNT(*) AS c FROM rca_analyses WHERE is_flaky = true AND created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
    p.query(`SELECT COUNT(*) AS c FROM rca_analyses WHERE severity = 'critical' AND created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
    p.query(`SELECT COUNT(*) AS c FROM rca_analyses WHERE severity = 'high' AND created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
    p.query(`SELECT COUNT(*) AS c FROM rca_analyses WHERE severity = 'medium' AND created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}`),
  ]);

  // Trend: recent 7 days vs previous 7 days
  const [recentExec, recentFail, prevExec, prevFail] = await Promise.all([
    p.query(`SELECT COUNT(*) AS c FROM test_executions WHERE created_at >= NOW() - INTERVAL '7 days' ${cfAnd}`),
    p.query(`SELECT COUNT(*) AS c FROM test_executions WHERE status IN ('failed', 'timedOut') AND created_at >= NOW() - INTERVAL '7 days' ${cfAnd}`),
    p.query(`SELECT COUNT(*) AS c FROM test_executions WHERE created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' ${cfAnd}`),
    p.query(`SELECT COUNT(*) AS c FROM test_executions WHERE status IN ('failed', 'timedOut') AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days' ${cfAnd}`),
  ]);

  const recentTotal = parseInt(recentExec.rows[0].c, 10);
  const recentFails = parseInt(recentFail.rows[0].c, 10);
  const prevTotal = parseInt(prevExec.rows[0].c, 10);
  const prevFails = parseInt(prevFail.rows[0].c, 10);

  // Module breakdown from RCA affected_component
  const moduleRes = await p.query(`
    SELECT
      COALESCE(r.affected_component, 'unknown') AS module,
      COUNT(CASE WHEN te.status IN ('failed', 'timedOut') THEN 1 END) AS failures,
      COUNT(CASE WHEN r.is_flaky = true THEN 1 END) AS flaky_count,
      COUNT(CASE WHEN r.healing_attempted = true AND r.healing_succeeded = false THEN 1 END) AS healing_failures,
      COUNT(CASE WHEN r.severity = 'critical' THEN 1 END) AS critical_rcas
    FROM rca_analyses r
    LEFT JOIN test_executions te ON r.test_execution_id = te.id
    WHERE r.created_at >= NOW() - INTERVAL '${interval}' ${cfAnd.replace('company_id', 'r.company_id')}
    GROUP BY r.affected_component
    ORDER BY failures DESC
    LIMIT 20
  `);

  return {
    totalHealings: parseInt(healTotal.rows[0].c, 10),
    failedHealings: parseInt(healFailed.rows[0].c, 10),
    lowConfidenceHealings: parseInt(healLowConf.rows[0].c, 10),
    avgConfidence: parseFloat(healAvgConf.rows[0].avg) || 0,
    totalExecutions: parseInt(execTotal.rows[0].c, 10),
    failedExecutions: parseInt(execFailed.rows[0].c, 10),
    unhealedFailures: parseInt(execUnhealed.rows[0].c, 10),
    flakyCount: parseInt(rcaFlaky.rows[0].c, 10),
    totalRCAs: parseInt(rcaTotal.rows[0].c, 10),
    criticalRCAs: parseInt(rcaCritical.rows[0].c, 10),
    highRCAs: parseInt(rcaHigh.rows[0].c, 10),
    mediumRCAs: parseInt(rcaMedium.rows[0].c, 10),
    recentFailureRate: recentTotal > 0 ? recentFails / recentTotal : 0,
    previousFailureRate: prevTotal > 0 ? prevFails / prevTotal : 0,
    moduleStats: moduleRes.rows.map((r: any) => ({
      module: r.module,
      failures: parseInt(r.failures, 10),
      flakyCount: parseInt(r.flaky_count, 10),
      healingFailures: parseInt(r.healing_failures, 10),
      criticalRCAs: parseInt(r.critical_rcas, 10),
    })),
  };
}

export async function getRiskTrend(days: number = 30, companyId?: number): Promise<Array<{
  date: string;
  riskScore: number;
  failureRate: number;
  flakyRate: number;
  healingFailureRate: number;
}>> {
  const p = getPool();
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';

  const result = await p.query(`
    SELECT
      DATE(te.created_at) AS date,
      COUNT(*) AS total,
      COUNT(CASE WHEN te.status IN ('failed', 'timedOut') THEN 1 END) AS failures,
      COUNT(CASE WHEN te.healing_attempted = true AND te.healing_succeeded = false THEN 1 END) AS unhealed
    FROM test_executions te
    WHERE te.created_at >= NOW() - INTERVAL '${days} days' ${cfAnd.replace('company_id', 'te.company_id')}
    GROUP BY DATE(te.created_at)
    ORDER BY date ASC
  `);

  // Also get flaky counts per day
  const flakyRes = await p.query(`
    SELECT DATE(created_at) AS date, COUNT(*) AS flaky
    FROM rca_analyses
    WHERE is_flaky = true AND created_at >= NOW() - INTERVAL '${days} days' ${cfAnd}
    GROUP BY DATE(created_at)
  `);
  const flakyMap = new Map<string, number>();
  for (const r of flakyRes.rows) {
    const d = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
    flakyMap.set(d, parseInt(r.flaky, 10));
  }

  return result.rows.map((r: any) => {
    const dateStr = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
    const total = parseInt(r.total, 10);
    const failures = parseInt(r.failures, 10);
    const unhealed = parseInt(r.unhealed, 10);
    const flaky = flakyMap.get(dateStr) || 0;

    const failureRate = total > 0 ? failures / total : 0;
    const healingFailureRate = total > 0 ? unhealed / total : 0;
    const flakyRate = total > 0 ? flaky / total : 0;

    // Simple daily risk = weighted average
    const dailyRisk = Math.round(
      failureRate * 40 +
      healingFailureRate * 30 +
      flakyRate * 30
    ) * 100 / 100;

    return {
      date: dateStr,
      riskScore: Math.min(100, Math.round(dailyRisk * 100)),
      failureRate: Math.round(failureRate * 1000) / 10,
      flakyRate: Math.round(flakyRate * 1000) / 10,
      healingFailureRate: Math.round(healingFailureRate * 1000) / 10,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  Environment Intelligence Analytics                                        */
/* -------------------------------------------------------------------------- */

const SEVERITY_MAP: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * Classification stats with healing rates and severity for the env intelligence engine.
 */
export async function getClassificationStats(days: number, companyId?: number) {
  const p = getPool();
  const interval = `${days} days`;
  const cf = companyId ? `AND company_id = ${companyId}` : '';

  const res = await p.query(`
    SELECT
      classification,
      COUNT(*) AS count,
      COALESCE(AVG(confidence), 0) AS avg_confidence,
      COUNT(*) FILTER (WHERE healing_attempted = true) AS healing_attempted,
      COUNT(*) FILTER (WHERE healing_succeeded = true) AS healing_succeeded,
      COALESCE(AVG(
        CASE severity
          WHEN 'critical' THEN 4
          WHEN 'high' THEN 3
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 1
          ELSE 2
        END
      ), 2) AS avg_severity
    FROM rca_analyses
    WHERE created_at >= NOW() - INTERVAL '${interval}' ${cf}
    GROUP BY classification
    ORDER BY count DESC
  `);

  return res.rows.map(r => ({
    classification: r.classification,
    count: parseInt(r.count, 10),
    avg_confidence: parseFloat(r.avg_confidence),
    healing_attempted: parseInt(r.healing_attempted, 10),
    healing_succeeded: parseInt(r.healing_succeeded, 10),
    avg_severity: parseFloat(r.avg_severity),
  }));
}

/**
 * Component × classification cross-tab for heatmap.
 */
export async function getComponentClassificationStats(days: number, companyId?: number) {
  const p = getPool();
  const interval = `${days} days`;
  const cf = companyId ? `AND company_id = ${companyId}` : '';

  const res = await p.query(`
    SELECT
      COALESCE(NULLIF(affected_component, ''), 'Unknown') AS component,
      classification,
      COUNT(*) AS count,
      COALESCE(AVG(
        CASE severity
          WHEN 'critical' THEN 4
          WHEN 'high' THEN 3
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 1
          ELSE 2
        END
      ), 2) AS avg_severity
    FROM rca_analyses
    WHERE created_at >= NOW() - INTERVAL '${interval}' ${cf}
    GROUP BY component, classification
    ORDER BY count DESC
  `);

  return res.rows.map(r => ({
    component: r.component,
    classification: r.classification,
    count: parseInt(r.count, 10),
    avg_severity: parseFloat(r.avg_severity),
  }));
}

/**
 * Classification trend — daily counts by classification type.
 */
export async function getClassificationTrend(days: number, companyId?: number) {
  const p = getPool();
  const interval = `${days} days`;
  const cf = companyId ? `AND company_id = ${companyId}` : '';

  const res = await p.query(`
    SELECT
      DATE(created_at) AS date,
      COUNT(*) FILTER (WHERE classification = 'app_bug') AS app_bug,
      COUNT(*) FILTER (WHERE classification = 'infra_issue') AS infra_issue,
      COUNT(*) FILTER (WHERE classification = 'flaky_test') AS flaky_test,
      COUNT(*) FILTER (WHERE classification = 'env_config') AS env_config,
      COUNT(*) FILTER (WHERE classification = 'data_issue') AS data_issue,
      COUNT(*) FILTER (WHERE classification = 'selector_drift') AS selector_drift,
      COUNT(*) FILTER (WHERE classification = 'unknown') AS unknown
    FROM rca_analyses
    WHERE created_at >= NOW() - INTERVAL '${interval}' ${cf}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);

  return res.rows.map(r => ({
    date: r.date.toISOString().split('T')[0],
    app_bug: parseInt(r.app_bug, 10),
    infra_issue: parseInt(r.infra_issue, 10),
    flaky_test: parseInt(r.flaky_test, 10),
    env_config: parseInt(r.env_config, 10),
    data_issue: parseInt(r.data_issue, 10),
    selector_drift: parseInt(r.selector_drift, 10),
    unknown: parseInt(r.unknown, 10),
  }));
}

/**
 * Domain trend comparison — recent half vs older half of the window.
 */
export async function getDomainTrendComparison(days: number, companyId?: number) {
  const p = getPool();
  const halfDays = Math.floor(days / 2);
  const interval = `${days} days`;
  const halfInterval = `${halfDays} days`;
  const cf = companyId ? `AND company_id = ${companyId}` : '';

  // Map classification → domain in SQL
  const domainCase = `
    CASE
      WHEN classification IN ('app_bug', 'selector_drift') THEN 'application'
      WHEN classification IN ('infra_issue', 'env_config', 'data_issue') THEN 'environment'
      WHEN classification = 'flaky_test' THEN 'test_quality'
      ELSE 'unknown'
    END
  `;

  const res = await p.query(`
    SELECT
      domain,
      SUM(CASE WHEN created_at >= NOW() - INTERVAL '${halfInterval}' THEN 1 ELSE 0 END) AS recent_count,
      SUM(CASE WHEN created_at < NOW() - INTERVAL '${halfInterval}' AND created_at >= NOW() - INTERVAL '${interval}' THEN 1 ELSE 0 END) AS older_count,
      COALESCE(AVG(confidence), 0) AS avg_confidence,
      MODE() WITHIN GROUP (ORDER BY COALESCE(NULLIF(affected_component, ''), 'Unknown')) AS top_component
    FROM (
      SELECT *, ${domainCase} AS domain
      FROM rca_analyses
      WHERE created_at >= NOW() - INTERVAL '${interval}' ${cf}
    ) sub
    GROUP BY domain
    ORDER BY recent_count DESC
  `);

  return res.rows.map(r => ({
    domain: r.domain as 'application' | 'environment' | 'test_quality' | 'unknown',
    recent_count: parseInt(r.recent_count, 10),
    older_count: parseInt(r.older_count, 10),
    top_component: r.top_component || 'N/A',
    avg_confidence: parseFloat(r.avg_confidence),
  }));
}

/**
 * Recent RCA analyses with full detail for the intelligence dashboard.
 */
export async function getRecentRCAAnalyses(limit: number, companyId?: number) {
  const p = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';

  const res = await p.query(`
    SELECT
      id, test_name, classification, severity, confidence,
      root_cause, suggested_fix, affected_component,
      is_flaky, healing_attempted, healing_succeeded,
      healing_strategy, summary, created_at
    FROM rca_analyses
    ${cf}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);

  return res.rows;
}

/* -------------------------------------------------------------------------- */
/*  ROI / Maintenance Cost Analytics                                          */
/* -------------------------------------------------------------------------- */

/**
 * Gather all data needed for ROI calculation.
 */
export async function getROIData(days: number, companyId?: number) {
  const p = getPool();
  const interval = `${days} days`;
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const cfWhere = companyId ? `WHERE company_id = ${companyId} AND` : 'WHERE';

  const [
    healingTotals,
    strategyRes,
    prRes,
    patternRes,
    flakyRes,
    tokenCostRes,
  ] = await Promise.all([
    // Healing totals for the window
    p.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE success = true) AS successful
      FROM healing_actions
      ${cfWhere} created_at >= NOW() - INTERVAL '${interval}'
    `),
    // Strategy breakdown
    p.query(`
      SELECT healing_strategy, COUNT(*) AS count
      FROM healing_actions
      ${cfWhere} created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY healing_strategy
    `),
    // PR stats
    p.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'merged') AS merged
      FROM pr_automations
      ${cfWhere} created_at >= NOW() - INTERVAL '${interval}'
    `),
    // Pattern stats
    p.query(`
      SELECT
        COUNT(*) AS total_patterns,
        COALESCE(SUM(usage_count), 0) AS total_usages
      FROM learned_patterns ${cf}
    `),
    // Flaky count
    p.query(`
      SELECT COUNT(DISTINCT test_name) AS count
      FROM rca_analyses
      ${cfWhere} is_flaky = true AND created_at >= NOW() - INTERVAL '${interval}'
    `),
    // Token cost
    p.query(`
      SELECT
        COALESCE(SUM(tokens_used), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS total_cost
      FROM token_usage
      ${cfWhere} date >= TO_CHAR(NOW() - INTERVAL '${interval}', 'YYYY-MM-DD')
    `),
  ]);

  // Strategy breakdown
  const strategyBreakdown: Record<string, number> = {};
  for (const row of strategyRes.rows) {
    strategyBreakdown[row.healing_strategy] = parseInt(row.count, 10);
  }

  return {
    totalHealings: parseInt(healingTotals.rows[0].total, 10),
    successfulHealings: parseInt(healingTotals.rows[0].successful, 10),
    totalTokensUsed: parseInt(tokenCostRes.rows[0].total_tokens, 10),
    strategyBreakdown,
    prsGenerated: parseInt(prRes.rows[0].total, 10),
    prsMerged: parseInt(prRes.rows[0].merged, 10),
    patternsLearned: parseInt(patternRes.rows[0].total_patterns, 10),
    totalPatternUsages: parseInt(patternRes.rows[0].total_usages, 10),
    flakyTestCount: parseInt(flakyRes.rows[0].count, 10),
    totalTokenCostUsd: parseFloat(tokenCostRes.rows[0].total_cost),
  };
}

/**
 * Daily trend for ROI chart — healings + token cost per day.
 */
export async function getROIDailyTrend(days: number, companyId?: number) {
  const p = getPool();
  const interval = `${days} days`;
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';

  const res = await p.query(`
    SELECT
      d.date,
      COALESCE(h.healings, 0) AS healings,
      COALESCE(h.tokens_used, 0) AS tokens_used,
      COALESCE(t.token_cost, 0) AS token_cost
    FROM (
      SELECT generate_series(
        (NOW() - INTERVAL '${interval}')::date,
        NOW()::date,
        '1 day'
      )::date AS date
    ) d
    LEFT JOIN (
      SELECT DATE(created_at) AS date,
        COUNT(*) AS healings,
        COALESCE(SUM(ai_tokens_used), 0) AS tokens_used
      FROM healing_actions
      WHERE created_at >= NOW() - INTERVAL '${interval}' ${cfAnd}
      GROUP BY DATE(created_at)
    ) h ON d.date = h.date
    LEFT JOIN (
      SELECT date::date AS date, COALESCE(SUM(cost_usd), 0) AS token_cost
      FROM token_usage
      WHERE date >= TO_CHAR(NOW() - INTERVAL '${interval}', 'YYYY-MM-DD') ${cfAnd}
      GROUP BY date::date
    ) t ON d.date = t.date
    ORDER BY d.date ASC
  `);

  return res.rows.map(r => ({
    date: r.date.toISOString().split('T')[0],
    healings: parseInt(r.healings, 10),
    tokens_used: parseInt(r.tokens_used, 10),
    token_cost: parseFloat(r.token_cost),
  }));
}

/* -------------------------------------------------------------------------- */
/*  Test Coverage Intelligence — DB Functions                                  */
/* -------------------------------------------------------------------------- */

// ---- Test Requirements ----
export async function createTestRequirement(data: {
  title: string; description: string; jiraId?: string; businessFlow?: string;
  acceptanceCriteria?: string; apiDocs?: string; releaseNotes?: string;
  module?: string; featureType?: string; riskLevel?: string; analysis?: any;
  companyId?: number;
}): Promise<number> {
  const pool = getPool();
  const r = await pool.query(
    `INSERT INTO test_requirements
       (title, description, jira_id, business_flow, acceptance_criteria, api_docs,
        release_notes, module, feature_type, risk_level, analysis, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [data.title, data.description, data.jiraId || null, data.businessFlow || null,
     data.acceptanceCriteria || null, data.apiDocs || null, data.releaseNotes || null,
     data.module || null, data.featureType || null, data.riskLevel || 'medium',
     data.analysis ? JSON.stringify(data.analysis) : null, data.companyId || null]
  );
  return r.rows[0].id;
}

export async function getTestRequirements(companyId?: number): Promise<any[]> {
  const pool = getPool();
  const where = companyId ? 'WHERE company_id = $1' : '';
  const params = companyId ? [companyId] : [];
  const r = await pool.query(
    `SELECT tr.*, 
       (SELECT COUNT(*) FROM generated_test_scenarios WHERE requirement_id = tr.id) as scenario_count,
       (SELECT COUNT(*) FROM generated_test_cases tc 
        JOIN generated_test_scenarios ts ON tc.scenario_id = ts.id 
        WHERE ts.requirement_id = tr.id) as test_case_count
     FROM test_requirements tr ${where}
     ORDER BY tr.created_at DESC LIMIT 100`, params
  );
  return r.rows;
}

export async function getTestRequirement(id: number, companyId?: number): Promise<any | null> {
  const pool = getPool();
  const where = companyId ? 'AND company_id = $2' : '';
  const params: any[] = [id];
  if (companyId) params.push(companyId);
  const r = await pool.query(
    `SELECT * FROM test_requirements WHERE id = $1 ${where}`, params
  );
  return r.rows[0] || null;
}

export async function deleteTestRequirement(id: number): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query('DELETE FROM test_requirements WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}

// ---- Generated Test Scenarios ----
export async function insertTestScenarios(requirementId: number, scenarios: Array<{
  scenario: string; coverageType: string; priority: string; riskArea: string;
}>, companyId?: number): Promise<number[]> {
  const pool = getPool();
  const ids: number[] = [];
  for (const s of scenarios) {
    const r = await pool.query(
      `INSERT INTO generated_test_scenarios (requirement_id, scenario, coverage_type, priority, risk_area, company_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [requirementId, s.scenario, s.coverageType, s.priority, s.riskArea || '', companyId || null]
    );
    ids.push(r.rows[0].id);
  }
  return ids;
}

export async function getTestScenarios(requirementId: number): Promise<any[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT s.*, 
       (SELECT COUNT(*) FROM generated_test_cases WHERE scenario_id = s.id) as case_count
     FROM generated_test_scenarios s 
     WHERE s.requirement_id = $1 ORDER BY s.priority, s.id`, [requirementId]
  );
  return r.rows;
}

// ---- Generated Test Cases ----
export async function insertTestCases(scenarioId: number, cases: Array<{
  title: string; preconditions: string; steps: string[]; expectedResult: string;
  testData: string; priority: string; severity: string; tags: string[];
  automationReady: boolean; automationComplexity: string; selectorAvailability: string;
}>, companyId?: number): Promise<number[]> {
  const pool = getPool();
  const ids: number[] = [];
  for (const c of cases) {
    const r = await pool.query(
      `INSERT INTO generated_test_cases
         (scenario_id, title, preconditions, steps, expected_result, test_data,
          priority, severity, tags, automation_ready, automation_complexity,
          selector_availability, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [scenarioId, c.title, c.preconditions, JSON.stringify(c.steps),
       c.expectedResult, c.testData, c.priority, c.severity,
       JSON.stringify(c.tags), c.automationReady, c.automationComplexity,
       c.selectorAvailability, companyId || null]
    );
    ids.push(r.rows[0].id);
  }
  return ids;
}

export async function getTestCases(scenarioId: number): Promise<any[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT * FROM generated_test_cases WHERE scenario_id = $1 ORDER BY priority, id`,
    [scenarioId]
  );
  return r.rows;
}

export async function getTestCasesByRequirement(requirementId: number): Promise<any[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT tc.*, ts.scenario, ts.coverage_type
     FROM generated_test_cases tc
     JOIN generated_test_scenarios ts ON tc.scenario_id = ts.id
     WHERE ts.requirement_id = $1
     ORDER BY tc.priority, tc.id`, [requirementId]
  );
  return r.rows;
}

// ---- Application Knowledge ----
export async function upsertApplicationKnowledge(data: {
  module: string; workflow?: string; businessRules?: string;
  dependencies?: string; apis?: string; historicalBugs?: string;
  companyId?: number;
}): Promise<number> {
  const pool = getPool();
  const existing = await pool.query(
    `SELECT id FROM application_knowledge WHERE module = $1 AND COALESCE(company_id, 0) = $2`,
    [data.module, data.companyId || 0]
  );
  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE application_knowledge SET workflow=$1, business_rules=$2, dependencies=$3,
         apis=$4, historical_bugs=$5, updated_at=NOW() WHERE id=$6`,
      [data.workflow || null, data.businessRules || null, data.dependencies || null,
       data.apis || null, data.historicalBugs || null, existing.rows[0].id]
    );
    return existing.rows[0].id;
  }
  const r = await pool.query(
    `INSERT INTO application_knowledge (module, workflow, business_rules, dependencies, apis, historical_bugs, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [data.module, data.workflow || null, data.businessRules || null,
     data.dependencies || null, data.apis || null, data.historicalBugs || null,
     data.companyId || null]
  );
  return r.rows[0].id;
}

export async function getApplicationKnowledge(companyId?: number): Promise<any[]> {
  const pool = getPool();
  const where = companyId ? 'WHERE company_id = $1' : '';
  const params = companyId ? [companyId] : [];
  const r = await pool.query(
    `SELECT * FROM application_knowledge ${where} ORDER BY module`, params
  );
  return r.rows;
}

export async function deleteApplicationKnowledge(id: number): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query('DELETE FROM application_knowledge WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}

// ---- Coverage Stats ----
export async function getTestCoverageStats(companyId?: number): Promise<{
  totalRequirements: number; totalScenarios: number; totalTestCases: number;
  automationReadyCount: number; coverageTypeBreakdown: Record<string, number>;
  priorityBreakdown: Record<string, number>;
}> {
  const pool = getPool();
  const cond = companyId ? 'AND company_id = $1' : '';
  const params = companyId ? [companyId] : [];

  const reqR = await pool.query(`SELECT COUNT(*) as c FROM test_requirements WHERE 1=1 ${cond}`, params);
  const scenR = await pool.query(`SELECT COUNT(*) as c FROM generated_test_scenarios WHERE 1=1 ${cond}`, params);
  const caseR = await pool.query(
    `SELECT COUNT(*) as c, COUNT(*) FILTER (WHERE automation_ready = true) as auto_ready
     FROM generated_test_cases WHERE 1=1 ${cond}`, params
  );

  const coverageR = await pool.query(
    `SELECT coverage_type, COUNT(*) as c FROM generated_test_scenarios WHERE 1=1 ${cond} GROUP BY coverage_type`, params
  );
  const priorityR = await pool.query(
    `SELECT priority, COUNT(*) as c FROM generated_test_cases WHERE 1=1 ${cond} GROUP BY priority`, params
  );

  const coverageTypeBreakdown: Record<string, number> = {};
  coverageR.rows.forEach((r: any) => { coverageTypeBreakdown[r.coverage_type] = parseInt(r.c, 10); });
  const priorityBreakdown: Record<string, number> = {};
  priorityR.rows.forEach((r: any) => { priorityBreakdown[r.priority] = parseInt(r.c, 10); });

  return {
    totalRequirements: parseInt(reqR.rows[0].c, 10),
    totalScenarios: parseInt(scenR.rows[0].c, 10),
    totalTestCases: parseInt(caseR.rows[0].c, 10),
    automationReadyCount: parseInt(caseR.rows[0].auto_ready, 10),
    coverageTypeBreakdown,
    priorityBreakdown,
  };
}

/* ========================================================================== */
/*  ROLES & TEAM MANAGEMENT                                                    */
/* ========================================================================== */

export async function getRoles(): Promise<any[]> {
  const { rows } = await getPool().query(`SELECT * FROM roles ORDER BY id ASC`);
  return rows;
}

export async function getRoleBySlug(slug: string): Promise<any | null> {
  const { rows } = await getPool().query(`SELECT * FROM roles WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

export async function getTeamMembers(companyId: number): Promise<any[]> {
  const { rows } = await getPool().query(
    `SELECT u.id, u.username, u.role, u.is_active, u.last_login, u.created_at,
            r.name as role_name, r.permissions
     FROM users u
     LEFT JOIN roles r ON u.role = r.slug
     WHERE u.company_id = $1
     ORDER BY u.created_at ASC`,
    [companyId]
  );
  return rows;
}

export async function updateUserRole(userId: number, roleSlug: string): Promise<any> {
  const { rows } = await getPool().query(
    `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, role`,
    [roleSlug, userId]
  );
  return rows[0] || null;
}

/* ========================================================================== */
/*  BILLING AUDIT LOGS                                                         */
/* ========================================================================== */

export async function createBillingAuditLog(data: {
  companyId: number; userId?: number; action: string; category?: string;
  severity?: string; target?: string; details?: Record<string, any>;
  ipAddress?: string; userAgent?: string;
}): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, company_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [data.userId || null, data.action, data.category || 'billing', data.target || null,
     JSON.stringify({ ...(data.details || {}), severity: data.severity || 'info', userAgent: data.userAgent }),
     data.ipAddress || null, data.companyId]
  );
  return rows[0].id;
}

export async function getBillingAuditLogs(options: {
  companyId?: number; category?: string; severity?: string;
  search?: string; limit?: number; offset?: number;
}): Promise<{ logs: any[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (options.companyId) { conditions.push(`company_id = $${idx++}`); params.push(options.companyId); }
  if (options.category) { conditions.push(`entity_type = $${idx++}`); params.push(options.category); }
  if (options.severity) { conditions.push(`details->>'severity' = $${idx++}`); params.push(options.severity); }
  if (options.search) { conditions.push(`(action ILIKE $${idx} OR details::text ILIKE $${idx})`); params.push(`%${options.search}%`); idx++; }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  const countResult = await getPool().query(`SELECT COUNT(*)::int as total FROM audit_logs ${where}`, params);
  const total = countResult.rows[0].total;

  const dataParams = [...params, limit, offset];
  const { rows } = await getPool().query(
    `SELECT al.*, u.username
     FROM audit_logs al
     LEFT JOIN users u ON al.user_id = u.id
     ${where}
     ORDER BY al.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    dataParams
  );

  return { logs: rows, total };
}

/* ========================================================================== */
/*  LICENSE CHECK                                                              */
/* ========================================================================== */

interface LicenseCheckResult {
  allowed: boolean;
  reason?: string;
  subscription: any;
  usage: { creditsUsed: number; creditsAllowed: number; creditsRemaining: number };
}

export async function checkLicense(companyId: number, operation: string): Promise<LicenseCheckResult> {
  const sub = await getSubscription(companyId);
  if (!sub) {
    return { allowed: false, reason: 'No active subscription', subscription: null, usage: { creditsUsed: 0, creditsAllowed: 0, creditsRemaining: 0 } };
  }

  const usageSummary = await getUsageSummary(companyId);
  const creditCost = CREDIT_COSTS[operation] ?? 0;

  // Check feature access
  const features = sub.plan_features || {};
  const healingTypes = features.healing_types || ['rule_based'];
  if (['rule_based', 'database_pattern', 'ai_reasoning'].includes(operation) && !healingTypes.includes(operation)) {
    return {
      allowed: false,
      reason: `${operation} not available on ${sub.plan_name} plan`,
      subscription: sub,
      usage: { creditsUsed: usageSummary.totalCreditsUsed, creditsAllowed: usageSummary.creditsAllowed, creditsRemaining: usageSummary.creditsRemaining },
    };
  }

  // Check credits
  if (creditCost > 0 && usageSummary.creditsRemaining < creditCost) {
    return {
      allowed: false,
      reason: `Insufficient credits: need ${creditCost}, have ${usageSummary.creditsRemaining}`,
      subscription: sub,
      usage: { creditsUsed: usageSummary.totalCreditsUsed, creditsAllowed: usageSummary.creditsAllowed, creditsRemaining: usageSummary.creditsRemaining },
    };
  }

  return {
    allowed: true,
    subscription: sub,
    usage: { creditsUsed: usageSummary.totalCreditsUsed, creditsAllowed: usageSummary.creditsAllowed, creditsRemaining: usageSummary.creditsRemaining },
  };
}

/* ========================================================================== */
/*  Repository Intelligence – CRUD                                            */
/* ========================================================================== */

import type { RepositoryProfile, CodeChunk } from '../context/types';

export async function saveRepositoryContext(
  repoId: string,
  profile: RepositoryProfile,
  scanDurationMs: number,
  companyId?: number,
): Promise<number> {
  const p = getPool();
  const cid = companyId ?? null;
  const profileJson = JSON.stringify(profile);

  // Upsert – update if same repo+company exists
  const existing = await p.query(
    `SELECT id, profile_version FROM repository_contexts
     WHERE repo_id = $1 AND COALESCE(company_id, 0) = COALESCE($2, 0)`,
    [repoId, cid],
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const newVersion = (row.profile_version ?? 1) + 1;
    await p.query(
      `UPDATE repository_contexts SET profile=$1, scan_duration_ms=$2,
       profile_version=$3, updated_at=NOW() WHERE id=$4`,
      [profileJson, scanDurationMs, newVersion, row.id],
    );
    return row.id;
  }

  const res = await p.query(
    `INSERT INTO repository_contexts (repo_id, company_id, profile, scan_duration_ms)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [repoId, cid, profileJson, scanDurationMs],
  );
  return res.rows[0].id;
}

export async function getRepositoryContext(
  repoId: string,
  companyId?: number,
): Promise<RepositoryProfile | null> {
  const p = getPool();
  const res = await p.query(
    `SELECT profile FROM repository_contexts
     WHERE repo_id = $1 AND COALESCE(company_id, 0) = COALESCE($2, 0)
     ORDER BY updated_at DESC LIMIT 1`,
    [repoId, companyId ?? null],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0].profile as RepositoryProfile;
}

export async function getRepositoryContextById(
  contextId: number,
): Promise<{ repoId: string; companyId: number | null; profile: RepositoryProfile; version: number } | null> {
  const p = getPool();
  const res = await p.query(`SELECT * FROM repository_contexts WHERE id = $1`, [contextId]);
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    repoId: r.repo_id,
    companyId: r.company_id,
    version: r.profile_version ?? 1,
    profile: r.profile as RepositoryProfile,
  };
}

export async function saveCodeChunks(
  repoContextId: number,
  chunks: CodeChunk[],
): Promise<number> {
  if (chunks.length === 0) return 0;
  const p = getPool();
  // Clear old chunks for this context before inserting fresh ones
  await p.query(`DELETE FROM code_chunks WHERE repo_context_id = $1`, [repoContextId]);

  let inserted = 0;
  const batchSize = 50;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const values: any[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    for (const c of batch) {
      placeholders.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7})`);
      values.push(
        repoContextId, c.filePath, c.chunkType, c.chunkName,
        c.content.substring(0, 10000),
        c.lineStart ?? null, c.lineEnd ?? null,
        JSON.stringify(c.metadata ?? {}),
      );
      idx += 8;
    }
    await p.query(
      `INSERT INTO code_chunks
        (repo_context_id, file_path, chunk_type, chunk_name, content, line_start, line_end, metadata)
       VALUES ${placeholders.join(',')}`,
      values,
    );
    inserted += batch.length;
  }
  return inserted;
}

export async function searchCodeChunks(
  repoContextId: number,
  opts: { type?: string; namePattern?: string; limit?: number },
): Promise<CodeChunk[]> {
  const p = getPool();
  const conditions = ['repo_context_id = $1'];
  const params: any[] = [repoContextId];
  let idx = 2;

  if (opts.type) {
    conditions.push(`chunk_type = $${idx++}`);
    params.push(opts.type);
  }
  if (opts.namePattern) {
    conditions.push(`chunk_name ILIKE $${idx++}`);
    params.push(`%${opts.namePattern}%`);
  }

  const limit = opts.limit ?? 100;
  const res = await p.query(
    `SELECT * FROM code_chunks WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ${limit}`,
    params,
  );
  return res.rows.map((r: any) => ({
    filePath: r.file_path,
    chunkType: r.chunk_type,
    chunkName: r.chunk_name,
    content: r.content,
    lineStart: r.line_start,
    lineEnd: r.line_end,
    metadata: r.metadata ?? {},
  }));
}

export async function listRepositoryContexts(
  companyId?: number,
): Promise<Array<{ id: number; repoId: string; framework: string; testPattern: string; updatedAt: string; version: number }>> {
  const p = getPool();
  const res = companyId
    ? await p.query(
        `SELECT id, repo_id, profile, updated_at, profile_version
         FROM repository_contexts WHERE company_id = $1 ORDER BY updated_at DESC`, [companyId])
    : await p.query(
        `SELECT id, repo_id, profile, updated_at, profile_version
         FROM repository_contexts ORDER BY updated_at DESC`);
  return res.rows.map((r: any) => ({
    id: r.id,
    repoId: r.repo_id,
    framework: r.profile?.framework ?? 'unknown',
    testPattern: r.profile?.testPattern ?? 'unknown',
    updatedAt: r.updated_at,
    version: r.profile_version ?? 1,
  }));
}



/* ========================================================================== */
/*  Knowledge Management — CRUD, Search, Relationships, Stats                 */
/* ========================================================================== */

const KNOWLEDGE_CATEGORIES = [
  'business_rule','workflow','architecture','dependency','integration',
  'automation','manual_test','bug_pattern','domain',
] as const;
type KnowledgeCategory = typeof KNOWLEDGE_CATEGORIES[number];

const KNOWLEDGE_STATUSES = ['draft','active','archived'] as const;
const KNOWLEDGE_PRIORITIES = ['low','medium','high','critical'] as const;
const RELATIONSHIP_TYPES = ['depends_on','related_to','implements','blocks','duplicates'] as const;

// ---- Knowledge Items CRUD ----

export async function createKnowledgeItem(data: {
  companyId?: number; projectId?: number; category: string; title: string; description: string;
  metadata?: any; tags?: string[]; relatedModules?: string[];
  status?: string; priority?: string; createdBy?: string;
}): Promise<any> {
  const pool = getPool();
  const r = await pool.query(
    `INSERT INTO knowledge_items
       (company_id, project_id, category, title, description, metadata, tags, related_modules,
        status, priority, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      data.companyId || null,
      data.projectId || null,
      data.category,
      data.title,
      data.description,
      JSON.stringify(data.metadata || {}),
      data.tags || [],
      data.relatedModules || [],
      data.status || 'active',
      data.priority || 'medium',
      data.createdBy || null,
    ]
  );
  return r.rows[0];
}

export async function updateKnowledgeItem(id: number, companyId: number | undefined, data: {
  category?: string; title?: string; description?: string;
  metadata?: any; tags?: string[]; relatedModules?: string[];
  status?: string; priority?: string;
}): Promise<any | null> {
  const pool = getPool();
  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (data.category !== undefined) { sets.push(`category = $${idx}`); params.push(data.category); idx++; }
  if (data.title !== undefined) { sets.push(`title = $${idx}`); params.push(data.title); idx++; }
  if (data.description !== undefined) { sets.push(`description = $${idx}`); params.push(data.description); idx++; }
  if (data.metadata !== undefined) { sets.push(`metadata = $${idx}`); params.push(JSON.stringify(data.metadata)); idx++; }
  if (data.tags !== undefined) { sets.push(`tags = $${idx}`); params.push(data.tags); idx++; }
  if (data.relatedModules !== undefined) { sets.push(`related_modules = $${idx}`); params.push(data.relatedModules); idx++; }
  if (data.status !== undefined) { sets.push(`status = $${idx}`); params.push(data.status); idx++; }
  if (data.priority !== undefined) { sets.push(`priority = $${idx}`); params.push(data.priority); idx++; }

  if (sets.length === 0) return null;
  sets.push('updated_at = NOW()');

  params.push(id); const idIdx = idx; idx++;
  let where = `id = $${idIdx}`;
  if (companyId) { params.push(companyId); where += ` AND company_id = $${idx}`; }

  const r = await pool.query(
    `UPDATE knowledge_items SET ${sets.join(', ')} WHERE ${where} RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

export async function getKnowledgeItem(id: number, companyId?: number): Promise<any | null> {
  const pool = getPool();
  const params: any[] = [id];
  let where = 'id = $1';
  if (companyId) { params.push(companyId); where += ` AND company_id = $2`; }
  const r = await pool.query(`SELECT * FROM knowledge_items WHERE ${where}`, params);
  return r.rows[0] || null;
}

export async function deleteKnowledgeItem(id: number, companyId?: number): Promise<boolean> {
  const pool = getPool();
  const params: any[] = [id];
  let where = 'id = $1';
  if (companyId) { params.push(companyId); where += ` AND company_id = $2`; }
  const r = await pool.query(`DELETE FROM knowledge_items WHERE ${where}`, params);
  return (r.rowCount ?? 0) > 0;
}

export async function listKnowledgeItems(opts: {
  companyId?: number; projectId?: number; category?: string; status?: string; priority?: string;
  tags?: string[]; module?: string; search?: string;
  limit?: number; offset?: number; sortBy?: string; sortDir?: string;
}): Promise<{ items: any[]; total: number }> {
  const pool = getPool();
  const conds: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (opts.companyId) { conds.push(`company_id = $${idx}`); params.push(opts.companyId); idx++; }
  if (opts.projectId) { conds.push(`COALESCE(project_id, 0) = $${idx}`); params.push(opts.projectId); idx++; }
  if (opts.category) { conds.push(`category = $${idx}`); params.push(opts.category); idx++; }
  if (opts.status) { conds.push(`status = $${idx}`); params.push(opts.status); idx++; }
  if (opts.priority) { conds.push(`priority = $${idx}`); params.push(opts.priority); idx++; }
  if (opts.tags?.length) { conds.push(`tags && $${idx}`); params.push(opts.tags); idx++; }
  if (opts.module) { conds.push(`$${idx} = ANY(related_modules)`); params.push(opts.module); idx++; }
  if (opts.search) {
    conds.push(`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')) @@ plainto_tsquery('english', $${idx})`);
    params.push(opts.search); idx++;
  }

  const whereClause = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

  const allowedSorts: Record<string, string> = {
    created_at: 'created_at', updated_at: 'updated_at', title: 'title',
    category: 'category', priority: 'priority', status: 'status',
  };
  const sortCol = allowedSorts[opts.sortBy || 'updated_at'] || 'updated_at';
  const sortDir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';

  const countR = await pool.query(`SELECT COUNT(*) as c FROM knowledge_items ${whereClause}`, params);
  const total = parseInt(countR.rows[0].c, 10);

  const limit = Math.min(opts.limit || 50, 200);
  const offset = opts.offset || 0;

  params.push(limit); const limIdx = idx; idx++;
  params.push(offset); const offIdx = idx;

  const r = await pool.query(
    `SELECT * FROM knowledge_items ${whereClause}
     ORDER BY ${sortCol} ${sortDir}
     LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );

  return { items: r.rows, total };
}

// ---- Full-text search ----

export async function searchKnowledgeItems(query: string, companyId?: number, limit = 20, projectId?: number): Promise<any[]> {
  const pool = getPool();
  const params: any[] = [query, limit];
  let extraFilter = '';
  let pIdx = 3;
  if (companyId) { params.push(companyId); extraFilter += ` AND company_id = $${pIdx++}`; }
  if (projectId) { params.push(projectId); extraFilter += ` AND COALESCE(project_id, 0) = $${pIdx++}`; }

  const r = await pool.query(
    `SELECT *, ts_rank(
        to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')),
        plainto_tsquery('english', $1)
     ) as rank
     FROM knowledge_items
     WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,''))
           @@ plainto_tsquery('english', $1)
       AND status != 'archived'
       ${extraFilter}
     ORDER BY rank DESC
     LIMIT $2`,
    params
  );
  return r.rows;
}

// ---- Knowledge Statistics ----

export async function getKnowledgeStats(companyId?: number, projectId?: number): Promise<{
  total: number; byCategory: Record<string, number>;
  byStatus: Record<string, number>; byPriority: Record<string, number>;
  recentCount: number; tagCloud: Array<{ tag: string; count: number }>;
}> {
  const pool = getPool();
  const conds: string[] = [];
  const params: any[] = [];
  let idx = 1;
  if (companyId) { conds.push(`company_id = $${idx++}`); params.push(companyId); }
  if (projectId) { conds.push(`COALESCE(project_id, 0) = $${idx++}`); params.push(projectId); }
  const cond = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const totalR = await pool.query(`SELECT COUNT(*) as c FROM knowledge_items ${cond}`, params);
  const total = parseInt(totalR.rows[0].c, 10);

  const catR = await pool.query(
    `SELECT category, COUNT(*) as c FROM knowledge_items ${cond} GROUP BY category ORDER BY c DESC`, params
  );
  const byCategory: Record<string, number> = {};
  catR.rows.forEach((r: any) => { byCategory[r.category] = parseInt(r.c, 10); });

  const statusR = await pool.query(
    `SELECT status, COUNT(*) as c FROM knowledge_items ${cond} GROUP BY status`, params
  );
  const byStatus: Record<string, number> = {};
  statusR.rows.forEach((r: any) => { byStatus[r.status] = parseInt(r.c, 10); });

  const prioR = await pool.query(
    `SELECT priority, COUNT(*) as c FROM knowledge_items ${cond} GROUP BY priority`, params
  );
  const byPriority: Record<string, number> = {};
  prioR.rows.forEach((r: any) => { byPriority[r.priority] = parseInt(r.c, 10); });

  const recentParts = [...conds, `created_at > NOW() - INTERVAL '7 days'`];
  const recentCond = `WHERE ${recentParts.join(' AND ')}`;
  const recentR = await pool.query(`SELECT COUNT(*) as c FROM knowledge_items ${recentCond}`, params);
  const recentCount = parseInt(recentR.rows[0].c, 10);

  // Tag cloud — unnest tags and count
  const tagR = await pool.query(
    `SELECT unnest(tags) as tag, COUNT(*) as c FROM knowledge_items ${cond}
     GROUP BY tag ORDER BY c DESC LIMIT 30`, params
  );
  const tagCloud = tagR.rows.map((r: any) => ({ tag: r.tag, count: parseInt(r.c, 10) }));

  return { total, byCategory, byStatus, byPriority, recentCount, tagCloud };
}

// ---- Get all unique tags ----

export async function getKnowledgeTags(companyId?: number, projectId?: number): Promise<string[]> {
  const pool = getPool();
  const conds: string[] = [];
  const params: any[] = [];
  let idx = 1;
  if (companyId) { conds.push(`company_id = $${idx++}`); params.push(companyId); }
  if (projectId) { conds.push(`COALESCE(project_id, 0) = $${idx++}`); params.push(projectId); }
  const cond = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT DISTINCT unnest(tags) as tag FROM knowledge_items ${cond} ORDER BY tag`, params
  );
  return r.rows.map((row: any) => row.tag);
}

// ---- Get category distribution ----

export async function getKnowledgeCategoryDistribution(companyId?: number, projectId?: number): Promise<Array<{category: string; count: number; active: number}>> {
  const pool = getPool();
  const conds: string[] = [];
  const params: any[] = [];
  let idx = 1;
  if (companyId) { conds.push(`company_id = $${idx++}`); params.push(companyId); }
  if (projectId) { conds.push(`COALESCE(project_id, 0) = $${idx++}`); params.push(projectId); }
  const cond = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT category,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status = 'active') as active
     FROM knowledge_items ${cond}
     GROUP BY category
     ORDER BY total DESC`, params
  );
  return r.rows.map((row: any) => ({
    category: row.category,
    count: parseInt(row.total, 10),
    active: parseInt(row.active, 10),
  }));
}

// ---- Knowledge Relationships ----

export async function createKnowledgeRelationship(data: {
  companyId?: number; sourceKnowledgeId: number; targetKnowledgeId: number;
  relationshipType: string; description?: string;
}): Promise<any> {
  const pool = getPool();
  const r = await pool.query(
    `INSERT INTO knowledge_relationships
       (company_id, source_knowledge_id, target_knowledge_id, relationship_type, description)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (source_knowledge_id, target_knowledge_id, relationship_type) DO UPDATE
       SET description = EXCLUDED.description
     RETURNING *`,
    [data.companyId || null, data.sourceKnowledgeId, data.targetKnowledgeId,
     data.relationshipType, data.description || null]
  );
  return r.rows[0];
}

export async function getKnowledgeRelationships(knowledgeId: number): Promise<any[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT kr.*,
       ks.title as source_title, ks.category as source_category,
       kt.title as target_title, kt.category as target_category
     FROM knowledge_relationships kr
     JOIN knowledge_items ks ON kr.source_knowledge_id = ks.id
     JOIN knowledge_items kt ON kr.target_knowledge_id = kt.id
     WHERE kr.source_knowledge_id = $1 OR kr.target_knowledge_id = $1
     ORDER BY kr.created_at DESC`,
    [knowledgeId]
  );
  return r.rows;
}

export async function deleteKnowledgeRelationship(id: number, companyId?: number): Promise<boolean> {
  const pool = getPool();
  const params: any[] = [id];
  let where = 'id = $1';
  if (companyId) { params.push(companyId); where += ` AND company_id = $2`; }
  const r = await pool.query(`DELETE FROM knowledge_relationships WHERE ${where}`, params);
  return (r.rowCount ?? 0) > 0;
}



/* ------------------------------------------------------------------ */
/*  Knowledge Suggestion for Test Case Lab Integration                 */
/* ------------------------------------------------------------------ */

/**
 * Suggest relevant knowledge items based on module, search term, and/or category.
 * Prioritizes: module match > text relevance > business_rule/workflow categories.
 * Returns top N most relevant items (default 10).
 */
export async function suggestKnowledgeItems(opts: {
  companyId?: number;
  projectId?: number;
  module?: string;
  searchTerm?: string;
  category?: string;
  limit?: number;
}): Promise<any[]> {
  const pool = getPool();
  const limit = opts.limit || 10;
  const params: any[] = [];
  let paramIdx = 0;

  // Build scoring query
  const scoreExprs: string[] = [];
  const conditions: string[] = ['status = \'active\''];

  if (opts.companyId) {
    paramIdx++;
    conditions.push(`company_id = $${paramIdx}`);
    params.push(opts.companyId);
  }

  if (opts.projectId) {
    paramIdx++;
    conditions.push(`COALESCE(project_id, 0) = $${paramIdx}`);
    params.push(opts.projectId);
  }

  if (opts.category) {
    paramIdx++;
    conditions.push(`category = $${paramIdx}`);
    params.push(opts.category);
  }

  // Module matching: exact array match or partial match in title/description
  if (opts.module) {
    paramIdx++;
    params.push(opts.module);
    // Score boost for related_modules array containing the module
    scoreExprs.push(`CASE WHEN $${paramIdx} = ANY(related_modules) THEN 10 ELSE 0 END`);
    // Partial match in title/description
    scoreExprs.push(`CASE WHEN title ILIKE '%' || $${paramIdx} || '%' OR description ILIKE '%' || $${paramIdx} || '%' THEN 3 ELSE 0 END`);
  }

  // Full-text search boost
  if (opts.searchTerm) {
    paramIdx++;
    const tsQuery = opts.searchTerm.trim().split(/\s+/).join(' & ');
    params.push(tsQuery);
    scoreExprs.push(`CASE WHEN to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')) @@ to_tsquery('english', $${paramIdx}) THEN 5 ELSE 0 END`);
  }

  // Category relevance boost (business_rule and workflow are most useful for test gen)
  scoreExprs.push(`CASE WHEN category IN ('business_rule', 'workflow', 'bug_pattern') THEN 2 WHEN category IN ('integration', 'architecture', 'domain') THEN 1 ELSE 0 END`);

  // Priority boost
  scoreExprs.push(`CASE WHEN priority = 'critical' THEN 2 WHEN priority = 'high' THEN 1 ELSE 0 END`);

  const scoreExpr = scoreExprs.length > 0 ? scoreExprs.join(' + ') : '0';

  paramIdx++;
  params.push(limit);

  const sql = `
    SELECT *, (${scoreExpr}) AS relevance_score
    FROM knowledge_items
    WHERE ${conditions.join(' AND ')}
    ORDER BY relevance_score DESC, updated_at DESC
    LIMIT $${paramIdx}
  `;

  const r = await pool.query(sql, params);
  return r.rows;
}



/* -------------------------------------------------------------------------- */
/*  AI Usage Logging & Cost Tracking                                          */
/* -------------------------------------------------------------------------- */

export async function logAiUsage(record: {
  model: string;
  tokensUsed: number;
  costUsd: number;
  feature: string;
  taskType?: string;
  userId?: string;
  metadata?: any;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO ai_usage_logs
       (model, tokens_used, cost_usd, feature, task_type, user_id, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      record.model,
      record.tokensUsed,
      record.costUsd,
      record.feature,
      record.taskType || null,
      record.userId || null,
      record.metadata ? JSON.stringify(record.metadata) : null,
    ],
  );
}

export async function getDailyAiMetrics(): Promise<{
  dailyTokens: number;
  dailyCostUsd: number;
  byFeature: Record<string, { tokens: number; cost: number; requests: number }>;
}> {
  const pool = getPool();

  const totals = await pool.query(
    `SELECT COALESCE(SUM(tokens_used), 0) AS daily_tokens,
            COALESCE(SUM(cost_usd), 0)    AS daily_cost
     FROM ai_usage_logs
     WHERE DATE(created_at) = CURRENT_DATE`,
  );

  const features = await pool.query(
    `SELECT feature,
            SUM(tokens_used)::int AS tokens,
            SUM(cost_usd)         AS cost,
            COUNT(*)::int         AS requests
     FROM ai_usage_logs
     WHERE DATE(created_at) = CURRENT_DATE
     GROUP BY feature
     ORDER BY cost DESC`,
  );

  const byFeature: Record<string, { tokens: number; cost: number; requests: number }> = {};
  for (const r of features.rows) {
    byFeature[r.feature] = {
      tokens: parseInt(r.tokens, 10),
      cost: parseFloat(r.cost),
      requests: parseInt(r.requests, 10),
    };
  }

  return {
    dailyTokens: parseInt(totals.rows[0]?.daily_tokens ?? '0', 10),
    dailyCostUsd: parseFloat(totals.rows[0]?.daily_cost ?? '0'),
    byFeature,
  };
}

export async function getAiUsageByModel(): Promise<
  Array<{ model: string; requests: number; tokens: number; costUsd: number }>
> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT model,
            COUNT(*)::int          AS requests,
            SUM(tokens_used)::int  AS tokens,
            SUM(cost_usd)          AS cost_usd
     FROM ai_usage_logs
     GROUP BY model
     ORDER BY cost_usd DESC`,
  );
  return r.rows.map((row: any) => ({
    model: row.model,
    requests: parseInt(row.requests, 10),
    tokens: parseInt(row.tokens, 10),
    costUsd: parseFloat(row.cost_usd),
  }));
}

export async function getAiUsageByFeature(): Promise<
  Array<{ feature: string; requests: number; tokens: number; costUsd: number }>
> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT feature,
            COUNT(*)::int          AS requests,
            SUM(tokens_used)::int  AS tokens,
            SUM(cost_usd)          AS cost_usd
     FROM ai_usage_logs
     WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)
     GROUP BY feature
     ORDER BY cost_usd DESC`,
  );
  return r.rows.map((row: any) => ({
    feature: row.feature,
    requests: parseInt(row.requests, 10),
    tokens: parseInt(row.tokens, 10),
    costUsd: parseFloat(row.cost_usd),
  }));
}

export async function getAiCostTrend(days: number = 30): Promise<
  Array<{ date: string; tokens: number; costUsd: number; requests: number }>
> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT DATE(created_at)::text   AS date,
            SUM(tokens_used)::int    AS tokens,
            SUM(cost_usd)            AS cost_usd,
            COUNT(*)::int            AS requests
     FROM ai_usage_logs
     WHERE created_at >= CURRENT_DATE - ($1 || ' days')::interval
     GROUP BY DATE(created_at)
     ORDER BY date DESC`,
    [days],
  );
  return r.rows.map((row: any) => ({
    date: row.date,
    tokens: parseInt(row.tokens, 10),
    costUsd: parseFloat(row.cost_usd),
    requests: parseInt(row.requests, 10),
  }));
}

export async function getDailyBudgetStatus(maxDailyCostUsd: number = 5.0): Promise<{
  date: string;
  totalCostUsd: number;
  budgetRemaining: number;
  isOverBudget: boolean;
  percentUsed: number;
}> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT CURRENT_DATE::text              AS date,
            COALESCE(SUM(cost_usd), 0)      AS total_cost
     FROM ai_usage_logs
     WHERE DATE(created_at) = CURRENT_DATE`,
  );
  const totalCostUsd = parseFloat(r.rows[0]?.total_cost ?? '0');
  return {
    date: r.rows[0]?.date ?? new Date().toISOString().slice(0, 10),
    totalCostUsd,
    budgetRemaining: maxDailyCostUsd - totalCostUsd,
    isOverBudget: totalCostUsd >= maxDailyCostUsd,
    percentUsed: maxDailyCostUsd > 0 ? Math.round((totalCostUsd / maxDailyCostUsd) * 10000) / 100 : 0,
  };
}



/* -------------------------------------------------------------------------- */
/*  Projects & Repositories CRUD                                              */
/* -------------------------------------------------------------------------- */

export async function createProject(data: {
  company_id: number;
  name: string;
  description?: string;
}): Promise<any> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO projects (company_id, name, description)
     VALUES ($1, $2, $3) RETURNING *`,
    [data.company_id, data.name, data.description || null],
  );
  return rows[0];
}

export async function listProjects(companyId: number): Promise<any[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT p.*,
            (SELECT COUNT(*) FROM repositories r WHERE r.project_id = p.id AND r.is_active = true) AS repo_count
     FROM projects p
     WHERE p.company_id = $1 AND p.is_active = true
     ORDER BY p.created_at DESC`,
    [companyId],
  );
  return rows;
}

export async function getProject(id: number, companyId: number): Promise<any | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM projects WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return rows[0] || null;
}

export async function updateProject(id: number, companyId: number, data: {
  name?: string;
  description?: string;
  release_cycle_type?: string;
  release_cycle_days?: number;
  release_day_of_week?: number | null;
  release_timezone?: string;
  overview_default_range?: string;
}): Promise<any | null> {
  const pool = getPool();
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;
  if (data.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(data.name); }
  if (data.description !== undefined) { sets.push(`description = $${idx++}`); vals.push(data.description); }
  if (data.release_cycle_type !== undefined) { sets.push(`release_cycle_type = $${idx++}`); vals.push(data.release_cycle_type); }
  if (data.release_cycle_days !== undefined) { sets.push(`release_cycle_days = $${idx++}`); vals.push(data.release_cycle_days); }
  if (data.release_day_of_week !== undefined) { sets.push(`release_day_of_week = $${idx++}`); vals.push(data.release_day_of_week); }
  if (data.release_timezone !== undefined) { sets.push(`release_timezone = $${idx++}`); vals.push(data.release_timezone); }
  if (data.overview_default_range !== undefined) { sets.push(`overview_default_range = $${idx++}`); vals.push(data.overview_default_range); }
  if (sets.length === 0) return getProject(id, companyId);
  sets.push(`updated_at = NOW()`);
  vals.push(id, companyId);
  const { rows } = await pool.query(
    `UPDATE projects SET ${sets.join(', ')} WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
    vals,
  );
  return rows[0] || null;
}

export async function deleteProject(id: number, companyId: number): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE projects SET is_active = false, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return (rowCount ?? 0) > 0;
}

export async function addRepository(data: {
  project_id: number;
  company_id: number;
  name: string;
  url: string;
  branch?: string;
  type?: string;
}): Promise<any> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO repositories (project_id, company_id, name, url, branch, type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [data.project_id, data.company_id, data.name, data.url, data.branch || 'main', data.type || 'web'],
  );
  return rows[0];
}

export async function listRepositories(projectId: number, companyId: number): Promise<any[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM repositories WHERE project_id = $1 AND company_id = $2 AND is_active = true ORDER BY created_at DESC`,
    [projectId, companyId],
  );
  return rows;
}

export async function listAllRepositories(companyId: number): Promise<any[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT r.*, p.name as project_name
     FROM repositories r
     JOIN projects p ON p.id = r.project_id
     WHERE r.company_id = $1 AND r.is_active = true AND p.is_active = true
     ORDER BY p.name, r.name`,
    [companyId],
  );
  return rows;
}

export async function getRepository(id: number, companyId: number): Promise<any | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM repositories WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return rows[0] || null;
}

export async function updateRepository(id: number, companyId: number, data: {
  name?: string;
  url?: string;
  branch?: string;
  type?: string;
}): Promise<any | null> {
  const pool = getPool();
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;
  if (data.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(data.name); }
  if (data.url !== undefined) { sets.push(`url = $${idx++}`); vals.push(data.url); }
  if (data.branch !== undefined) { sets.push(`branch = $${idx++}`); vals.push(data.branch); }
  if (data.type !== undefined) { sets.push(`type = $${idx++}`); vals.push(data.type); }
  if (sets.length === 0) return getRepository(id, companyId);
  sets.push(`updated_at = NOW()`);
  vals.push(id, companyId);
  const { rows } = await pool.query(
    `UPDATE repositories SET ${sets.join(', ')} WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
    vals,
  );
  return rows[0] || null;
}

export async function deleteRepository(id: number, companyId: number): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE repositories SET is_active = false, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return (rowCount ?? 0) > 0;
}



// ─── Webhook Configs ──────────────────────────────────────────────────────────

export async function createWebhookConfig(data: {
  projectId: number;
  companyId: number;
  repositoryId?: number;
  webhookSecret: string;
}): Promise<any> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO webhook_configs (project_id, company_id, repository_id, webhook_secret)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT uq_wh_project_repo
     DO UPDATE SET webhook_secret = $4, is_active = true, updated_at = NOW()
     RETURNING *`,
    [data.projectId, data.companyId, data.repositoryId || null, data.webhookSecret],
  );
  return rows[0];
}

export async function getWebhookConfig(projectId: number, companyId: number): Promise<any | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT wc.*, r.url as repository_url, r.name as repository_name, r.branch as repository_branch
     FROM webhook_configs wc
     LEFT JOIN repositories r ON r.id = wc.repository_id
     WHERE wc.project_id = $1 AND wc.company_id = $2 AND wc.is_active = true
     ORDER BY wc.created_at DESC LIMIT 1`,
    [projectId, companyId],
  );
  return rows[0] || null;
}

export async function getWebhookConfigBySecret(secret: string): Promise<any | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT wc.*, r.url as repository_url, r.name as repository_name, r.branch as repository_branch,
            p.name as project_name, c.name as company_name
     FROM webhook_configs wc
     LEFT JOIN repositories r ON r.id = wc.repository_id
     LEFT JOIN projects p ON p.id = wc.project_id
     LEFT JOIN companies c ON c.id = wc.company_id
     WHERE wc.webhook_secret = $1 AND wc.is_active = true`,
    [secret],
  );
  return rows[0] || null;
}

export async function findWebhookConfigByRepoUrl(repoUrl: string): Promise<any | null> {
  const pool = getPool();
  // Match by repository URL (strip .git suffix for comparison)
  const normalizedUrl = repoUrl.replace(/\.git$/, '');
  const { rows } = await pool.query(
    `SELECT wc.*, r.url as repository_url, r.name as repository_name, r.branch as repository_branch,
            p.name as project_name, c.name as company_name
     FROM webhook_configs wc
     JOIN repositories r ON r.id = wc.repository_id
     LEFT JOIN projects p ON p.id = wc.project_id
     LEFT JOIN companies c ON c.id = wc.company_id
     WHERE wc.is_active = true
       AND (r.url = $1 OR r.url = $2 OR REPLACE(r.url, '.git', '') = $1)
     ORDER BY wc.created_at DESC LIMIT 1`,
    [normalizedUrl, normalizedUrl + '.git'],
  );
  return rows[0] || null;
}

export async function incrementWebhookEventCount(configId: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE webhook_configs SET events_received = events_received + 1, last_event_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [configId],
  );
}

export async function logWebhookEvent(data: {
  webhookConfigId?: number;
  companyId: number;
  eventType: string;
  action?: string;
  repoUrl?: string;
  branch?: string;
  commitSha?: string;
  workflowName?: string;
  workflowConclusion?: string;
  testFailures?: any;
  healingJobId?: string;
  payloadSummary?: any;
  status?: string;
}): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO webhook_events
     (webhook_config_id, company_id, event_type, action, repo_url, branch, commit_sha,
      workflow_name, workflow_conclusion, test_failures, healing_job_id, payload_summary, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      data.webhookConfigId || null,
      data.companyId,
      data.eventType,
      data.action || null,
      data.repoUrl || null,
      data.branch || null,
      data.commitSha || null,
      data.workflowName || null,
      data.workflowConclusion || null,
      data.testFailures ? JSON.stringify(data.testFailures) : null,
      data.healingJobId || null,
      data.payloadSummary ? JSON.stringify(data.payloadSummary) : null,
      data.status || 'received',
    ],
  );
  return rows[0].id;
}

export async function updateWebhookEventStatus(eventId: number, status: string, healingJobId?: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE webhook_events SET status = $2, healing_job_id = COALESCE($3, healing_job_id), processed_at = NOW() WHERE id = $1`,
    [eventId, status, healingJobId || null],
  );
}

export async function getWebhookEvents(companyId: number, limit = 50): Promise<any[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM webhook_events WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [companyId, limit],
  );
  return rows;
}



/* ───────────────────────────────────────────────────────────────────────────
   DOM Memory / Selector History helpers
   (consumed by src/services/dom-memory-query.ts)
   ─────────────────────────────────────────────────────────────────────────── */

export async function getSelectorHistory(
  selector: string,
  projectId?: number,
): Promise<{
  stabilityScore: number;
  changeCount: number;
  recentChanges: number;
  firstSeen: string | null;
  lastSeen: string | null;
  observations: number;
}> {
  const pool = getPool();
  const conditions = ['selector = $1'];
  const params: any[] = [selector];
  if (projectId) {
    conditions.push(`project_id = $${params.length + 1}`);
    params.push(projectId);
  }
  const where = conditions.join(' AND ');

  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int                              AS observations,
       MIN(captured_at)                           AS first_seen,
       MAX(captured_at)                           AS last_seen,
       COUNT(DISTINCT change_type) FILTER (WHERE change_type <> 'observed')::int AS change_count,
       COUNT(*) FILTER (WHERE captured_at > NOW() - INTERVAL '7 days')::int       AS recent_changes,
       COALESCE(AVG(stability_score), 1.0)::real  AS stability_score
     FROM selector_history
     WHERE ${where}`,
    params,
  );

  const row = rows[0] || {};
  return {
    stabilityScore: row.stability_score ?? 1.0,
    changeCount: row.change_count ?? 0,
    recentChanges: row.recent_changes ?? 0,
    firstSeen: row.first_seen ?? null,
    lastSeen: row.last_seen ?? null,
    observations: row.observations ?? 0,
  };
}

export async function getAlternativeSelectors(
  failedSelector: string,
  projectId?: number,
  companyId?: number,
): Promise<
  Array<{
    selector: string;
    source: string;
    score: number;
    stabilityScore: number;
    lastSeen: string | null;
    usageCount: number;
  }>
> {
  const pool = getPool();
  const conditions = ['element_identifier IN (SELECT element_identifier FROM selector_history WHERE selector = $1)'];
  const params: any[] = [failedSelector];

  if (projectId) {
    conditions.push(`project_id = $${params.length + 1}`);
    params.push(projectId);
  }
  if (companyId) {
    conditions.push(`company_id = $${params.length + 1}`);
    params.push(companyId);
  }
  conditions.push('selector <> $1');  // exclude the failed selector itself

  const where = conditions.join(' AND ');

  const { rows } = await pool.query(
    `SELECT
       selector,
       COALESCE(source, 'observed')                   AS source,
       COALESCE(AVG(stability_score), 0.5)::real       AS stability_score,
       COALESCE(AVG(stability_score), 0.5)::real       AS score,
       MAX(captured_at)                                AS last_seen,
       COUNT(*)::int                                   AS usage_count
     FROM selector_history
     WHERE ${where}
     GROUP BY selector, source
     ORDER BY stability_score DESC
     LIMIT 20`,
    params,
  );

  return rows.map((r: any) => ({
    selector: r.selector,
    source: r.source,
    score: r.score,
    stabilityScore: r.stability_score,
    lastSeen: r.last_seen,
    usageCount: r.usage_count,
  }));
}

export async function recordSelectorObservation(data: {
  projectId?: number;
  companyId?: number;
  pageUrl?: string;
  selector: string;
  previousSelector?: string;
  elementType?: string;
  changeType?: string;
  source?: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO selector_history
       (project_id, company_id, page_url, selector, previous_selector,
        element_type, change_type, source, stability_score, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1.0, $9)`,
    [
      data.projectId ?? null,
      data.companyId ?? null,
      data.pageUrl ?? null,
      data.selector,
      data.previousSelector ?? null,
      data.elementType ?? null,
      data.changeType ?? 'observed',
      data.source ?? 'scan',
      JSON.stringify(data.metadata ?? {}),
    ],
  );
}



/* ───────────────────────────────────────────────────────────────────────────
   Release Windows CRUD
   ─────────────────────────────────────────────────────────────────────────── */

export async function createReleaseWindow(data: {
  projectId: number;
  companyId: number;
  name: string;
  startDate: string;
  endDate: string;
  status?: string;
}): Promise<any> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO release_windows (project_id, company_id, name, start_date, end_date, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [data.projectId, data.companyId, data.name, data.startDate, data.endDate, data.status || 'planned'],
  );
  return rows[0];
}

export async function listReleaseWindows(projectId: number, companyId: number): Promise<any[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM release_windows
     WHERE project_id = $1 AND company_id = $2
     ORDER BY start_date DESC`,
    [projectId, companyId],
  );
  return rows;
}

export async function updateReleaseWindow(id: number, companyId: number, data: {
  name?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
}): Promise<any | null> {
  const pool = getPool();
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;
  if (data.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(data.name); }
  if (data.startDate !== undefined) { sets.push(`start_date = $${idx++}`); vals.push(data.startDate); }
  if (data.endDate !== undefined) { sets.push(`end_date = $${idx++}`); vals.push(data.endDate); }
  if (data.status !== undefined) { sets.push(`status = $${idx++}`); vals.push(data.status); }
  if (sets.length === 0) return null;
  sets.push(`updated_at = NOW()`);
  vals.push(id, companyId);
  const { rows } = await pool.query(
    `UPDATE release_windows SET ${sets.join(', ')} WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
    vals,
  );
  return rows[0] || null;
}

export async function deleteReleaseWindow(id: number, companyId: number): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM release_windows WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return (rowCount ?? 0) > 0;
}



/* -------------------------------------------------------------------------- */
/*  Application Intelligence — Profile CRUD                                   */
/* -------------------------------------------------------------------------- */

export interface ApplicationProfile {
  id: string;
  base_url: string;
  app_fingerprint: string | null;
  crawl_data: any;
  auth_required: boolean;
  auth_config: any | null;
  crawled_at: string;
  expires_at: string;
  page_count: number;
  total_elements: number;
  total_forms: number;
  total_interactive: number;
  status: 'fresh' | 'expiring' | 'expired' | 'crawling' | 'error';
  error_message: string | null;
  company_id: number | null;
  created_at: string;
  updated_at: string;
}

export async function getProfileByUrl(baseUrl: string, companyId?: number, projectId?: number): Promise<ApplicationProfile | null> {
  const pool = getPool();
  if (projectId) {
    const { rows } = await pool.query(
      `SELECT * FROM application_profiles
       WHERE base_url = $1 AND COALESCE(company_id, 0) = COALESCE($2, 0)
         AND COALESCE(project_id, 0) = $3
       LIMIT 1`,
      [baseUrl, companyId ?? null, projectId],
    );
    if (rows[0]) return rows[0];
  }
  // Fallback: company-level lookup (backward compat)
  const { rows } = await pool.query(
    `SELECT * FROM application_profiles
     WHERE base_url = $1 AND COALESCE(company_id, 0) = COALESCE($2, 0)
     LIMIT 1`,
    [baseUrl, companyId ?? null],
  );
  return rows[0] || null;
}

export async function getProfileById(id: string): Promise<ApplicationProfile | null> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT * FROM application_profiles WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function listProfiles(companyId?: number, opts?: { status?: string; limit?: number; offset?: number; projectId?: number }): Promise<{ profiles: ApplicationProfile[]; total: number }> {
  const pool = getPool();
  const conditions: string[] = [];
  const vals: any[] = [];
  let idx = 1;

  if (companyId !== undefined) {
    conditions.push(`COALESCE(company_id, 0) = $${idx++}`);
    vals.push(companyId ?? 0);
  }
  if (opts?.projectId) {
    conditions.push(`COALESCE(project_id, 0) = $${idx++}`);
    vals.push(opts.projectId);
  }
  if (opts?.status) {
    conditions.push(`status = $${idx++}`);
    vals.push(opts.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts?.limit || 50;
  const offset = opts?.offset || 0;

  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT * FROM application_profiles ${where} ORDER BY crawled_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...vals, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM application_profiles ${where}`,
      vals,
    ),
  ]);

  return { profiles: dataRes.rows, total: countRes.rows[0]?.total || 0 };
}

export async function upsertProfile(data: {
  baseUrl: string;
  appFingerprint?: string;
  crawlData: any;
  authRequired?: boolean;
  authConfig?: any;
  pageCount?: number;
  totalElements?: number;
  totalForms?: number;
  totalInteractive?: number;
  status?: string;
  errorMessage?: string;
  ttlDays?: number;
  projectId?: number;
}, companyId?: number): Promise<ApplicationProfile> {
  const pool = getPool();
  const ttl = data.ttlDays || 30;
  const { rows } = await pool.query(
    `INSERT INTO application_profiles
       (base_url, app_fingerprint, crawl_data, auth_required, auth_config,
        crawled_at, expires_at, page_count, total_elements, total_forms,
        total_interactive, status, error_message, company_id, project_id)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + ($6 || ' days')::INTERVAL,
             $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (base_url, COALESCE(company_id, 0)) DO UPDATE SET
       app_fingerprint = EXCLUDED.app_fingerprint,
       crawl_data = EXCLUDED.crawl_data,
       auth_required = EXCLUDED.auth_required,
       auth_config = EXCLUDED.auth_config,
       crawled_at = NOW(),
       expires_at = NOW() + ($6 || ' days')::INTERVAL,
       page_count = EXCLUDED.page_count,
       total_elements = EXCLUDED.total_elements,
       total_forms = EXCLUDED.total_forms,
       total_interactive = EXCLUDED.total_interactive,
       status = EXCLUDED.status,
       error_message = EXCLUDED.error_message,
       project_id = COALESCE(EXCLUDED.project_id, application_profiles.project_id),
       updated_at = NOW()
     RETURNING *`,
    [
      data.baseUrl,
      data.appFingerprint || null,
      JSON.stringify(data.crawlData),
      data.authRequired ?? false,
      data.authConfig ? JSON.stringify(data.authConfig) : null,
      String(ttl),
      data.pageCount ?? 0,
      data.totalElements ?? 0,
      data.totalForms ?? 0,
      data.totalInteractive ?? 0,
      data.status || 'fresh',
      data.errorMessage || null,
      companyId ?? null,
      data.projectId ?? null,
    ],
  );
  return rows[0];
}

export async function updateProfileStatus(id: string, status: string, errorMessage?: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE application_profiles SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3`,
    [status, errorMessage || null, id],
  );
}

export async function deleteProfile(id: string, companyId?: number): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM application_profiles WHERE id = $1 AND COALESCE(company_id, 0) = COALESCE($2, 0)`,
    [id, companyId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

export async function invalidateProfile(baseUrl: string, companyId?: number, projectId?: number): Promise<void> {
  const pool = getPool();
  if (projectId) {
    await pool.query(
      `UPDATE application_profiles SET status = 'expired', updated_at = NOW()
       WHERE base_url = $1 AND COALESCE(company_id, 0) = COALESCE($2, 0) AND COALESCE(project_id, 0) = $3`,
      [baseUrl, companyId ?? null, projectId],
    );
  } else {
    await pool.query(
      `UPDATE application_profiles SET status = 'expired', updated_at = NOW()
       WHERE base_url = $1 AND COALESCE(company_id, 0) = COALESCE($2, 0)`,
      [baseUrl, companyId ?? null],
    );
  }
}

export async function refreshExpiredProfiles(): Promise<number> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE application_profiles SET status = 'expired', updated_at = NOW()
     WHERE status = 'fresh' AND expires_at < NOW()`,
  );
  return rowCount ?? 0;
}

/* -------------------------------------------------------------------------- */
/*  Application Intelligence — Page Snapshots CRUD                            */
/* -------------------------------------------------------------------------- */

export async function upsertPageSnapshot(data: {
  profileId: string;
  pageUrl: string;
  pageTitle?: string;
  pageType?: string;
  domStructure?: any;
  selectors?: any;
  elementsCount?: number;
  formsCount?: number;
  interactiveCount?: number;
  screenshotKey?: string;
}): Promise<any> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO page_snapshots
       (profile_id, page_url, page_title, page_type, dom_structure, selectors,
        elements_count, forms_count, interactive_count, screenshot_key, crawled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      data.profileId,
      data.pageUrl,
      data.pageTitle || null,
      data.pageType || null,
      JSON.stringify(data.domStructure || {}),
      JSON.stringify(data.selectors || {}),
      data.elementsCount ?? 0,
      data.formsCount ?? 0,
      data.interactiveCount ?? 0,
      data.screenshotKey || null,
    ],
  );
  return rows[0];
}

export async function getPageSnapshots(profileId: string): Promise<any[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM page_snapshots WHERE profile_id = $1 ORDER BY crawled_at DESC`,
    [profileId],
  );
  return rows;
}

export async function deletePageSnapshots(profileId: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM page_snapshots WHERE profile_id = $1`, [profileId]);
}

/* -------------------------------------------------------------------------- */
/*  Application Intelligence — Selector Patterns CRUD                         */
/* -------------------------------------------------------------------------- */

export async function upsertSelectorPattern(data: {
  patternType: string;
  patternName?: string;
  selectors: any;
  elementSignatures?: any;
  confidenceScore?: number;
  projectId?: number;
  isShared?: boolean;
}, companyId?: number): Promise<any> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO selector_patterns
       (pattern_type, pattern_name, selectors, element_signatures, confidence_score, company_id, project_id, is_shared)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.patternType,
      data.patternName || null,
      JSON.stringify(data.selectors),
      JSON.stringify(data.elementSignatures || {}),
      data.confidenceScore ?? 0.5,
      companyId ?? null,
      data.projectId ?? null,
      data.isShared ?? false,
    ],
  );
  return rows[0];
}

export async function findMatchingPatterns(patternType: string, companyId?: number, projectId?: number): Promise<any[]> {
  const pool = getPool();
  // Project-scoped patterns + shared patterns within the same company
  if (projectId) {
    const { rows } = await pool.query(
      `SELECT * FROM selector_patterns
       WHERE pattern_type = $1
         AND (company_id IS NULL OR COALESCE(company_id, 0) = COALESCE($2, 0))
         AND (COALESCE(project_id, 0) = $3 OR is_shared = true)
       ORDER BY confidence_score DESC, success_rate DESC
       LIMIT 10`,
      [patternType, companyId ?? null, projectId],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT * FROM selector_patterns
     WHERE pattern_type = $1 AND (company_id IS NULL OR COALESCE(company_id, 0) = COALESCE($2, 0))
     ORDER BY confidence_score DESC, success_rate DESC
     LIMIT 10`,
    [patternType, companyId ?? null],
  );
  return rows;
}

export async function incrementPatternUsage(id: string, success: boolean): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE selector_patterns SET
       usage_count = usage_count + 1,
       success_rate = CASE
         WHEN $2 THEN (success_rate * usage_count + 1.0) / (usage_count + 1)
         ELSE (success_rate * usage_count) / (usage_count + 1)
       END,
       last_used_at = NOW(),
       updated_at = NOW()
     WHERE id = $1`,
    [id, success],
  );
}



/* -------------------------------------------------------------------------- */
/*  Multi-Project Isolation — Migration & Validation                          */
/* -------------------------------------------------------------------------- */

/**
 * Migrate existing data to default project.
 * For each company, finds or creates a "Default Project" and assigns all
 * orphaned records (project_id IS NULL) to it.
 */
export async function migrateDataToDefaultProjects(): Promise<{
  companiesProcessed: number;
  profilesMigrated: number;
  patternsMigrated: number;
}> {
  const pool = getPool();
  let companiesProcessed = 0;
  let profilesMigrated = 0;
  let patternsMigrated = 0;

  // Find all companies that have orphaned intelligence data
  const { rows: companies } = await pool.query(
    `SELECT DISTINCT COALESCE(company_id, 1) AS cid FROM application_profiles WHERE project_id IS NULL
     UNION
     SELECT DISTINCT COALESCE(company_id, 1) AS cid FROM selector_patterns WHERE project_id IS NULL`,
  );

  for (const row of companies) {
    const companyId = row.cid;

    // Find or create default project for this company
    const { rows: existing } = await pool.query(
      `SELECT id FROM projects WHERE company_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [companyId],
    );

    let projectId: number;
    if (existing.length > 0) {
      projectId = existing[0].id;
    } else {
      const { rows: created } = await pool.query(
        `INSERT INTO projects (company_id, name, description)
         VALUES ($1, 'Default Project', 'Auto-created during migration')
         ON CONFLICT (company_id, name) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [companyId],
      );
      projectId = created[0].id;
    }

    // Migrate application_profiles
    const r1 = await pool.query(
      `UPDATE application_profiles SET project_id = $1 WHERE COALESCE(company_id, 1) = $2 AND project_id IS NULL`,
      [projectId, companyId],
    );
    profilesMigrated += r1.rowCount ?? 0;

    // Migrate page_snapshots via their profile
    await pool.query(
      `UPDATE page_snapshots SET project_id = $1
       WHERE project_id IS NULL AND profile_id IN (
         SELECT id FROM application_profiles WHERE COALESCE(company_id, 1) = $2
       )`,
      [projectId, companyId],
    );

    // Migrate selector_patterns
    const r2 = await pool.query(
      `UPDATE selector_patterns SET project_id = $1 WHERE COALESCE(company_id, 1) = $2 AND project_id IS NULL`,
      [projectId, companyId],
    );
    patternsMigrated += r2.rowCount ?? 0;

    companiesProcessed++;
  }

  return { companiesProcessed, profilesMigrated, patternsMigrated };
}

/**
 * Validate that a project exists and belongs to the given company.
 * Returns the project row or null.
 */
export async function validateProjectAccess(projectId: number, companyId: number): Promise<any | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM projects WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [projectId, companyId],
  );
  return rows[0] || null;
}

/**
 * Get project summary stats (profiles, patterns, repos, scripts count).
 */
export async function getProjectStats(projectId: number, companyId: number): Promise<{
  profileCount: number;
  patternCount: number;
  repoCount: number;
  scriptCount: number;
}> {
  const pool = getPool();
  const [profiles, patterns, repos, scripts] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c FROM application_profiles WHERE project_id = $1 AND COALESCE(company_id, 0) = $2`, [projectId, companyId]),
    pool.query(`SELECT COUNT(*)::int AS c FROM selector_patterns WHERE project_id = $1 AND COALESCE(company_id, 0) = $2`, [projectId, companyId]),
    pool.query(`SELECT COUNT(*)::int AS c FROM repositories WHERE project_id = $1 AND company_id = $2`, [projectId, companyId]),
    pool.query(`SELECT COUNT(*)::int AS c FROM generated_scripts WHERE project_id = $1 AND COALESCE(company_id, 0) = $2`, [projectId, companyId]),
  ]);
  return {
    profileCount: profiles.rows[0]?.c || 0,
    patternCount: patterns.rows[0]?.c || 0,
    repoCount: repos.rows[0]?.c || 0,
    scriptCount: scripts.rows[0]?.c || 0,
  };
}
