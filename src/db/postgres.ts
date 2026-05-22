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

export async function initDb(): Promise<void> {
  const client = await getPool().connect();
  try {
    await initSchema(client);
    logger.info(MOD, 'PostgreSQL schema initialized');
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

async function initSchema(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS test_executions (
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
    );

    CREATE TABLE IF NOT EXISTS healing_actions (
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
    );

    CREATE TABLE IF NOT EXISTS learned_patterns (
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
    );

    CREATE TABLE IF NOT EXISTS healing_jobs (
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
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      engine TEXT NOT NULL,
      tokens_used INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rca_analyses (
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
    );

    CREATE INDEX IF NOT EXISTS idx_exec_status ON test_executions(status);
    CREATE INDEX IF NOT EXISTS idx_exec_test_name ON test_executions(test_name);
    CREATE INDEX IF NOT EXISTS idx_heal_exec_id ON healing_actions(test_execution_id);
    CREATE INDEX IF NOT EXISTS idx_heal_strategy ON healing_actions(healing_strategy);
    CREATE INDEX IF NOT EXISTS idx_pattern_locator ON learned_patterns(failed_locator);
    CREATE INDEX IF NOT EXISTS idx_pattern_test_name ON learned_patterns(test_name);
    CREATE INDEX IF NOT EXISTS idx_pattern_error ON learned_patterns(error_pattern);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON healing_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(date);
    CREATE INDEX IF NOT EXISTS idx_rca_test_name ON rca_analyses(test_name);
    CREATE INDEX IF NOT EXISTS idx_rca_classification ON rca_analyses(classification);
    CREATE INDEX IF NOT EXISTS idx_rca_job_id ON rca_analyses(job_id);
    CREATE INDEX IF NOT EXISTS idx_rca_exec_id ON rca_analyses(test_execution_id);

    CREATE TABLE IF NOT EXISTS pr_automations (
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
    );
    CREATE INDEX IF NOT EXISTS idx_pr_job_id ON pr_automations(job_id);
    CREATE INDEX IF NOT EXISTS idx_pr_status ON pr_automations(status);

    -- Script Generation tables
    CREATE TABLE IF NOT EXISTS generated_scripts (
      id SERIAL PRIMARY KEY,
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
    );
    CREATE INDEX IF NOT EXISTS idx_gs_url ON generated_scripts(url);
    CREATE INDEX IF NOT EXISTS idx_gs_created ON generated_scripts(created_at DESC);

    CREATE TABLE IF NOT EXISTS dom_snapshots (
      id SERIAL PRIMARY KEY,
      script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
      page_url TEXT NOT NULL,
      html_snapshot TEXT,
      elements_count INTEGER DEFAULT 0,
      page_type TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dom_script ON dom_snapshots(script_id);

    CREATE TABLE IF NOT EXISTS selector_scores (
      id SERIAL PRIMARY KEY,
      script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
      selector TEXT NOT NULL,
      score REAL DEFAULT 0,
      strategy TEXT,
      element_type TEXT,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sel_script ON selector_scores(script_id);

    CREATE TABLE IF NOT EXISTS workflow_maps (
      id SERIAL PRIMARY KEY,
      script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
      source_page TEXT,
      target_page TEXT,
      action TEXT,
      link_text TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wf_script ON workflow_maps(script_id);

    CREATE TABLE IF NOT EXISTS generated_projects (
      id SERIAL PRIMARY KEY,
      script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
      project_dir TEXT,
      file_count INTEGER DEFAULT 0,
      total_size INTEGER DEFAULT 0,
      structure JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_gp_script ON generated_projects(script_id);

    -- Authentication tables
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(50) DEFAULT 'client',
      company_name VARCHAR(255),
      is_active BOOLEAN DEFAULT true,
      last_login TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

    CREATE TABLE IF NOT EXISTS audit_logs (
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
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      ip_address VARCHAR(45),
      user_agent TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS notification_configs (
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
    );
    CREATE INDEX IF NOT EXISTS idx_notif_tool ON notification_configs(tool_type);

    CREATE TABLE IF NOT EXISTS notification_logs (
      id SERIAL PRIMARY KEY,
      tool_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      channel TEXT,
      message_preview TEXT,
      status TEXT DEFAULT 'sent',
      error TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notif_log_type ON notification_logs(tool_type);
    CREATE INDEX IF NOT EXISTS idx_notif_log_created ON notification_logs(created_at DESC);

    -- Multi-tenant: Companies
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      slug VARCHAR(100) NOT NULL UNIQUE,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);

    -- Add company_id columns (safe idempotent ALTER)
    DO $$ BEGIN
      -- test_executions
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='test_executions' AND column_name='company_id') THEN
        ALTER TABLE test_executions ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- healing_actions
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='healing_actions' AND column_name='company_id') THEN
        ALTER TABLE healing_actions ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- learned_patterns
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='learned_patterns' AND column_name='company_id') THEN
        ALTER TABLE learned_patterns ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- healing_jobs
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='healing_jobs' AND column_name='company_id') THEN
        ALTER TABLE healing_jobs ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- token_usage
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='token_usage' AND column_name='company_id') THEN
        ALTER TABLE token_usage ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- rca_analyses
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='rca_analyses' AND column_name='company_id') THEN
        ALTER TABLE rca_analyses ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- pr_automations
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pr_automations' AND column_name='company_id') THEN
        ALTER TABLE pr_automations ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- generated_scripts
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='generated_scripts' AND column_name='company_id') THEN
        ALTER TABLE generated_scripts ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- notification_configs
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notification_configs' AND column_name='company_id') THEN
        ALTER TABLE notification_configs ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- notification_logs
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notification_logs' AND column_name='company_id') THEN
        ALTER TABLE notification_logs ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- users
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='company_id') THEN
        ALTER TABLE users ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
    END $$;

    -- Indexes for company_id columns
    CREATE INDEX IF NOT EXISTS idx_exec_company ON test_executions(company_id);
    CREATE INDEX IF NOT EXISTS idx_heal_company ON healing_actions(company_id);
    CREATE INDEX IF NOT EXISTS idx_pattern_company ON learned_patterns(company_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_company ON healing_jobs(company_id);
    CREATE INDEX IF NOT EXISTS idx_token_company ON token_usage(company_id);
    CREATE INDEX IF NOT EXISTS idx_rca_company ON rca_analyses(company_id);
    CREATE INDEX IF NOT EXISTS idx_pr_company ON pr_automations(company_id);
    CREATE INDEX IF NOT EXISTS idx_gs_company ON generated_scripts(company_id);
    CREATE INDEX IF NOT EXISTS idx_notif_config_company ON notification_configs(company_id);
    CREATE INDEX IF NOT EXISTS idx_notif_log_company ON notification_logs(company_id);
    CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);

    -- ==================== API KEYS (Enterprise Machine Auth) ====================
    CREATE TABLE IF NOT EXISTS api_keys (
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
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_company ON api_keys(company_id);

    -- ==================== INGESTION LOGS ====================
    CREATE TABLE IF NOT EXISTS ingestion_logs (
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
    );
    CREATE INDEX IF NOT EXISTS idx_ingest_company ON ingestion_logs(company_id);
    CREATE INDEX IF NOT EXISTS idx_ingest_status ON ingestion_logs(status);
    CREATE INDEX IF NOT EXISTS idx_ingest_created ON ingestion_logs(created_at DESC);

    -- ==================== BILLING & LICENSING TABLES ====================

    CREATE TABLE IF NOT EXISTS plans (
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
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
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
    );

    CREATE TABLE IF NOT EXISTS subscription_usage (
      id              SERIAL PRIMARY KEY,
      subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
      company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      operation       VARCHAR(50) NOT NULL,
      credits_used    INTEGER NOT NULL DEFAULT 0,
      metadata        JSONB DEFAULT '{}',
      period_start    TIMESTAMPTZ NOT NULL,
      period_end      TIMESTAMPTZ NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS billing_events (
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
    );

    CREATE TABLE IF NOT EXISTS payment_methods (
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
    );

    -- Billing indexes
    CREATE INDEX IF NOT EXISTS idx_subscriptions_company ON subscriptions(company_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
    CREATE INDEX IF NOT EXISTS idx_sub_usage_company ON subscription_usage(company_id);
    CREATE INDEX IF NOT EXISTS idx_sub_usage_period ON subscription_usage(period_start, period_end);
    CREATE INDEX IF NOT EXISTS idx_sub_usage_operation ON subscription_usage(operation);
    CREATE INDEX IF NOT EXISTS idx_billing_events_company ON billing_events(company_id);
    CREATE INDEX IF NOT EXISTS idx_billing_events_type ON billing_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_payment_methods_company ON payment_methods(company_id);

    -- ==================== ROLES TABLE ====================

    CREATE TABLE IF NOT EXISTS roles (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(50) NOT NULL,
      slug          VARCHAR(50) UNIQUE NOT NULL,
      description   TEXT,
      permissions   JSONB DEFAULT '{}',
      is_system     BOOLEAN DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  /* ---- Repository Intelligence Engine tables ---- */
  await client.query(`
    CREATE TABLE IF NOT EXISTS repository_contexts (
      id              SERIAL PRIMARY KEY,
      repo_id         VARCHAR(500) NOT NULL,
      company_id      INTEGER REFERENCES companies(id),
      profile         JSONB NOT NULL DEFAULT '{}',
      scan_duration_ms INTEGER DEFAULT 0,
      profile_version  INTEGER DEFAULT 1,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_ctx_repo_company
      ON repository_contexts(repo_id, COALESCE(company_id, 0));
    CREATE INDEX IF NOT EXISTS idx_repo_ctx_company
      ON repository_contexts(company_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS code_chunks (
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
    );
    CREATE INDEX IF NOT EXISTS idx_code_chunks_repo ON code_chunks(repo_context_id);
    CREATE INDEX IF NOT EXISTS idx_code_chunks_type ON code_chunks(chunk_type);
  `);

  // Seed default plans & roles
  await seedDefaultPlans(client);
  await seedDefaultRoles(client);

  // Ensure default company exists and backfill orphaned data
  await migrateDefaultCompany(client);
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

  // Backfill any rows without company_id
  const tables = [
    'test_executions', 'healing_actions', 'learned_patterns',
    'healing_jobs', 'token_usage', 'rca_analyses', 'pr_automations',
    'generated_scripts', 'notification_configs', 'notification_logs', 'users',
  ];
  for (const t of tables) {
    await client.query(`UPDATE ${t} SET company_id = $1 WHERE company_id IS NULL`, [defaultId]);
  }

  // Migrate notification_configs unique constraint: tool_type → (tool_type, company_id)
  await client.query(`
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
    END $$;

    -- Test Coverage Intelligence tables
    CREATE TABLE IF NOT EXISTS test_requirements (
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
    );
    CREATE INDEX IF NOT EXISTS idx_test_requirements_company ON test_requirements(company_id);

    CREATE TABLE IF NOT EXISTS generated_test_scenarios (
      id SERIAL PRIMARY KEY,
      requirement_id INTEGER NOT NULL REFERENCES test_requirements(id) ON DELETE CASCADE,
      scenario TEXT NOT NULL,
      coverage_type VARCHAR(50) NOT NULL,
      priority VARCHAR(10) DEFAULT 'P1',
      risk_area VARCHAR(200),
      company_id INTEGER REFERENCES companies(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_gen_scenarios_req ON generated_test_scenarios(requirement_id);

    CREATE TABLE IF NOT EXISTS generated_test_cases (
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
    );
    CREATE INDEX IF NOT EXISTS idx_gen_cases_scenario ON generated_test_cases(scenario_id);

    CREATE TABLE IF NOT EXISTS application_knowledge (
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
    );
    CREATE INDEX IF NOT EXISTS idx_app_knowledge_company ON application_knowledge(company_id);
    CREATE INDEX IF NOT EXISTS idx_app_knowledge_module ON application_knowledge(module);

    -- ========================================================================
    -- Knowledge Management — Enterprise Knowledge Graph
    -- ========================================================================

    CREATE TABLE IF NOT EXISTS knowledge_items (
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
    );
    CREATE INDEX IF NOT EXISTS idx_ki_company ON knowledge_items(company_id);
    CREATE INDEX IF NOT EXISTS idx_ki_category ON knowledge_items(category);
    CREATE INDEX IF NOT EXISTS idx_ki_status ON knowledge_items(status);
    CREATE INDEX IF NOT EXISTS idx_ki_tags ON knowledge_items USING GIN(tags);
    CREATE INDEX IF NOT EXISTS idx_ki_modules ON knowledge_items USING GIN(related_modules);
    CREATE INDEX IF NOT EXISTS idx_ki_search ON knowledge_items USING GIN(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')));

    CREATE TABLE IF NOT EXISTS knowledge_relationships (
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
    );
    CREATE INDEX IF NOT EXISTS idx_kr_source ON knowledge_relationships(source_knowledge_id);
    CREATE INDEX IF NOT EXISTS idx_kr_target ON knowledge_relationships(target_knowledge_id);
    CREATE INDEX IF NOT EXISTS idx_kr_company ON knowledge_relationships(company_id);
  `);
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

export async function logGeneratedScript(data: GeneratedScriptRecord, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO generated_scripts
      (url, page_type, workflow_graph, instructions, script_content, test_plan,
       validation_status, reliability_score, review_score, review_issues,
       tokens_used, model, generation_time_ms, files_generated, negative_tests_included, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
  companyId?: number; category: string; title: string; description: string;
  metadata?: any; tags?: string[]; relatedModules?: string[];
  status?: string; priority?: string; createdBy?: string;
}): Promise<any> {
  const pool = getPool();
  const r = await pool.query(
    `INSERT INTO knowledge_items
       (company_id, category, title, description, metadata, tags, related_modules,
        status, priority, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      data.companyId || null,
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
  companyId?: number; category?: string; status?: string; priority?: string;
  tags?: string[]; module?: string; search?: string;
  limit?: number; offset?: number; sortBy?: string; sortDir?: string;
}): Promise<{ items: any[]; total: number }> {
  const pool = getPool();
  const conds: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (opts.companyId) { conds.push(`company_id = $${idx}`); params.push(opts.companyId); idx++; }
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

export async function searchKnowledgeItems(query: string, companyId?: number, limit = 20): Promise<any[]> {
  const pool = getPool();
  const params: any[] = [query, limit];
  let companyFilter = '';
  if (companyId) { params.push(companyId); companyFilter = `AND company_id = $3`; }

  const r = await pool.query(
    `SELECT *, ts_rank(
        to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')),
        plainto_tsquery('english', $1)
     ) as rank
     FROM knowledge_items
     WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,''))
           @@ plainto_tsquery('english', $1)
       AND status != 'archived'
       ${companyFilter}
     ORDER BY rank DESC
     LIMIT $2`,
    params
  );
  return r.rows;
}

// ---- Knowledge Statistics ----

export async function getKnowledgeStats(companyId?: number): Promise<{
  total: number; byCategory: Record<string, number>;
  byStatus: Record<string, number>; byPriority: Record<string, number>;
  recentCount: number; tagCloud: Array<{ tag: string; count: number }>;
}> {
  const pool = getPool();
  const cond = companyId ? 'WHERE company_id = $1' : '';
  const params = companyId ? [companyId] : [];

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

  const recentCond = companyId
    ? `WHERE company_id = $1 AND created_at > NOW() - INTERVAL '7 days'`
    : `WHERE created_at > NOW() - INTERVAL '7 days'`;
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

export async function getKnowledgeTags(companyId?: number): Promise<string[]> {
  const pool = getPool();
  const cond = companyId ? 'WHERE company_id = $1' : '';
  const params = companyId ? [companyId] : [];
  const r = await pool.query(
    `SELECT DISTINCT unnest(tags) as tag FROM knowledge_items ${cond} ORDER BY tag`, params
  );
  return r.rows.map((row: any) => row.tag);
}

// ---- Get category distribution ----

export async function getKnowledgeCategoryDistribution(companyId?: number): Promise<Array<{category: string; count: number; active: number}>> {
  const pool = getPool();
  const cond = companyId ? 'WHERE company_id = $1' : '';
  const params = companyId ? [companyId] : [];
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
