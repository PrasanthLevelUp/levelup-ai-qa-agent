/**
 * REST API Server — Express server for the AI Self-Healing Agent
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as path from 'path';
import * as fs from 'fs';

import { authMiddleware } from './middleware/auth';
import { companyMiddleware } from './middleware/company';
import { projectContextMiddleware } from './middleware/project-context';
import { contextMiddleware } from './middleware/context';
import { errorHandler } from './middleware/error-handler';
import { createHealRouter } from './routes/heal';
import { createStatusRouter } from './routes/status';
import { createReportsRouter } from './routes/reports';
import { createReposRouter } from './routes/repos';
import { createWebhookRouter } from './routes/webhook';
import { JobQueue, JobStatus } from './queue/job-queue';
import { RepoManager } from './services/repo-manager';
import { logger } from '../utils/logger';
import { initDb, closeDb, getDatabaseHealth } from '../db/postgres';

// Import healing pipeline components
import { ExecutionEngine, type RunResult } from '../core/execution-engine';
import {
  createExecutionProvider,
  ExecutionSetupError,
  type ExecutionMode,
  type ExecutionResult as ProviderExecutionResult,
} from '../core/execution/providers';
import type { ExecutionContext } from '../core/execution/execution-provider';
import { ArtifactCollector, extractTopLevelErrors, enumerateAllTests, type EnumeratedTest } from '../core/artifact-collector';
import { FailureAnalyzer } from '../core/failure-analyzer';
import { HealingOrchestrator, pageObjectPatchLogFields, type HealingOutcome } from '../core/healing-orchestrator';
import { HealingStrategySelector, type StrategyConfig } from '../core/healing-strategy-selector';
import { routeHealingStrategy } from '../core/healing-strategy-router';
import { EvidenceCollector } from '../core/evidence-collector';
import { refineDiagnosisWithEvidence } from '../core/failure-classifier';
// Canonical Execution Record — the single lifecycle record the dashboard reads.
import {
  createExecutionRecord,
  recordArtifacts,
  recordEvidence,
  recordDiagnosis,
  recordHealingDecision,
  recordValidation,
  recordLearning,
  setStage,
  setLifecycle,
  makeSectionTiming,
  appendEvent,
  toAdvisorDecisionTrail,
  type ExecutionRecord,
} from '../core/execution/execution-record';
import {
  deriveResult,
  assertOneRecordPerTest,
  summarizeResultCounts,
} from '../core/execution/execution-lifecycle';
import {
  mapEvidenceToObservations,
  mapDiagnosisToRecord,
  artifactsFromPaths,
  buildHealingDecision,
} from '../core/execution/execution-record-mappers';
import { saveExecutionRecord } from '../db/postgres';
import { RuleEngine } from '../engines/rule-engine';
import { PatternEngine } from '../engines/pattern-engine';
import { AIEngine } from '../engines/ai-engine';
import { OpenAIClient } from '../ai/openai-client';
import { ValidationLayer } from '../validation/validation-layer';
import { acceptCandidate, type LiveValidationInput } from '../core/healing-acceptance';
import {
  HealingTrailBuilder,
  summarizeHealingTrails,
  type HealingTrail,
} from '../core/healing-trail';
import { generateReport, type ReportData, type ReportTest, type ReportHealing } from '../reports/html-report';
import { RCAEngine, type RCAResult } from '../engines/rca-engine';
import { createRCARouter } from './routes/rca';
import { createPRRouter } from './routes/pr';
import { createScriptGenRouter } from './routes/script-gen';
import { createScriptHealthRouter } from './routes/script-health';
import { createMigrationsRouter } from './routes/migrations';
import { createAuthRouter } from './routes/auth';
import { createNotificationsRouter } from './routes/notifications';
import { createDomMemoryRouter } from './routes/dom-memory';
import { createLearningRouter } from './routes/learning';
import { createCompaniesRouter } from './routes/companies';
import { createSimilarityRouter } from './routes/similarity';
import { createReleaseRiskRouter } from './routes/release-risk';
import { createReleaseSignoffRouter } from './routes/release-signoff';
import { createRCAIntelligenceRouter } from './routes/rca-intelligence';
import { createTestCoverageRouter } from './routes/test-coverage';
import { createTestDataRouter } from './routes/test-data';
import { createHealingSettingsRouter } from './routes/healing-settings';
import { createExecutionRecordsRouter } from './routes/execution-records';
import { createRequirementsRouter } from './routes/requirements';
import { createTestCasesRouter } from './routes/test-cases';
import { createRtmRouter } from './routes/rtm';
import { createTraceabilityRouter } from './routes/traceability';
import { createROIRouter } from './routes/roi';
import { createBillingRouter } from './routes/billing';
import { createIngestRouter } from './routes/ingest';
import { apiKeysRouter } from './routes/api-keys';
import { hooksRouter } from './routes/hooks';
import { createRepoIntelligenceRouter } from './routes/repo-intelligence';
import { createRepoIntelligence3CRouter } from './routes/repo-intelligence-3c';
import { createRepoIntelWebhookRouter } from './routes/repo-intel-webhook';
import { FEATURE_FLAGS } from '../config/features';
import { startRepoWorker, stopRepoWorker } from '../jobs/workers/repo-analysis-worker';
import { createKnowledgeRouter } from './routes/knowledge';
import { createDashboardRouter } from './routes/dashboard';
import { createProjectsRouter } from './routes/projects';
import { createEnvironmentsRouter } from './routes/environments';
import { createSprintsRouter } from './routes/sprints';
import { createCIWebhookRouter } from './routes/ci-webhooks';
import { createUsersRouter } from './routes/users';
import { createHealingPRRouter } from './routes/healing-pr';
import { createGitHubRouter } from './routes/github';
import { createGitHubActionsRouter } from './routes/github-actions';
import { createIntelligenceRouter } from './routes/intelligence';
import { createIntelligenceLearningRouter } from './routes/intelligence-learning';
import { createMetricsRouter } from './routes/metrics';
import { createCredentialsRouter } from './routes/credentials';
import { healingVerificationService } from '../services/healing-verification-service';
import { sessionMiddleware } from './middleware/session';
import { notifyRca } from '../integrations/slack';
import { createRcaTicket } from '../integrations/jira';
import cookieParser from 'cookie-parser';
import { createHealingPR, parseRepoUrl, type HealingSummary, type PRResult } from '../github/pr-creator';
import { backupFile, restoreFile, cleanupBackup } from '../utils/file-utils';
import {
  logExecution,
  updateExecution,
  logHealing,
  storePattern,
  getHistoricalStats,
  logRCA,
  logPR,
  getProjectIdForRepo,
  getHealingSettings,
  getExecutionSettings,
  resolveExecutionProfile,
  resolveCollectHealingArtifacts,
  getLatestDomHtmlForUrl,
  type HealingSettings,
  type ExecutionSettings,
} from '../db/postgres';
import {
  HealingIntelligenceContext,
  getHealingIntelligenceContext,
  emptyHealingContext,
} from '../services/healing-intelligence-context';
import {
  buildAppProfileHealingInput,
  type AppProfileHealingInput,
} from '../services/app-profile-healing';
import * as TraceParser from '../core/playwright/trace-parser';
import type { HealingJob } from './queue/job-queue';

const MOD = 'api-server';

// ---------------------------------------------------------------------------
// Execution Record lifecycle helpers (Phase 1: 1 test = 1 ExecutionRecord)
// ---------------------------------------------------------------------------

/**
 * Persist an ExecutionRecord without ever throwing into the worker. The canonical
 * record is important but must never crash a healing job — failures are logged and
 * swallowed (the same contract the worker already used for the failing-test path).
 */
async function persistExecutionRecordSafe(
  record: ExecutionRecord,
  companyId?: number,
  projectId?: number,
): Promise<boolean> {
  try {
    await saveExecutionRecord(record, companyId, projectId);
    return true;
  } catch (err) {
    logger.warn(MOD, 'Failed to persist Execution Record (non-blocking)', {
      executionId: record.executionId,
      testName: record.testName,
      error: (err as Error).message,
    });
    return false;
  }
}

export function createServer(): express.Application {
  const app = express();

  // Trust the platform reverse proxy (Railway/Render/etc.) so req.ip and the
  // X-Forwarded-For chain resolve to the real client address. Without this the
  // login rate limiter can see every request as the proxy's single IP.
  // Override with TRUST_PROXY (e.g. a hop count) if behind multiple proxies.
  const trustProxy = process.env.TRUST_PROXY;
  app.set('trust proxy', trustProxy ? (/^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10) : trustProxy) : true);

  // Middleware
  app.use(cors({
    origin: process.env.DASHBOARD_URL || true,
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  // Serve uploaded profile screenshots statically.
  // NOTE: local disk is ephemeral on Railway — see intelligence router for caveat.
  const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
  app.use('/uploads', express.static(uploadsDir));

  // Request logging
  app.use((req, _res, next) => {
    logger.info(MOD, `${req.method} ${req.path}`, {
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 80),
    });
    next();
  });

  // Initialize DB (async — called in startAPIServer)

  // Initialize services
  const jobQueue = new JobQueue(1);
  const repoManager = new RepoManager();

  // Register job worker (the healing pipeline)
  jobQueue.onJob(createHealingWorker(jobQueue, repoManager));

  // Health check — no auth required
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'LevelUp AI QA Agent',
      version: '2.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Database health check — verifies all required tables exist
  app.get('/api/health/database', async (_req, res) => {
    try {
      const health = await getDatabaseHealth();
      res.status(health.healthy ? 200 : 503).json({
        status: health.healthy ? 'ok' : 'degraded',
        ...health,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      logger.error(MOD, 'Database health check failed', { error: err?.message });
      res.status(503).json({
        status: 'error',
        error: err?.message || 'Database health check failed',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Webhook — no auth (uses its own signature validation)
  app.use('/api/webhook', createWebhookRouter(jobQueue, repoManager));

  // CI Webhooks — autonomous healing (no auth, uses HMAC signature)
  app.use('/api/ci-webhooks', createCIWebhookRouter(jobQueue));

  // Repo Intelligence webhook — incremental re-scan on GitHub push (Phase 2).
  // Unauthenticated (uses its own HMAC signature validation) and ONLY mounted
  // when the GITHUB_WEBHOOKS feature flag is enabled, so it adds no surface by
  // default.
  if (FEATURE_FLAGS.REPO_INTELLIGENCE.GITHUB_WEBHOOKS) {
    app.use('/api/repo-intel-webhook', createRepoIntelWebhookRouter());
    logger.info(MOD, 'Repo-intelligence webhook mounted at /api/repo-intel-webhook');
  }

  // Ingest API — uses its own API key auth (Bearer lvlp_live_xxx)
  // Must support both JSON and raw text/xml bodies
  app.use('/api/ingest', express.text({ type: ['text/xml', 'application/xml'], limit: '50mb' }), createIngestRouter(jobQueue));

  // Cloud platform webhook receivers — use API key via ?token= param
  app.use('/api/hooks', hooksRouter);

  // Auth routes — no API key required (uses cookie-based JWT)
  app.use('/api/auth', createAuthRouter());

  // Authenticated routes (API key + company + session resolution)
  // sessionMiddleware resolves userId from JWT cookie (non-blocking)
  app.use('/api/heal', authMiddleware, companyMiddleware, sessionMiddleware, createHealRouter(jobQueue, repoManager));
  app.use('/api/status', authMiddleware, companyMiddleware, sessionMiddleware, createStatusRouter(jobQueue));
  app.use('/api/reports', authMiddleware, companyMiddleware, sessionMiddleware, createReportsRouter(jobQueue));
  app.use('/api/repos', authMiddleware, companyMiddleware, sessionMiddleware, createReposRouter(repoManager));
  app.use('/api/rca', authMiddleware, companyMiddleware, sessionMiddleware, createRCARouter());
  app.use('/api/pr', authMiddleware, companyMiddleware, sessionMiddleware, createPRRouter());
  app.use('/api/scripts', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createScriptGenRouter());
  app.use('/api/script-health', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createScriptHealthRouter());
  app.use('/api/migrations', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createMigrationsRouter());
  app.use('/api/notifications', authMiddleware, companyMiddleware, sessionMiddleware, createNotificationsRouter());
  // SECURITY (multi-tenant isolation): projectContextMiddleware populates
  // (req as any).projectId from the X-Project-Id header so the DOM-memory and
  // learning analytics queries can scope by BOTH company_id AND project_id.
  // Without it these dashboards would aggregate across every project in the
  // company (cross-project intelligence leak).
  app.use('/api/dom', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createDomMemoryRouter());
  app.use('/api/learning', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createLearningRouter());
  app.use('/api/companies', authMiddleware, sessionMiddleware, createCompaniesRouter());
  // SECURITY (multi-tenant isolation): projectContextMiddleware populates
  // (req as any).projectId so the similarity engine analytics scope by BOTH
  // company_id AND project_id instead of leaking across projects.
  app.use('/api/similarity', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createSimilarityRouter());
  app.use('/api/release-risk', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createReleaseRiskRouter());
  app.use('/api/release-signoff', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createReleaseSignoffRouter());
  app.use('/api/rca-intelligence', authMiddleware, companyMiddleware, sessionMiddleware, createRCAIntelligenceRouter());
  app.use('/api/roi', authMiddleware, companyMiddleware, sessionMiddleware, createROIRouter());
  app.use('/api/test-coverage', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createTestCoverageRouter());
  app.use('/api/test-data', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createTestDataRouter());
  app.use('/api/healing-settings', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createHealingSettingsRouter());
  // Canonical Execution Records — the single lifecycle record per test execution.
  app.use('/api/execution-records', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createExecutionRecordsRouter());
  app.use('/api/requirements', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createRequirementsRouter());
  app.use('/api/test-cases', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createTestCasesRouter());
  app.use('/api/rtm', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createRtmRouter());
  app.use('/api/traceability', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createTraceabilityRouter());
  app.use('/api/billing', authMiddleware, companyMiddleware, sessionMiddleware, createBillingRouter());
  app.use('/api/keys', authMiddleware, companyMiddleware, sessionMiddleware, apiKeysRouter);
  app.use('/api/repo-intelligence', authMiddleware, companyMiddleware, sessionMiddleware, createRepoIntelligenceRouter());
  // Phase 3C: Health Intelligence + Impact Analysis + Knowledge Graph Lite.
  // Each route group is internally gated by its own feature flag (returns 404
  // when off), so mounting is unconditional and the default surface is unchanged.
  app.use('/api/repo-intelligence-3c', authMiddleware, companyMiddleware, sessionMiddleware, createRepoIntelligence3CRouter());
  app.use('/api/knowledge', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createKnowledgeRouter());
  app.use('/api/dashboard', authMiddleware, companyMiddleware, sessionMiddleware, createDashboardRouter());
  // Nested project-scoped routers (Phase 1 Foundation). Mounted before the
  // generic /api/projects router so the more specific paths match first.
  app.use('/api/projects/:projectId/environments', authMiddleware, companyMiddleware, sessionMiddleware, createEnvironmentsRouter());
  app.use('/api/projects/:projectId/sprints', authMiddleware, companyMiddleware, sessionMiddleware, createSprintsRouter());
  app.use('/api/projects', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createProjectsRouter());
  app.use('/api/healings', authMiddleware, companyMiddleware, sessionMiddleware, createHealingPRRouter());
  app.use('/api/users', authMiddleware, companyMiddleware, sessionMiddleware, createUsersRouter());
  app.use('/api/github/actions', authMiddleware, companyMiddleware, sessionMiddleware, createGitHubActionsRouter());
  app.use('/api/github', authMiddleware, companyMiddleware, sessionMiddleware, createGitHubRouter());
  app.use('/api/intelligence', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createIntelligenceRouter());
  app.use('/api/intelligence-learning', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createIntelligenceLearningRouter());
  app.use('/api/metrics', authMiddleware, companyMiddleware, sessionMiddleware, projectContextMiddleware, contextMiddleware, createMetricsRouter());
  app.use('/api/credentials', authMiddleware, companyMiddleware, sessionMiddleware, createCredentialsRouter());

  // List all jobs
  app.get('/api/jobs', authMiddleware, (_req, res) => {
    const allJobs = jobQueue.listJobs();
    res.json({ jobs: allJobs });
  });

  // Error handler
  app.use(errorHandler);

  return app;
}

export async function startAPIServer(): Promise<void> {
  const port = parseInt(process.env['PORT'] || '8080', 10);

  const app = createServer();

  // START SERVER FIRST — Railway healthcheck requires a listening port within ~5 min.
  // Database init happens AFTER the server is up so /api/health can respond immediately.
  const server = app.listen(port, () => {
    logger.info(MOD, `API server started on port ${port}`, { port });
    console.log(`\n🚀 LevelUp AI QA Agent API running at http://localhost:${port}`);
    console.log(`   Health: http://localhost:${port}/api/health`);
    console.log(`   Docs:   See README.md for API documentation\n`);
  });

  // Initialize PostgreSQL schema AFTER server is listening
  // Non-fatal: log errors but don't crash the server
  try {
    console.log('🔧 [DB] Starting database initialization (server already listening)...');
    await initDb();
    console.log('✅ [DB] Database initialization complete');
  } catch (err: any) {
    console.error('⚠️ [DB] Database initialization failed — server is running but DB may be incomplete');
    console.error('⚠️ [DB] Error:', err?.message, err?.code);
    logger.error(MOD, 'Database initialization failed (non-fatal)', {
      error: err?.message, code: err?.code, detail: err?.detail,
    });
    // Server continues running — /api/health still responds
    // /api/health/database will show which tables are missing
  }

  // Background workers (Phase 2) — start AFTER DB init so the pgvector
  // availability flag is set. No-op unless the BACKGROUND_WORKERS flag is on;
  // never connects to Redis by default.
  if (FEATURE_FLAGS.REPO_INTELLIGENCE.BACKGROUND_WORKERS) {
    try {
      const worker = startRepoWorker();
      if (worker) {
        console.log('🧵 [Workers] Repo-analysis background worker started');
      }
    } catch (err: any) {
      logger.warn(MOD, 'Failed to start repo worker (non-fatal)', { error: err?.message });
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info(MOD, 'Shutting down gracefully...');
    server.close(async () => {
      await stopRepoWorker();
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}

/**
 * Create the healing worker function that processes jobs.
 */
function createHealingWorker(
  jobQueue: JobQueue,
  repoManager: RepoManager,
): (job: HealingJob) => Promise<any> {
  return async (job: HealingJob) => {
    const reportDir = process.env['REPORT_DIR'] || '/tmp/healing_reports';
    fs.mkdirSync(reportDir, { recursive: true });

    // ── Wall-clock budgets & loop bounds (configurable via env) ──────────────
    // The healing worker reruns each failing test inside nested retry loops. To
    // guarantee a job ALWAYS finishes in a reasonable time (and never hangs like
    // the stuck "Healing: ..." job), we bound it three ways:
    //   1. A hard job-level wall-clock budget.
    //   2. A per-test wall-clock budget.
    //   3. Much smaller iteration/retry caps (was 15×8 = up to 120 reruns/test).
    // We also honor user cancellation (the Cancel button) between reruns.
    const envInt = (name: string, def: number): number => {
      const v = Number(process.env[name]);
      return Number.isFinite(v) && v > 0 ? v : def;
    };
    const jobStartMs = Date.now();
    const JOB_BUDGET_MS = envInt('HEALING_JOB_BUDGET_MS', 900_000);       // 15 min total
    const PER_TEST_BUDGET_MS = envInt('HEALING_PER_TEST_BUDGET_MS', 240_000); // 4 min/test
    const MAX_HEAL_ITERATIONS = envInt('HEALING_MAX_ITERATIONS', 6);      // locator fixes/test
    const RETRIES_PER_LOCATOR = envInt('HEALING_RETRIES_PER_LOCATOR', 3); // suggestions/locator
    // With candidate pre-ranking the best candidate is tried first, so very few
    // candidates ever need a real browser rerun. This is the hard cap on browser
    // reruns per broken locator (the old code ran one rerun PER candidate).
    const MAX_BROWSER_TRIES_PER_LOCATOR = envInt('HEALING_MAX_BROWSER_TRIES_PER_LOCATOR', 2);

    // Execution settings — load early so they're available for initial test run
    // Use job.projectId if available (will be refined later with resolvedProjectId for healing)
    // Profiles are project-level DEFAULTS overridden per execution request:
    //   request override (job.requestedProfile) > project default > system default.
    let executionProfile: import('../db/postgres').ExecutionProfile = resolveExecutionProfile(
      job.requestedProfile,
      undefined,
    );
    let collectHealingArtifacts = resolveCollectHealingArtifacts(
      job.requestedCollectHealingArtifacts,
      undefined,
    );
    try {
      const es: ExecutionSettings = await getExecutionSettings(job.companyId, job.projectId);
      // Per-request override wins over the project default; project default wins over system default.
      executionProfile = resolveExecutionProfile(job.requestedProfile, es.executionProfile);
      collectHealingArtifacts = resolveCollectHealingArtifacts(
        job.requestedCollectHealingArtifacts,
        es.collectHealingArtifacts,
      );
      logger.info(MOD, '⚙️ Execution settings resolved (early)', {
        companyId: job.companyId ?? null,
        projectId: job.projectId ?? null,
        projectDefaultProfile: es.executionProfile,
        requestedProfile: job.requestedProfile ?? null,
        effectiveProfile: executionProfile,
        requestedCollectHealingArtifacts: job.requestedCollectHealingArtifacts ?? null,
        effectiveCollectHealingArtifacts: collectHealingArtifacts,
      });
    } catch (settingsErr: any) {
      logger.warn(MOD, 'Could not load execution settings — using defaults', { error: settingsErr.message });
    }

    /** True once the user has cancelled this job (Cancel sets status=FAILED). */
    const isCancelled = (): boolean => jobQueue.getJob(job.id)?.status === JobStatus.FAILED;
    /** Remaining job wall-clock budget in ms (never negative). */
    const jobBudgetRemainingMs = (): number => Math.max(0, JOB_BUDGET_MS - (Date.now() - jobStartMs));
    /** True when the overall job time budget is exhausted. */
    const jobBudgetExhausted = (): boolean => jobBudgetRemainingMs() <= 0;
    /**
     * Effective per-rerun timeout: never exceed the remaining job budget so a
     * single rerun can't blow past the global limit.
     */
    const rerunTimeoutMs = (): number => Math.max(15_000, Math.min(120_000, jobBudgetRemainingMs()));

    // Resolve repo configuration
    const repo = repoManager.findRepo(job.repositoryId);
    // Use WORKSPACE_DIR env var for Railway/Docker, fallback to /tmp/healing-repos
    const workspaceDir = process.env['WORKSPACE_DIR'] || '/tmp/healing-repos';
    const repoUrl = job.repositoryUrl || repo?.url || '';
    const branch = job.branch || repo?.branch || 'main';

    // SECURITY: Derive a unique, tenant-isolated path using companyId/projectId + sanitized repoId
    // NEVER use repo?.localPath — it can point to stale/wrong directories from other tenants
    const repoName = repo?.name || job.repositoryId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-50) || 'test_repo';
    const tenantPrefix = job.companyId ? `c${job.companyId}` : 'shared';
    const projectPrefix = job.projectId ? `_p${job.projectId}` : '';
    const testRepoPath = path.join(workspaceDir, `${tenantPrefix}${projectPrefix}`, repoName);

    logger.info(MOD, 'Starting healing worker', {
      jobId: job.id,
      testRepoPath,
      repoUrl,
      branch,
      repoName,
      workspaceDir,
      companyId: job.companyId,
      projectId: job.projectId,
      tenantPrefix,
    });

    // ── Steps 1–4: produce the run via the selected ExecutionProvider ──────
    // The execution SOURCE (Local Runner vs GitHub Actions vs future providers)
    // has DISAPPEARED from the worker. A provider now owns the ENTIRE execution
    // lifecycle — clone, execute, download + parse artifacts, and build the
    // finalized pass/skip ExecutionRecords — and returns ONE canonical
    // ExecutionResult { records, artifacts, repoPath, exitCode, resultsFile,
    // metadata, providerInfo }. Everything below this point is source-agnostic:
    // the worker feeds the result through Diagnosis → Healing → Validation →
    // Learning without ever learning where execution physically ran. Default is
    // 'local', preserving the original clone → install → run behavior.
    const executionMode: ExecutionMode = job.executionMode ?? 'local';
    jobQueue.updateJob(job.id, {
      progress: executionMode === 'github_actions'
        ? 'Dispatching GitHub Actions workflow...'
        : 'Cloning/pulling repository...',
    });

    const provider = createExecutionProvider(executionMode);
    const executionContext: ExecutionContext = {
      repoUrl,
      branch,
      repoPath: testRepoPath,
      testFile: job.testFile,
      profile: executionProfile,
      collectHealingArtifacts,
      budgetMs: jobBudgetRemainingMs(),
      jobId: job.id,
      companyId: job.companyId,
      providerConfig: job.providerConfig,
    };

    let execResult: ProviderExecutionResult;
    try {
      execResult = await provider.execute(executionContext);
    } catch (error) {
      // Setup-level failures (clone/install/dispatch/...) carry the SAME exit
      // codes + actionable messages the worker surfaced inline before this
      // inversion, so the operator-facing behavior is identical regardless of
      // which provider raised them.
      if (error instanceof ExecutionSetupError) {
        logger.error(MOD, 'Execution setup FAILED', {
          stage: error.stage, exitCode: error.exitCode, error: error.message, repoUrl, jobId: job.id,
        });
        jobQueue.updateJob(job.id, { progress: `FAILED: ${error.message}` });
        const suffix = executionMode === 'github_actions'
          ? ' Verify GitHub is connected, the workflow exists, and it declares "on: workflow_dispatch".'
          : '';
        return {
          totalTests: 0, failed: 0, healed: 0, strategy: 'none', tokensUsed: 0,
          testResults: { exitCode: error.exitCode, durationMs: 0 },
          healingActions: [],
          message: `${error.message}${suffix}`,
          error: error.message,
        };
      }
      const errMsg = (error as Error).message;
      logger.error(MOD, 'Execution FAILED', { error: errMsg, repoUrl, jobId: job.id });
      jobQueue.updateJob(job.id, { progress: `FAILED: ${errMsg}` });
      return {
        totalTests: 0, failed: 0, healed: 0, strategy: 'none', tokensUsed: 0,
        testResults: { exitCode: 1, durationMs: 0 },
        healingActions: [],
        message: `Execution failed: ${errMsg}.`,
        error: errMsg,
      };
    }

    jobQueue.updateJob(job.id, {
      progress: `Execution complete (${execResult.providerInfo.source}) — analyzing results...`,
    });
    logger.info(MOD, 'Execution complete', {
      jobId: job.id,
      source: execResult.providerInfo.source,
      runId: execResult.providerInfo.runId,
      conclusion: execResult.providerInfo.conclusion,
      resultsFile: execResult.resultsFile,
      exitCode: execResult.exitCode,
      records: execResult.records.length,
      artifacts: execResult.artifacts.length,
    });

    // Minimal `run` view for the downstream legacy paths (all-pass messaging +
    // result tallies). The heal loop consumes `artifacts` directly; `run` only
    // carries the exit/stderr/duration + resultsFile those legacy branches read.
    const run: RunResult = {
      exitCode: execResult.exitCode,
      stdout: execResult.metadata.stdout ?? '',
      stderr: execResult.metadata.stderr ?? '',
      resultsFile: execResult.resultsFile,
      startTime: execResult.metadata.startTime,
      endTime: execResult.metadata.endTime,
      durationMs: execResult.metadata.durationMs,
    };
    // The provider already parsed failure artifacts AND built the finalized
    // pass/skip records — the worker no longer collects anything itself.
    const artifacts: any[] = execResult.artifacts;
    // The Hybrid validation reruns inside the heal loop re-collect artifacts from
    // their (local) rerun results file; keep a collector instance for those.
    const collector = new ArtifactCollector();

    if (artifacts.length === 0) {
      let message = 'All tests passed — no healing needed';
      if (run.exitCode === 127) {
        message = 'Command not found (exit code 127). This usually means playwright is not installed. Check that npm install completed successfully and node_modules/.bin/playwright exists.';
      } else if (run.exitCode !== 0) {
        // Playwright records spec-load / global-setup / config failures under the
        // results file's top-level `errors[]` (with an EMPTY `suites[]`), which the
        // suite walker doesn't see. Surface them so a fast load-time crash (e.g. a
        // required env var missing while a spec is imported) is actionable instead
        // of a silent "no failure artifacts" with empty stderr.
        const loadErrors = extractTopLevelErrors(run.resultsFile);
        if (loadErrors.length > 0) {
          const firstError = loadErrors[0].slice(0, 600);
          message =
            `Tests exited with code ${run.exitCode}: ${loadErrors.length} test file(s)/setup failed to load before any test ran ` +
            `(this is NOT a healable locator failure — usually a missing env var, bad import, or config error). ` +
            `First error: ${firstError}`;
        } else {
          message = `Tests exited with code ${run.exitCode} but no failure artifacts were collected. stderr: ${(run.stderr || '').slice(0, 300)}`;
        }
      }

      // ── Canonical Execution Records for an all-pass run ──
      // Historically a clean run produced ZERO per-test records (records were
      // created only inside the failure loop), so "Executions" silently dropped
      // every passing test. The PROVIDER now builds one finalized PASS/SKIP record
      // per enumerated test (pure execution facts) — the worker just persists
      // them, so the invariant (1 test = 1 record) holds even when nothing fails.
      let passSkipRecorded = 0;
      if (run.exitCode === 0) {
        try {
          // Resolve project scope (records are project-scoped); best-effort.
          let projectIdForRecords: number | undefined = job.projectId;
          if (!projectIdForRecords) {
            const pid = await getProjectIdForRepo(repoUrl || repo?.url || job.repositoryId, job.companyId);
            projectIdForRecords = pid ?? undefined;
          }
          for (const rec of execResult.records) {
            const ok = await persistExecutionRecordSafe(rec, job.companyId, projectIdForRecords);
            if (ok) passSkipRecorded++;
          }
          logger.info(MOD, 'All-pass run — persisted per-test Execution Records', {
            jobId: job.id, tests: execResult.records.length, recorded: passSkipRecorded,
          });
        } catch (recErr) {
          logger.warn(MOD, 'Failed to persist all-pass Execution Records (non-blocking)', {
            jobId: job.id, error: (recErr as Error).message,
          });
        }
      }

      const result = {
        totalTests: run.exitCode === 0 ? Math.max(passSkipRecorded, 1) : 0,
        failed: run.exitCode !== 0 ? 1 : 0,
        healed: 0,
        strategy: 'none',
        tokensUsed: 0,
        testResults: { exitCode: run.exitCode, durationMs: run.durationMs },
        healingActions: [],
        message,
        error: run.exitCode !== 0 ? message : undefined,
      };
      return result;
    }

    // Step 5: Analyze and heal
    jobQueue.updateJob(job.id, { progress: `Analyzing ${artifacts.length} failure(s)...` });

    // Resolve the owning project so every healing record is project-scoped (powers
    // the project filter on the Healings screen) and DOM Memory is queried/learned
    // per-project. Prefer the explicit projectId on the job; otherwise backfill
    // from the repositories table by URL/name.
    let resolvedProjectId: number | undefined = job.projectId;
    if (!resolvedProjectId) {
      const pid = await getProjectIdForRepo(repoUrl || repo?.url || job.repositoryId, job.companyId);
      resolvedProjectId = pid ?? undefined;
    }
    logger.info(MOD, 'Healing project scope resolved', {
      jobId: job.id,
      projectId: resolvedProjectId ?? null,
      companyId: job.companyId ?? null,
    });

    const analyzer = new FailureAnalyzer();
    // Guard AI engine construction: OpenAIClient throws if OPENAI_API_KEY is missing.
    // Without this guard a missing key would crash the entire healing job instead of
    // gracefully disabling only the AI strategy (rule + pattern healing still work).
    const aiEngine = process.env['OPENAI_API_KEY']
      ? new AIEngine(new OpenAIClient({ model: 'gpt-4o-mini', apiKey: process.env['OPENAI_API_KEY'] }))
      : new AIEngine(); // AI disabled — no-ops, leaving rule/pattern strategies intact
    if (!aiEngine.isEnabled) {
      logger.warn(MOD, '⚠️ OPENAI_API_KEY not set — AI healing strategy disabled (rule + pattern still active)');
    }

    // ── Load healing strategy settings (thresholds + cost caps) ──
    // Load per-company/project thresholds + cost caps and build a configured
    // strategy selector. When no settings are stored, getHealingSettings returns
    // the engine defaults, preserving prior behaviour. AI fallback off is modelled
    // by setting the daily token budget to 0 so the AI budget check always fails.
    let strategySelector: HealingStrategySelector | undefined;
    try {
      const hs: HealingSettings = await getHealingSettings(job.companyId, resolvedProjectId);
      const strategyConfig: StrategyConfig = {
        confidenceThresholds: {
          rule: hs.ruleThreshold,
          pattern: hs.patternThreshold,
          ai: hs.aiThreshold,
        },
        costLimits: {
          perHealing: hs.maxCostPerHealing,
          perDay: hs.aiFallbackEnabled ? hs.maxDailyTokenBudget : 0,
        },
      };
      strategySelector = new HealingStrategySelector(strategyConfig);
      logger.info(MOD, '⚙️ Healing strategy settings applied', {
        companyId: job.companyId ?? null,
        projectId: resolvedProjectId ?? null,
        thresholds: strategyConfig.confidenceThresholds,
        aiFallbackEnabled: hs.aiFallbackEnabled,
        maxCostPerHealing: hs.maxCostPerHealing,
      });
    } catch (settingsErr: any) {
      logger.warn(MOD, 'Could not load healing settings — using engine defaults', { error: settingsErr.message });
    }

    const orchestrator = new HealingOrchestrator(
      new RuleEngine(),
      new PatternEngine(),
      aiEngine,
      undefined,
      undefined,
      undefined,
      strategySelector,
    );
    const validationLayer = new ValidationLayer(path.join(reportDir, 'patches'));

    const healings: ReportHealing[] = [];
    const tests: ReportTest[] = [];
    const rcaResults: RCAResult[] = [];
    // Track which test names already produced an ExecutionRecord this job so we can
    // backfill PASS/SKIP records for the rest after the failure loop — and assert
    // the 1-test = 1-record invariant. (Failures + precheck-healed add to this.)
    const recordedTests = new Set<string>();
    // Per-failure 3-layer healing trail (observability): records what each healing
    // layer tried and why it succeeded/failed — even when nothing was healable.
    const healingTrails: HealingTrail[] = [];
    let healedCount = 0;
    let totalTokensUsed = 0;

    // RCA engine (instantiate once per job)
    const rcaEngine = process.env['OPENAI_API_KEY']
      ? new RCAEngine({ apiKey: process.env['OPENAI_API_KEY'] })
      : null;

    // MAX_HEAL_ITERATIONS / RETRIES_PER_LOCATOR are defined at the top of the
    // worker (env-configurable) so they can be tuned alongside the time budgets.

    // De-duplicate artifacts by test name (multiple artifacts may come from the same test)
    const seenTests = new Set<string>();
    const uniqueArtifacts = artifacts.filter((a: any) => {
      const f = analyzer.analyze(a);
      if (seenTests.has(f.testName)) return false;
      seenTests.add(f.testName);
      return true;
    });

    let timedOutTests = 0;
    for (const artifact of uniqueArtifacts) {
      // Stop the whole job cleanly if the user cancelled or we ran out of budget.
      if (isCancelled()) {
        logger.warn(MOD, 'Healing job cancelled by user — stopping', { jobId: job.id });
        break;
      }
      if (jobBudgetExhausted()) {
        logger.warn(MOD, 'Job time budget exhausted — stopping before next test', {
          jobId: job.id, budgetMs: JOB_BUDGET_MS,
        });
        break;
      }

      let failure = analyzer.analyze(artifact);
      // Track which artifact `failure` was derived from, so the Evidence
      // Collector can read its trace/video/screenshot paths (Failure Replay).
      let evidenceArtifact = artifact;
      const testStartMs = Date.now();
      // Per-test deadline = min(per-test budget, remaining job budget).
      const testDeadlineMs = testStartMs + Math.min(PER_TEST_BUDGET_MS, jobBudgetRemainingMs());
      const testBudgetExhausted = (): boolean => Date.now() >= testDeadlineMs;

      // PRE-CHECK: Re-run this specific test to see if it still fails.
      // A previous test's healing may have already fixed shared locators in the same file.
      // Use the base execution profile (not a healing attempt yet).
      const preCheckRelFile = path.relative(path.join(testRepoPath, 'tests'), failure.filePath);
      const preCheck = await ExecutionEngine.runAsync(
        testRepoPath,
        preCheckRelFile,
        failure.testName,
        rerunTimeoutMs(),
        executionProfile,
        collectHealingArtifacts,
        false // isHealingRun=false for precheck
      );
      if (preCheck.exitCode === 0) {
        logger.info(MOD, 'Test already passes (fixed by prior healing) — skipping', {
          testName: failure.testName,
        });
        tests.push({
          testName: failure.testName,
          status: 'healed',
          durationMs: preCheck.durationMs,
          error: '',
          healed: true,
        });
        healedCount++;
        const execId = await logExecution({
          test_name: failure.testName,
          status: 'healed',
          error_message: '',
          healing_attempted: false,
          healing_succeeded: true,
        }, job.companyId);
        // Canonical record: this test was healed by a PRIOR test's fix (shared
        // locator). It completed with a HEALED result without its own healing
        // pipeline — record it once so the invariant holds.
        const precheckHealedRec = createExecutionRecord({
          executionId: String(execId),
          testName: failure.testName,
          status: 'completed',
          result: 'healed',
          stage: 'completed',
          jobId: String(job.id),
          durationMs: preCheck.durationMs,
          startTime: new Date(testStartMs).toISOString(),
          endTime: new Date(testStartMs + preCheck.durationMs).toISOString(),
          profile: executionProfile,
        });
        await persistExecutionRecordSafe(precheckHealedRec, job.companyId, resolvedProjectId);
        recordedTests.add(failure.testName);
        continue;
      }

      // Re-collect fresh artifacts for THIS test (in case shared locators were already healed)
      try {
        const freshArtifacts = collector.collect(preCheck.resultsFile, testRepoPath);
        const freshForTest = freshArtifacts.find((a: any) => {
          const nf = analyzer.analyze(a);
          return nf.testName === failure.testName;
        });
        if (freshForTest) {
          failure = analyzer.analyze(freshForTest);
          evidenceArtifact = freshForTest;
          logger.info(MOD, 'Using fresh artifacts for test', {
            testName: failure.testName,
            failedLocator: failure.failedLocator,
          });
        }
      } catch (e) {
        logger.warn(MOD, 'Could not refresh artifacts, using original', { error: (e as Error).message });
      }

      tests.push({
        testName: failure.testName,
        status: 'failed',
        durationMs: 0,
        error: failure.errorMessage.slice(0, 200),
        healed: false,
      });

      const executionId = await logExecution({
        test_name: failure.testName,
        status: 'failed',
        error_message: failure.errorMessage.slice(0, 1000),
        healing_attempted: true,
        healing_succeeded: false,
      }, job.companyId);

      jobQueue.updateJob(job.id, {
        progress: `Healing: ${failure.testName}...`,
      });

      // ── Canonical Execution Record ──
      // One record per failing test, threaded through the whole pipeline:
      //   Execution → Diagnosis → Healing → Validation → Learning.
      // The record is born at test START as RUNNING (stage `collecting_evidence`,
      // since we capture the failing run's artifacts/evidence first) and persisted
      // immediately, then enriched stage-by-stage (collecting_evidence →
      // diagnosing → healing → learning) and finalized with a terminal status +
      // result. The dashboard reads THIS single record rather than stitching
      // together separate diagnosis/healing/evidence/artifact tables. Lifecycle
      // sections accumulate immutably (each record* returns a new record); the
      // record is upserted in place (never duplicated).
      let execRecord: ExecutionRecord = createExecutionRecord({
        executionId: String(executionId),
        testName: failure.testName,
        status: 'running',
        result: null,
        stage: 'collecting_evidence',
        jobId: String(job.id),
        durationMs: 0,
        startTime: new Date(testStartMs).toISOString(),
        endTime: new Date(testStartMs).toISOString(),
        profile: executionProfile,
      });
      // The most recent advisor waterfall produced for this test. Captured each
      // time we collect ranked candidates so the final ExecutionRecord can persist
      // the authoritative Decision Trail (which advisors were consulted / won /
      // skipped) — the dashboard renders it directly, never inferring.
      let lastDecisionTrail: ReturnType<typeof toAdvisorDecisionTrail> = [];
      recordedTests.add(failure.testName);
      // Persist the RUNNING record up-front so an in-flight execution is visible
      // (and so a crash mid-heal still leaves a record rather than nothing).
      await persistExecutionRecordSafe(execRecord, job.companyId, resolvedProjectId);
      // Stage 1 — artifacts captured by the failing run (storage-agnostic
      // descriptors, local today). Inline metadata stays cheap/structured.
      execRecord = recordArtifacts(execRecord, {
        ...artifactsFromPaths({
          screenshotPath: evidenceArtifact.screenshot_path,
          tracePath: evidenceArtifact.trace_path,
          videoPath: evidenceArtifact.video_path,
        }),
        metadata: {
          ...(failure.url ? { url: failure.url } : {}),
          ...(failure.diagnosis?.locator ? { locator: failure.diagnosis.locator } : {}),
          ...(failure.diagnosis?.line != null ? { failedLine: failure.diagnosis.line } : {}),
        },
      });

      const backupPath = backupFile(failure.filePath);
      let iterationSuccess = false;
      let lastStrategy = 'rule_based';
      let lastConfidence = 0;
      let iterFixCount = 0;
      const healedBeforeTest = healedCount;

      // Per-section wall-clock markers (epoch ms) for the timing breakdown the
      // dashboard shows (Evidence / Diagnosis / Healing / Learning durations).
      // Best-effort: phases that don't run leave their timing unset.
      let evidenceStartMs = 0;
      let evidenceEndMs = 0;

      // ── Evidence-Based Diagnosis (runs BEFORE classification is consumed) ──
      // The parser-based classifier produced `failure.diagnosis` from the error
      // text. Before anyone acts on it, aggregate the OBSERVED facts Playwright
      // already captured (DOM snapshot → locator state, console/network signals,
      // trace/video/screenshot artifacts) and upgrade the diagnosis with them.
      // This is what turns inference ("looks like a broken locator") into
      // evidence ("element exists/visible/enabled but is covered by an overlay →
      // wait_for_overlay"). Best-effort: any failure here degrades gracefully to
      // the parser-based diagnosis.
      if (failure.diagnosis) {
        try {
          evidenceStartMs = Date.now();
          let domSnapshot: string | null = null;
          if (failure.url) {
            domSnapshot = await getLatestDomHtmlForUrl(
              failure.url,
              job.companyId,
              resolvedProjectId,
            );
          }
          // Fall back to the failure-time DOM from the trace when no prior crawl
          // snapshot exists (fresh repo). Keeps evidence-based diagnosis grounded
          // on real DOM rather than the parser's inference. Graceful: null-safe.
          if (!domSnapshot && evidenceArtifact.trace_path) {
            domSnapshot = TraceParser.extractDomHtml(evidenceArtifact.trace_path);
          }
          const evidence = await new EvidenceCollector().collect({
            failure,
            domSnapshot,
            tracePath: evidenceArtifact.trace_path,
            videoPath: evidenceArtifact.video_path,
            consoleLog: failure.errorMessage,
          });
          evidenceEndMs = Date.now();
          const refined = refineDiagnosisWithEvidence(failure.diagnosis, evidence);
          failure.diagnosis = refined;
          // Stage 2 + 3 — record the collected EVIDENCE and the classifier's
          // verdict, each stamped with its wall-clock timing.
          execRecord = recordEvidence(execRecord, {
            ...mapEvidenceToObservations(evidence),
            timing: makeSectionTiming(evidenceStartMs, evidenceEndMs),
          });
          execRecord = appendEvent(execRecord, { type: 'evidence_collected' });
          // Evidence captured — advance the stage before diagnosis is recorded.
          execRecord = setStage(execRecord, 'diagnosing');
          execRecord = recordDiagnosis(execRecord, mapDiagnosisToRecord(refined));
          logger.info(MOD, 'Evidence-based diagnosis', {
            testName: failure.testName,
            category: refined.category,
            recommendedStrategy: refined.recommendedStrategy,
            confidence: refined.confidence,
            evidenceBased: refined.evidenceBased,
            locatorState: evidence.locatorState
              ? {
                  exists: evidence.locatorState.exists,
                  visible: evidence.locatorState.visible,
                  enabled: evidence.locatorState.enabled,
                  clickable: evidence.locatorState.clickable,
                  interceptedBy: evidence.locatorState.interceptedBy,
                }
              : null,
          });
        } catch (e) {
          logger.warn(MOD, 'Evidence collection failed — using parser-based diagnosis', {
            testName: failure.testName,
            error: (e as Error).message,
          });
        }
      }
      // Ensure the record carries a diagnosis even when evidence collection
      // failed/was skipped (falls back to the parser-based verdict).
      if (failure.diagnosis && !execRecord.diagnosis) {
        execRecord = setStage(execRecord, 'diagnosing');
        execRecord = recordDiagnosis(execRecord, mapDiagnosisToRecord(failure.diagnosis));
      }
      // Diagnosis done — stamp its timing and advance the stage to `healing`.
      // Diagnosis spans from the end of evidence collection (or the test start,
      // when no evidence ran) to now. Healing timing starts here.
      const healStartMs = Date.now();
      const diagStartMs = evidenceEndMs || testStartMs;
      if (execRecord.diagnosis) {
        execRecord = recordDiagnosis(execRecord, {
          timing: makeSectionTiming(diagStartMs, healStartMs),
        });
        execRecord = appendEvent(execRecord, { type: 'diagnosis_completed' });
      }
      execRecord = setStage(execRecord, 'healing');

      // Observability: build a concise trail for this failure regardless of
      // whether anything is healable. Finalized after the healing branches.
      const trail = new HealingTrailBuilder(failure.testName, failure.failureType, failure.diagnosis);

      // ── Diagnosis-first strategy routing ──
      // Map the structured diagnosis ("WHAT failed") to a remedy ("HOW / whether
      // to heal"). This is the gate that stops the engine from prescribing a
      // locator swap before it has confidently diagnosed a locator problem. The
      // existing failureType branches below remain for navigation/assertion/
      // timing handling; this plan adds the crucial guard for locator-typed
      // failures that have NO resolvable locator (and for unclassified ones).
      const strategyPlan = failure.diagnosis ? routeHealingStrategy(failure.diagnosis) : null;
      if (strategyPlan) {
        logger.info(MOD, 'Diagnosis-first strategy routed', {
          testName: failure.testName,
          category: strategyPlan.category,
          remedy: strategyPlan.remedy,
          shouldAttemptLocatorHealing: strategyPlan.shouldAttemptLocatorHealing,
        });
      }

      // Explicit artifact collection control: collectHealingArtifacts flag is set at
      // project level by the user (explicit, visible, never auto-upgraded). When true,
      // healing runs will collect trace/video/HAR regardless of base profile (unless
      // profile is 'fast', which explicitly disables all artifacts). When false, only
      // the base profile artifacts are collected. This makes artifact costs predictable
      // and prevents hidden storage surprises.

      try {
        // Decide healing strategy based on failure type:
        // - assertion: Element found but assertion failed → add waits only, no locator change
        // - locator / locator_timeout: Element NOT found → change locator + add waits
        // - timeout (pure): Generic timeout → add waits only
        // - navigation: Network issue → skip healing
        if (failure.failureType === 'navigation') {
          logger.info(MOD, 'Skipping healing — navigation/network error', {
            testName: failure.testName,
          });
          trail.skip('Navigation/network error — page or site failed to load. Out of scope for locator healing (environment/infra issue).');
          restoreFile(failure.filePath);
        } else if (failure.failureType === 'assertion' || failure.failureType === 'timeout') {
          logger.info(MOD, 'Skipping locator healing — assertion failure (element found, assertion failed)', {
            testName: failure.testName,
            failureType: failure.failureType,
            failedLocator: failure.failedLocator,
            errorMessage: failure.errorMessage.slice(0, 200),
          });

          // For assertion failures, try adding explicit wait only
          if (failure.isTimingIssue || failure.errorMessage.includes('Received ""') || failure.errorMessage.includes('Received: ""')) {
            logger.info(MOD, 'Assertion failure may be timing-related — attempting wait injection');
            const originalContent = fs.readFileSync(failure.filePath, 'utf-8');
            // Add networkidle wait after goto
            if (!originalContent.includes("waitForLoadState('networkidle')")) {
              const updatedContent = originalContent.replace(
                /(await page\.goto\([^;]+;)/g,
                "$1\n    await page.waitForLoadState('networkidle');"
              );
              if (updatedContent !== originalContent) {
                fs.writeFileSync(failure.filePath, updatedContent, 'utf-8');
                const relativeTestFile = path.relative(path.join(testRepoPath, 'tests'), failure.filePath);
                const rerun = await ExecutionEngine.runAsync(
                  testRepoPath,
                  relativeTestFile,
                  failure.testName,
                  rerunTimeoutMs(),
                  executionProfile,
                  collectHealingArtifacts,
                  true // isHealingRun=true (wait injection is a healing attempt)
                );
                if (rerun.exitCode === 0) {
                  iterationSuccess = true;
                  healedCount++;
                  iterFixCount = 1;
                  trail.record({
                    layer: 'rule_based',
                    candidate: "waitForLoadState('networkidle')",
                    confidence: 0.85,
                    decision: 'applied',
                    reason: 'Timing-related assertion — injected explicit wait, test passed on rerun.',
                  });
                  await updateExecution(executionId, { healing_succeeded: true, status: 'healed' });
                  healings.push({
                    testName: failure.testName,
                    failedLocator: failure.failedLocator || 'assertion',
                    healedLocator: 'Added waitForLoadState(networkidle)',
                    strategy: 'rule_based',
                    aiTokensUsed: 0,
                    success: true,
                    confidence: 0.85,
                    validated: true,
                    validationReason: 'Assertion timing fix — added explicit wait',
                  });
                  const testRow = tests.find((t) => t.testName === failure.testName);
                  if (testRow) { testRow.healed = true; testRow.status = 'healed'; }
                  cleanupBackup(failure.filePath);
                } else {
                  trail.record({
                    layer: 'rule_based',
                    candidate: "waitForLoadState('networkidle')",
                    decision: 'rerun_failed',
                    reason: 'Injected explicit wait, but the assertion still failed — not a timing issue.',
                  });
                  restoreFile(failure.filePath);
                }
              }
            }
          }

          if (!iterationSuccess) {
            // Non-timing assertion/timeout failure: element was found but the
            // assertion did not match (or generic timeout). Nothing to heal.
            // Only add the "skipped" note if no wait-injection attempt was recorded.
            if (trail.attemptCount === 0) {
              trail.skip(
                failure.failureType === 'assertion'
                  ? 'Assertion/functional failure — element found but assertion did not match. Not a locator issue (real product/data defect).'
                  : 'Generic timeout not tied to a specific locator — no locator candidate to heal.',
              );
            }
            restoreFile(failure.filePath);
          }

          // Continue to RCA analysis below (skip the locator healing loop)
        } else if (strategyPlan && !strategyPlan.shouldAttemptLocatorHealing) {
          // ── Diagnosis-first gate ──
          // The failure reached the locator branch by failureType, but the
          // diagnosis says this is NOT a locator-swap candidate — e.g. a
          // locator-typed failure whose selector could not be resolved, or an
          // unclassified failure. Historically the engine would have entered the
          // loop, starved every grounded advisor, let the AI hallucinate a
          // selector, and then mislabel a valid locator as "broken". Instead we
          // report an honest diagnosis and leave the test untouched.
          logger.info(MOD, 'Diagnosis-first: not a locator-swap candidate — reporting instead of healing', {
            testName: failure.testName,
            category: strategyPlan.category,
            remedy: strategyPlan.remedy,
            failedLocator: failure.failedLocator,
          });
          trail.skip(strategyPlan.rationale);
          restoreFile(failure.filePath);
          // Continue to RCA analysis below (skip the locator healing loop)
        } else {

        // Iterative healing loop with retry-per-locator:
        //   For each broken locator, try multiple suggestions (up to RETRIES_PER_LOCATOR).
        //   If a suggestion fails, REVERT the file and try the next suggestion.
        //   Only advance to the next locator when the current one is truly fixed.
        const healedLocators = new Set<string>(); // Cycle detection across locators
        const triedLocators = new Set<string>();   // All tried suggestions (global across retries)

        // ── Re-enable DOM-grounded candidate extraction ──
        // The production worker reruns tests in a subprocess and has no live
        // Playwright page, so previously `domHtml` was always undefined and the
        // orchestrator's DOM candidate path never ran. Ground healing on the most
        // recent DOM snapshot we captured for this page (tenant-scoped). Null is
        // handled gracefully downstream (the DOM candidate step is skipped).
        let domHtmlForFailure: string | undefined;
        try {
          if (failure.url) {
            const snapshotHtml = await getLatestDomHtmlForUrl(
              failure.url,
              job.companyId,
              resolvedProjectId,
            );
            domHtmlForFailure = snapshotHtml ?? undefined;
            if (domHtmlForFailure) {
              logger.info(MOD, 'DOM snapshot found for healing', {
                testName: failure.testName,
                url: failure.url,
                domLength: domHtmlForFailure.length,
              });
            }
          }
        } catch (err: any) {
          logger.warn(MOD, 'DOM snapshot lookup failed (non-critical)', { error: err?.message });
        }

        // ── Fallback: failure-time DOM from the Playwright trace ──
        // A prior crawl snapshot only exists if this app was previously crawled.
        // For a fresh repo (no crawl, no App Profile, no DOM memory) there is no
        // DOM to ground healing on, so the DOM candidate layer never fires and a
        // trivial broken locator (e.g. `#username` → `#user-name`) goes unhealed.
        // The FAILING RUN'S trace already captured the full page DOM — reconstruct
        // it and use it as the DOM source. Failure-time-accurate and free (no AI,
        // no extra browser run). Fully graceful: null when no trace/snapshot.
        if (!domHtmlForFailure && evidenceArtifact.trace_path) {
          try {
            const traceDom = TraceParser.extractDomHtml(evidenceArtifact.trace_path);
            if (traceDom) {
              domHtmlForFailure = traceDom;
              logger.info(MOD, 'DOM reconstructed from trace for healing', {
                testName: failure.testName,
                url: failure.url,
                tracePath: evidenceArtifact.trace_path,
                domLength: traceDom.length,
              });
            }
          } catch (err: any) {
            logger.warn(MOD, 'Trace DOM reconstruction failed (non-critical)', { error: err?.message });
          }
        }

        // ── Repository-grounded healing intelligence (Sprint 2) ──
        // Build a repository-grounding context for this failure once (reused
        // across retry iterations). Fully inert / no DB calls when the
        // ENABLE_HEALING_INTELLIGENCE flag is OFF — returns an empty context so
        // the orchestrator's prompt and confidence scoring are unchanged.
        let repoHealingContext = emptyHealingContext();
        try {
          if (HealingIntelligenceContext.isEnabled()) {
            repoHealingContext = await getHealingIntelligenceContext().load({
              repoId: repoUrl || repo?.url || job.repositoryId,
              companyId: job.companyId,
              projectId: resolvedProjectId,
              failure,
            });
          }
        } catch (err: any) {
          logger.warn(MOD, 'Healing intelligence context build failed (non-critical)', { error: err?.message });
        }

        // ── Application Profile recovery (Application Intelligence) ──
        // Ask the crawl we already built for this app. The Application Profile
        // holds the real, stable selectors (data-test* ids, grounded role/label
        // locators); this connects that asset to healing so a broken locator is
        // recovered from real DOM evidence — 0 AI tokens — before we ever guess.
        // Always available (no feature flag); fully defensive (never throws).
        let appProfileHealing: AppProfileHealingInput | undefined;
        try {
          // TODO: Pass execution base URL (from playwright.config baseURL or BASE_URL env)
          // once the execution layer tracks it. For now the resolver falls back through:
          // failure.url (from TraceParser) → execution base URL (null for now) → latest active profile.
          appProfileHealing = await buildAppProfileHealingInput(
            failure,
            job.companyId,
            resolvedProjectId,
            null, // executionBaseUrl: TODO from execution config
          );
          if (appProfileHealing.candidates.length > 0) {
            logger.info(MOD, 'Application Profile healing candidates ready', {
              testName: failure.testName,
              url: failure.url,
              description: appProfileHealing.description,
              candidateCount: appProfileHealing.candidates.length,
              topLocator: appProfileHealing.candidates[0]?.locator,
            });
          } else if (appProfileHealing.reason) {
            // Log when App Profile returns EMPTY with a reason (for observability / debugging).
            logger.info(MOD, 'Application Profile returned no candidates', {
              testName: failure.testName,
              url: failure.url,
              reason: appProfileHealing.reason,
              profileFound: appProfileHealing.profileFound,
              elementsScanned: appProfileHealing.elementsScanned,
            });
          }
        } catch (err: any) {
          logger.warn(MOD, 'Application Profile healing build failed (non-critical)', { error: err?.message });
        }

        for (let iteration = 0; iteration < MAX_HEAL_ITERATIONS; iteration++) {
          // Stop healing this test if cancelled or out of time (job- or test-level).
          if (isCancelled()) {
            logger.warn(MOD, 'Cancelled mid-test — aborting locator loop', { testName: failure.testName });
            break;
          }
          if (jobBudgetExhausted() || testBudgetExhausted()) {
            logger.warn(MOD, 'Time budget exhausted — stopping locator loop for test', {
              testName: failure.testName, iteration,
              jobElapsedMs: Date.now() - jobStartMs, testElapsedMs: Date.now() - testStartMs,
            });
            break;
          }
          
          jobQueue.updateJob(job.id, {
            progress: `Healing: ${failure.testName} (locator ${iteration + 1})...`,
          });

          // Cycle detection: if we've already fully processed this locator, stop
          if (healedLocators.has(failure.failedLocator)) {
            logger.warn(MOD, 'Cycle detected — already healed this locator, stopping', {
              testName: failure.testName, failedLocator: failure.failedLocator, iteration,
            });
            break;
          }

          // Save file state before attempting any fix for this locator
          const fileContentBeforeFix = fs.readFileSync(failure.filePath, 'utf-8');
          let locatorFixed = false;

          // ── Candidate ranking BEFORE browser execution (the big perf win) ──
          // Collect candidates from EVERY layer in one pass, rank them with cheap
          // browser-free heuristics (syntax validity, source trust, App Profile /
          // DOM Memory / Page Object grounding, confidence, similarity), and try
          // only the best candidate(s) against the browser. This replaces the old
          // "one full Playwright rerun per candidate" loop — the single biggest
          // healing-time bottleneck (≈18 reruns/test → 1–2).
          const ranked = await orchestrator.collectRankedCandidates(
            failure, domHtmlForFailure, triedLocators, resolvedProjectId,
            job.companyId, repoHealingContext, appProfileHealing,
          );
          // Remember the authoritative advisor waterfall for the ExecutionRecord.
          lastDecisionTrail = toAdvisorDecisionTrail(ranked.decisionTrail);

          if (ranked.candidates.length === 0) {
            logger.warn(MOD, 'No viable candidate for locator — skipping', {
              testName: failure.testName, failedLocator: failure.failedLocator, iteration,
            });
            trail.record({
              layer: 'ai_reasoning',
              decision: 'no_candidate',
              reason: 'No syntactically valid candidate from any layer for this locator.',
            });
            break; // nothing to try for this locator → give up on the test
          }

          // Hard cap on how many candidates may actually reach the browser for a
          // single locator. Pre-ranking puts the best candidate first, so 1–2
          // browser reruns typically suffice.
          const maxBrowserTries = Math.min(MAX_BROWSER_TRIES_PER_LOCATOR, ranked.candidates.length);
          // Examine at most this many ranked candidates (cheap rejections aside).
          const maxCandidatesToExamine = Math.min(
            ranked.candidates.length,
            Math.max(RETRIES_PER_LOCATOR, MAX_BROWSER_TRIES_PER_LOCATOR),
          );
          let browserTries = 0;

          // Try the pre-ranked candidates best-first for the SAME broken locator.
          for (let retry = 0; retry < maxCandidatesToExamine; retry++) {
            // Bail out of the (expensive) rerun cycle if cancelled or out of time.
            if (isCancelled() || jobBudgetExhausted() || testBudgetExhausted()) {
              logger.warn(MOD, 'Stopping retry loop — cancelled or time budget exhausted', {
                testName: failure.testName, iteration, retry,
              });
              break;
            }

            // Stop once we have spent our browser-rerun budget for this locator.
            if (browserTries >= maxBrowserTries) {
              logger.info(MOD, 'Browser-rerun budget for locator exhausted', {
                testName: failure.testName, failedLocator: failure.failedLocator,
                iteration, browserTries, maxBrowserTries,
              });
              break;
            }

            const candidate = ranked.candidates[retry];
            triedLocators.add(candidate.newLocator);

            // Adapt the ranked candidate into the HealingOutcome shape the rest of
            // the apply / rerun / learn machinery already understands.
            const outcome: HealingOutcome = {
              suggestion: {
                newLocator: candidate.newLocator,
                strategy: candidate.strategy,
                confidence: candidate.confidence,
                tokensUsed: candidate.tokensUsed,
                reasoning: candidate.reasoning,
                addExplicitWait: candidate.addExplicitWait,
                stabilityScore: candidate.stabilityScore,
              },
              attemptedStrategies: [candidate.strategy],
              decisionTrail: ranked.decisionTrail,
              pageObjectPatch: ranked.pageObjectPatch,
              domMemoryInsight: ranked.domMemoryInsight,
            };

            logger.info(MOD, 'Trying ranked candidate', {
              testName: failure.testName, failedLocator: failure.failedLocator,
              iteration, retry, browserTries,
              candidate: {
                newLocator: candidate.newLocator,
                strategy: candidate.strategy,
                source: candidate.source,
                confidence: Number(candidate.confidence.toFixed(3)),
                score: Number(candidate.score.toFixed(3)),
              },
            });

            // Narrow the type for the rest of the loop (always set above).
            if (!outcome.suggestion) continue;

            // Pre-flight: static validation via Healing Acceptance Engine
            const preCheck = acceptCandidate(outcome.suggestion, failure, fileContentBeforeFix);
            if (preCheck.decision === 'reject') {
              logger.warn(MOD, 'Acceptance pre-check rejected', {
                iteration, retry, reason: preCheck.reason, locator: outcome.suggestion.newLocator,
              });
              trail.record({
                layer: outcome.suggestion.strategy,
                candidate: outcome.suggestion.newLocator,
                confidence: outcome.suggestion.confidence,
                decision: 'rejected',
                reason: `Acceptance pre-check rejected: ${preCheck.reason}`,
              });
              continue; // Skip this suggestion entirely
            }

            const validation = validationLayer.validate(outcome.suggestion, failure);
            if (!validation.approved || !validation.updatedContent) {
              logger.warn(MOD, 'Validation rejected', { iteration, retry, reason: validation.reason });
              trail.record({
                layer: outcome.suggestion.strategy,
                candidate: outcome.suggestion.newLocator,
                confidence: outcome.suggestion.confidence,
                decision: 'rejected',
                reason: `Validation layer rejected: ${validation.reason ?? 'no reason given'}`,
              });
              continue; // Try next suggestion without reverting (no file change made)
            }

            // Apply the fix
            validationLayer.applyValidatedFix(failure.filePath, validation.updatedContent);

            logger.info(MOD, 'Applied fix, running rerun', {
              testName: failure.testName, iteration, retry,
              fixedLocator: failure.failedLocator,
              newLocator: outcome.suggestion.newLocator,
            });

            // Rerun ONLY the current test for isolation. Target the SPEC file
            // (where the test is defined) — NOT failure.filePath, which for a
            // Page Object heal points at the PO source and yields "No tests
            // found" on rerun, so the heal could never be confirmed (the fix was
            // applied correctly but silently reverted). Fall back to filePath
            // when the spec file is unknown (inline-locator failures).
            const rerunTarget = failure.specFilePath ?? failure.filePath;
            const relativeTestFile = path.relative(
              path.join(testRepoPath, 'tests'), rerunTarget,
            );
            const currentTestName = failure.testName;
            browserTries++; // count this candidate against the per-locator browser budget
            const rerun = await ExecutionEngine.runAsync(
              testRepoPath,
              relativeTestFile,
              currentTestName,
              rerunTimeoutMs(),
              executionProfile,
              collectHealingArtifacts,
              true // isHealingRun=true (locator healing attempt)
            );

            logger.info(MOD, 'Rerun result', {
              exitCode: rerun.exitCode, iteration, retry,
              stdout: rerun.stdout?.substring(0, 300),
            });

            if (rerun.exitCode === 0) {
              // Test passes completely!
              locatorFixed = true;
              iterFixCount++;
              lastStrategy = outcome.suggestion.strategy;
              lastConfidence = outcome.suggestion.confidence;
              totalTokensUsed += outcome.suggestion.tokensUsed;

              // Log success
              await logHealing({
                test_execution_id: executionId,
                test_name: failure.testName,
                failed_locator: failure.failedLocator,
                healed_locator: outcome.suggestion.newLocator,
                healing_strategy: outcome.suggestion.strategy,
                ai_tokens_used: outcome.suggestion.tokensUsed,
                success: true,
                confidence: outcome.suggestion.confidence,
                validation_status: 'approved',
                validation_reason: `[Iter ${iteration + 1} R${retry + 1}] ${outcome.suggestion.reasoning}`,
                patch_path: validation.patchPath,
                decision_trail: outcome.decisionTrail,
                ...pageObjectPatchLogFields(outcome),
                project_id: resolvedProjectId ?? null,
              }, job.companyId);

              // Feed the confirmed heal back into DOM Memory so future heals get
              // smarter (and cheaper). Scoped to project + company.
              await orchestrator.recordHealObservation({
                failedSelector: failure.failedLocator,
                healedSelector: outcome.suggestion.newLocator,
                strategy: outcome.suggestion.strategy,
                projectId: resolvedProjectId,
                companyId: job.companyId,
                pageUrl: failure.url || undefined,
              });

              // Close the learning loop AUTOMATICALLY: the heal was applied and
              // the test rerun went green in-process, so record a 'pass' outcome
              // and let the confidence score learn. Best-effort & non-blocking.
              await healingVerificationService.recordOutcomeFromRerun({
                companyId: job.companyId,
                projectId: resolvedProjectId,
                baseUrl: failure.url,
                originalSelector: failure.failedLocator,
                healedSelector: outcome.suggestion.newLocator,
                strategy: outcome.suggestion.strategy,
                suggestedConfidence: outcome.suggestion.confidence,
                result: 'pass',
                testName: failure.testName,
                durationMs: rerun.durationMs,
              });

              healings.push({
                testName: failure.testName,
                failedLocator: failure.failedLocator,
                healedLocator: outcome.suggestion.newLocator,
                strategy: outcome.suggestion.strategy,
                aiTokensUsed: outcome.suggestion.tokensUsed,
                success: true,
                confidence: outcome.suggestion.confidence,
                validated: true,
                validationReason: `[Iter ${iteration + 1} R${retry + 1}] ${outcome.suggestion.reasoning}`,
                patchPath: validation.patchPath,
              });

              iterationSuccess = true;
              break; // Done with this locator AND this test
            }

            // Rerun failed — check if a DIFFERENT locator failed (meaning our fix worked
            // for this locator but the test hit the next broken locator)
            let newArtifacts: any[] = [];
            try {
              newArtifacts = collector.collect(rerun.resultsFile, testRepoPath);
            } catch (e) {
              logger.warn(MOD, 'Could not collect rerun artifacts', { error: (e as Error).message });
            }

            const sameTestArtifacts = newArtifacts.filter((a: any) => {
              const nf = analyzer.analyze(a);
              return nf.filePath === failure.filePath && nf.testName === currentTestName;
            });

            // Check if this locator fix was correct (test progressed to a different locator)
            const nextFailure = sameTestArtifacts.length > 0
              ? analyzer.analyze(sameTestArtifacts[0])
              : null;

            if (sameTestArtifacts.length === 0) {
              // No failure artifacts for this test in the rerun results.
              // But exitCode != 0, so something still failed — could be:
              //   a) Our fix healed this test but another test in the same file failed (grep leak)
              //   b) Artifact collection couldn't parse the error format
              //   c) Test name mismatch in artifact filter
              // SAFETY: Do a dedicated confirmation rerun with only this test.
              logger.info(MOD, 'No artifacts but exitCode!=0, running confirmation rerun', {
                testName: failure.testName, iteration, retry,
                exitCode: rerun.exitCode,
              });
              const confirmRerun = await ExecutionEngine.runAsync(
                testRepoPath,
                relativeTestFile,
                currentTestName,
                rerunTimeoutMs(),
                executionProfile,
                collectHealingArtifacts,
                true // isHealingRun=true (confirmation rerun)
              );
              if (confirmRerun.exitCode === 0) {
                // Confirmed healed!
                locatorFixed = true;
                iterFixCount++;
                lastStrategy = outcome.suggestion.strategy;
                lastConfidence = outcome.suggestion.confidence;
                totalTokensUsed += outcome.suggestion.tokensUsed;
                iterationSuccess = true;

                await logHealing({
                  test_execution_id: executionId,
                  test_name: failure.testName,
                  failed_locator: failure.failedLocator,
                  healed_locator: outcome.suggestion.newLocator,
                  healing_strategy: outcome.suggestion.strategy,
                  ai_tokens_used: outcome.suggestion.tokensUsed,
                  success: true,
                  confidence: outcome.suggestion.confidence,
                  validation_status: 'approved',
                  validation_reason: `[Iter ${iteration + 1} R${retry + 1}] Confirmed healed via confirmation rerun.`,
                  patch_path: validation.patchPath,
                  decision_trail: outcome.decisionTrail,
                  ...pageObjectPatchLogFields(outcome),
                  project_id: resolvedProjectId ?? null,
                }, job.companyId);

                await orchestrator.recordHealObservation({
                  failedSelector: failure.failedLocator,
                  healedSelector: outcome.suggestion.newLocator,
                  strategy: outcome.suggestion.strategy,
                  projectId: resolvedProjectId,
                  companyId: job.companyId,
                  pageUrl: failure.url || undefined,
                });

                // Learning loop: confirmation rerun went green → record 'pass'.
                await healingVerificationService.recordOutcomeFromRerun({
                  companyId: job.companyId,
                  projectId: resolvedProjectId,
                  baseUrl: failure.url,
                  originalSelector: failure.failedLocator,
                  healedSelector: outcome.suggestion.newLocator,
                  strategy: outcome.suggestion.strategy,
                  suggestedConfidence: outcome.suggestion.confidence,
                  result: 'pass',
                  testName: failure.testName,
                  durationMs: confirmRerun.durationMs,
                });

                healings.push({
                  testName: failure.testName,
                  failedLocator: failure.failedLocator,
                  healedLocator: outcome.suggestion.newLocator,
                  strategy: outcome.suggestion.strategy,
                  aiTokensUsed: outcome.suggestion.tokensUsed,
                  success: true,
                  confidence: outcome.suggestion.confidence,
                  validated: true,
                  validationReason: `[Iter ${iteration + 1} R${retry + 1}] Confirmed healed via confirmation rerun.`,
                  patchPath: validation.patchPath,
                });

                break;
              }

              // Confirmation rerun also failed — try to get fresh artifacts
              let confirmArtifacts: any[] = [];
              try {
                confirmArtifacts = collector.collect(confirmRerun.resultsFile, testRepoPath);
              } catch (e2) {
                logger.warn(MOD, 'Confirmation rerun artifact collection failed', { error: (e2 as Error).message });
              }
              const confirmTestArtifacts = confirmArtifacts.filter((a: any) => {
                const nf = analyzer.analyze(a);
                return nf.filePath === failure.filePath && nf.testName === currentTestName;
              });
              if (confirmTestArtifacts.length > 0) {
                const confirmFailure = analyzer.analyze(confirmTestArtifacts[0]);
                if (confirmFailure.failedLocator && confirmFailure.failedLocator !== failure.failedLocator) {
                  // Different locator — treat as progression
                  locatorFixed = true;
                  iterFixCount++;
                  healedLocators.add(failure.failedLocator);
                  failure = confirmFailure;
                  logger.info(MOD, 'Confirmation rerun shows different locator — advancing', {
                    newLocator: confirmFailure.failedLocator,
                  });
                  break;
                }
              }

              // Still can't determine — revert and try next suggestion.
              //
              // OBSERVABILITY: the generic "no parseable failure artifact" message
              // hid the REAL reason a rerun could not be confirmed (e.g. the
              // process exited BEFORE any test ran: `xvfb-run: xauth command not
              // found`, an unknown CLI flag, OOM, or a timeout). Surface the
              // confirmation rerun's exit code, whether a results file was
              // produced, and a tail of stderr so the decision trail is
              // self-diagnosing instead of a guessing game.
              const noResultsFile = !confirmRerun.resultsFile || !fs.existsSync(confirmRerun.resultsFile);
              const stderrTail = (confirmRerun.stderr || '').trim().split('\n').slice(-3).join(' ').slice(-300);
              const rerunCrashedBeforeTests = noResultsFile && confirmRerun.exitCode !== 0;
              const diagnostic =
                `rerun exit=${confirmRerun.exitCode}, resultsFile=${noResultsFile ? 'MISSING' : 'present'}` +
                (stderrTail ? `, stderr: ${stderrTail}` : '');
              const revertReason = rerunCrashedBeforeTests
                ? `Candidate applied, but the confirmation rerun CRASHED BEFORE ANY TEST RAN — no results file was produced, so the heal could not be confirmed (reverted). This is an environment/runner failure, not a bad candidate. Diagnostic: ${diagnostic}`
                : `Candidate applied, but the rerun produced no passing result and no parseable failure artifact, so the heal could not be confirmed (reverted). Diagnostic: ${diagnostic}`;
              logger.warn(MOD, 'Cannot confirm fix, reverting', {
                iteration, retry,
                rerunExitCode: confirmRerun.exitCode,
                resultsFileMissing: noResultsFile,
                rerunCrashedBeforeTests,
                stderrTail,
              });
              trail.record({
                layer: outcome.suggestion.strategy,
                candidate: outcome.suggestion.newLocator,
                confidence: outcome.suggestion.confidence,
                decision: 'rerun_failed',
                reason: revertReason,
              });
              fs.writeFileSync(failure.filePath, fileContentBeforeFix, 'utf-8');
              continue;
            }

            // Use Healing Acceptance Engine for live validation decision
            const liveInput: LiveValidationInput = {
              exitCode: rerun.exitCode,
              newFailedLocator: nextFailure?.failedLocator ?? null,
              appliedLocator: outcome.suggestion.newLocator,
              originalLocator: failure.failedLocator,
              sameTestArtifactCount: sameTestArtifacts.length,
            };
            const liveDecision = acceptCandidate(outcome.suggestion, failure, fileContentBeforeFix, liveInput);

            if (liveDecision.decision !== 'reject' && nextFailure && nextFailure.failedLocator !== failure.failedLocator) {
              // TRULY different locator failed — our fix for this locator was correct!
              // Keep the fix, log it, and advance to the next locator
              locatorFixed = true;
              iterFixCount++;
              lastStrategy = outcome.suggestion.strategy;
              lastConfidence = outcome.suggestion.confidence;
              totalTokensUsed += outcome.suggestion.tokensUsed;

              await logHealing({
                test_execution_id: executionId,
                test_name: failure.testName,
                failed_locator: failure.failedLocator,
                healed_locator: outcome.suggestion.newLocator,
                healing_strategy: outcome.suggestion.strategy,
                ai_tokens_used: outcome.suggestion.tokensUsed,
                success: false,
                confidence: outcome.suggestion.confidence,
                validation_status: 'approved',
                validation_reason: `[Iter ${iteration + 1} R${retry + 1}] ${outcome.suggestion.reasoning}`,
                patch_path: validation.patchPath,
                decision_trail: outcome.decisionTrail,
                ...pageObjectPatchLogFields(outcome),
                project_id: resolvedProjectId ?? null,
              }, job.companyId);

              healings.push({
                testName: failure.testName,
                failedLocator: failure.failedLocator,
                healedLocator: outcome.suggestion.newLocator,
                strategy: outcome.suggestion.strategy,
                aiTokensUsed: outcome.suggestion.tokensUsed,
                success: false,
                confidence: outcome.suggestion.confidence,
                validated: true,
                validationReason: `[Iter ${iteration + 1} R${retry + 1}] ${outcome.suggestion.reasoning}`,
                patchPath: validation.patchPath,
              });

              await storePattern({
                test_name: failure.testName,
                error_pattern: failure.errorPattern,
                failed_locator: failure.failedLocator,
                healed_locator: outcome.suggestion.newLocator,
                solution_strategy: outcome.suggestion.strategy,
                confidence: outcome.suggestion.confidence,
                avg_tokens_saved: outcome.suggestion.tokensUsed,
              }, job.companyId, resolvedProjectId);

              // The fix for THIS locator was correct (a different locator now
              // fails), so record it into DOM Memory to strengthen the moat.
              await orchestrator.recordHealObservation({
                failedSelector: failure.failedLocator,
                healedSelector: outcome.suggestion.newLocator,
                strategy: outcome.suggestion.strategy,
                projectId: resolvedProjectId,
                companyId: job.companyId,
                pageUrl: failure.url || undefined,
              });

              // Learning loop: the healed selector for THIS element worked — the
              // rerun progressed to a DIFFERENT locator — so record a 'pass' for
              // this element even though the test as a whole isn't green yet.
              await healingVerificationService.recordOutcomeFromRerun({
                companyId: job.companyId,
                projectId: resolvedProjectId,
                baseUrl: failure.url,
                originalSelector: failure.failedLocator,
                healedSelector: outcome.suggestion.newLocator,
                strategy: outcome.suggestion.strategy,
                suggestedConfidence: outcome.suggestion.confidence,
                result: 'pass',
                testName: failure.testName,
                durationMs: rerun.durationMs,
              });

              // Advance to next locator
              healedLocators.add(failure.failedLocator); // Mark current locator as done
              failure = nextFailure;
              break; // Exit retry loop, continue outer iteration loop
            }

            // SAME locator still failing (or a mutation of it) — REVERT and try next suggestion
            logger.info(MOD, 'Fix did not work, reverting file', {
              testName: failure.testName, failedLocator: failure.failedLocator,
              triedLocator: outcome.suggestion.newLocator, iteration, retry,
            });
            trail.record({
              layer: outcome.suggestion.strategy,
              candidate: outcome.suggestion.newLocator,
              confidence: outcome.suggestion.confidence,
              decision: 'rerun_failed',
              reason: 'Candidate applied, but the same locator still failed on rerun (reverted).',
            });
            fs.writeFileSync(failure.filePath, fileContentBeforeFix, 'utf-8');

            await logHealing({
              test_execution_id: executionId,
              test_name: failure.testName,
              failed_locator: failure.failedLocator,
              healed_locator: outcome.suggestion.newLocator,
              healing_strategy: outcome.suggestion.strategy,
              ai_tokens_used: outcome.suggestion.tokensUsed,
              success: false,
              confidence: outcome.suggestion.confidence,
              validation_status: 'reverted',
              validation_reason: `[Iter ${iteration + 1} R${retry + 1}] Reverted — same locator still failing.`,
              patch_path: validation.patchPath,
              decision_trail: outcome.decisionTrail,
              ...pageObjectPatchLogFields(outcome),
              project_id: resolvedProjectId ?? null,
            }, job.companyId);

            // Learning loop: the healed selector did NOT fix this element (same
            // locator still failing, fix reverted) → record a 'fail' so the
            // confidence score learns this selector/strategy didn't work here.
            await healingVerificationService.recordOutcomeFromRerun({
              companyId: job.companyId,
              projectId: resolvedProjectId,
              baseUrl: failure.url,
              originalSelector: failure.failedLocator,
              healedSelector: outcome.suggestion.newLocator,
              strategy: outcome.suggestion.strategy,
              suggestedConfidence: outcome.suggestion.confidence,
              result: 'fail',
              testName: failure.testName,
              durationMs: rerun.durationMs,
            });
          } // end retry loop

          if (iterationSuccess) break;

          if (!locatorFixed) {
            // Exhausted all suggestions for this locator — give up on this test
            logger.warn(MOD, 'Exhausted suggestions for locator', {
              testName: failure.testName, failedLocator: failure.failedLocator,
            });
            break;
          }
        } // end iteration loop

        if (iterationSuccess) {
          healedCount++;
          await updateExecution(executionId, { healing_succeeded: true, status: 'healed' });
          cleanupBackup(failure.filePath);

          // Mark all healings for this test as successful
          for (const h of healings) {
            if (h.testName === failure.testName) {
              h.success = true;
            }
          }

          const testRow = tests.find((t) => t.testName === failure.testName);
          if (testRow) {
            testRow.healed = true;
            testRow.status = 'healed';
          }

          logger.info(MOD, 'Healing success (iterative)', {
            testName: failure.testName,
            fixesApplied: iterFixCount,
            lastStrategy,
          });
        } else {
          // Iterative healing failed — roll back all changes
          restoreFile(failure.filePath);
          logger.warn(MOD, 'Iterative healing failed — rolled back', {
            testName: failure.testName,
            fixesAttempted: iterFixCount,
          });
        }

        } // end else (locator healing branch)
      } catch (error) {
        restoreFile(failure.filePath);
        logger.error(MOD, 'Healing failed for test', {
          testName: failure.testName,
          error: (error as Error).message,
        });
      } finally {
        if (fs.existsSync(backupPath)) cleanupBackup(failure.filePath);
      }

      // --- Finalize the 3-layer healing trail for this failure ---
      // If the failure was healed via the locator loop, synthesize the winning
      // "applied" attempt from the recorded strategy/confidence + healed entry
      // (the deep rerun branches don't record it inline).
      if (iterationSuccess && !trail.hasApplied) {
        const healedEntry = healings.find((h) => h.testName === failure.testName && h.success);
        trail.record({
          layer: lastStrategy,
          candidate: healedEntry?.healedLocator,
          confidence: lastConfidence || healedEntry?.confidence,
          decision: 'applied',
          reason: 'Candidate applied and the test passed on rerun.',
        });
      }
      const finalizedTrail = trail.finalize(iterationSuccess ? 'healed' : 'not_healed');
      healingTrails.push(finalizedTrail);

      // ── Finalize the canonical Execution Record (Stages 4–6) ──
      // Healing / Validation / Learning are derived from the per-test aggregates
      // the loop already computed (the deep nested branches mutate
      // healings/lastStrategy/iterationSuccess), so the canonical decision is the
      // final applied outcome. The dashboard reads this one record.
      try {
        const healingForTest = healings.find((h) => h.testName === failure.testName);
        const appliedAttempt = finalizedTrail.attempts.find((a) => a.decision === 'applied');
        const attemptedStrategies = Array.from(
          new Set(finalizedTrail.attempts.map((a) => a.layer)),
        );
        // The healing phase (incl. validation reruns interleaved with it) ran from
        // `healStartMs` until now; the learning write-back happens after this.
        const healEndMs = Date.now();
        // Stage 4 — what we decided to do and the fix we applied.
        execRecord = recordHealingDecision(execRecord, buildHealingDecision({
          remedy: strategyPlan?.recommendedStrategy ?? failure.diagnosis?.recommendedStrategy,
          attemptedStrategies,
          appliedStrategy: appliedAttempt?.layer ?? (healingForTest?.success ? healingForTest.strategy : null),
          source: healingForTest?.success ? healingForTest.strategy : null,
          brokenLocator: healingForTest?.failedLocator ?? failure.diagnosis?.locator ?? null,
          newLocator: healingForTest?.success ? healingForTest.healedLocator : null,
          candidatesConsidered: finalizedTrail.attempts.length,
          reportOnly: !healingForTest?.success && finalizedTrail.outcome === 'not_healed',
          rationale: finalizedTrail.summary,
        }));
        // Persist the authoritative advisor waterfall so the Decision Trail card
        // renders fact (which advisors won / were consulted / skipped), not inference.
        if (lastDecisionTrail.length > 0) {
          execRecord = recordHealingDecision(execRecord, { decisionTrail: lastDecisionTrail });
        }
        // Stamp the healing-phase timing (validation reruns are part of this span).
        execRecord = recordHealingDecision(execRecord, {
          timing: makeSectionTiming(healStartMs, healEndMs),
        });
        execRecord = appendEvent(execRecord, { type: 'healing_completed' });
        // Stage 5 — did the applied fix hold up on rerun? (Validation reruns are
        // interleaved with healing, so its wall-clock span is the healing window.)
        execRecord = recordValidation(execRecord, {
          reran: !!healingForTest,
          passedAfterHealing: healingForTest ? healingForTest.success : null,
          notes: healingForTest?.validationReason ? [healingForTest.validationReason] : [],
          timing: healingForTest ? makeSectionTiming(healStartMs, healEndMs) : undefined,
        });
        if (healingForTest) {
          execRecord = appendEvent(execRecord, {
            type: 'validation_completed',
            note: healingForTest.success ? 'passed' : 'failed',
          });
        }
        // Stage 6 — what we wrote back to memory (a successful heal closes the
        // learning loop + updates DOM Memory in the locator branches above).
        execRecord = setStage(execRecord, 'learning');
        execRecord = recordLearning(execRecord, {
          recorded: !!(healingForTest?.success),
          domMemoryUpdated: !!(healingForTest?.success),
          timing: makeSectionTiming(healEndMs, Date.now()),
        });
        execRecord = appendEvent(execRecord, { type: 'learning_completed' });
        // Finalize the lifecycle: STATUS reflects HOW the run ended (completed
        // normally, cancelled by the user, or stopped by the time budget) while
        // RESULT reflects the OUTCOME (healed vs fail). Kept strictly separate.
        const testEndMs = Date.now();
        const healed = iterationSuccess;
        const cancelled = isCancelled();
        const timedOut = !healed && (testBudgetExhausted() || jobBudgetExhausted());
        execRecord = setLifecycle(execRecord, {
          status: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'completed',
          result: healed ? 'healed' : 'fail',
          stage: 'completed',
        });
        execRecord = {
          ...execRecord,
          durationMs: testEndMs - testStartMs,
          endTime: new Date(testEndMs).toISOString(),
        };
        await persistExecutionRecordSafe(execRecord, job.companyId, resolvedProjectId);
        logger.info(MOD, 'Execution Record persisted', {
          executionId: execRecord.executionId,
          testName: execRecord.testName,
          status: execRecord.status,
          result: execRecord.result,
          healed: !!healingForTest?.success,
        });
      } catch (recErr) {
        logger.warn(MOD, 'Failed to persist Execution Record (non-blocking)', {
          testName: failure.testName,
          error: (recErr as Error).message,
        });
      }

      // Record tests we had to stop early due to the time budget (not healed and
      // we were out of time). Surfaced in the job summary so a partial run is honest.
      if (healedCount === healedBeforeTest && (testBudgetExhausted() || jobBudgetExhausted() || isCancelled())) {
        timedOutTests++;
        logger.warn(MOD, 'Test left unhealed due to time budget/cancellation', {
          testName: failure.testName,
        });
      }

      // --- RCA Analysis for this failure ---
      // Skip the (AI-backed) RCA step entirely when cancelled or out of budget so
      // cancellation/timeout takes effect promptly instead of running more AI calls.
      if (rcaEngine && !isCancelled() && !jobBudgetExhausted()) {
        try {
          const healingForTest = healings.find((h) => h.testName === failure.testName);
          const rcaResult = await rcaEngine.analyze({
            failure,
            jobId: job.id,
            healingAttempted: !!healingForTest,
            healingSucceeded: healingForTest?.success ?? false,
            healedLocator: healingForTest?.healedLocator,
            healingStrategy: healingForTest?.strategy,
          });

          rcaResults.push(rcaResult);

          await logRCA({
            test_execution_id: String(executionId),
            job_id: job.id,
            test_name: failure.testName,
            root_cause: rcaResult.rootCause,
            classification: rcaResult.classification,
            severity: rcaResult.severity,
            confidence: rcaResult.confidence,
            suggested_fix: rcaResult.suggestedFix,
            affected_component: rcaResult.affectedComponent,
            is_flaky: rcaResult.isFlaky,
            flaky_reason: rcaResult.flakyReason ?? undefined,
            summary: rcaResult.summary,
            technical_details: rcaResult.technicalDetails,
            tokens_used: rcaResult.tokensUsed,
            model: rcaResult.model,
            analysis_time_ms: rcaResult.analysisTimeMs,
            healing_attempted: !!healingForTest,
            healing_succeeded: healingForTest?.success ?? false,
            healed_locator: healingForTest?.healedLocator,
            healing_strategy: healingForTest?.strategy,
            error_message: failure.errorMessage?.slice(0, 1000),
          }, job.companyId);

          logger.info(MOD, 'RCA analysis complete', {
            testName: failure.testName,
            classification: rcaResult.classification,
            severity: rcaResult.severity,
            confidence: rcaResult.confidence,
          });

          // Fire-and-forget: Slack RCA notification + Jira ticket
          notifyRca({
            testName: failure.testName,
            classification: rcaResult.classification,
            severity: rcaResult.severity,
            rootCause: rcaResult.rootCause,
            suggestedFix: rcaResult.suggestedFix,
            isFlaky: rcaResult.isFlaky,
          }).catch((err) => logger.error(MOD, 'Slack RCA notify failed', { error: (err as Error).message }));

          createRcaTicket({
            testName: failure.testName,
            classification: rcaResult.classification,
            severity: rcaResult.severity,
            rootCause: rcaResult.rootCause,
            suggestedFix: rcaResult.suggestedFix,
            affectedComponent: rcaResult.affectedComponent,
            isFlaky: rcaResult.isFlaky,
            jobId: job.id,
            repoName: repo?.name,
            branch: job.branch,
            healingAttempted: !!healingForTest,
            healingSucceeded: healingForTest?.success ?? false,
          }).catch((err) => logger.error(MOD, 'Jira ticket creation failed', { error: (err as Error).message }));
        } catch (rcaError) {
          logger.error(MOD, 'RCA analysis failed', {
            testName: failure.testName,
            error: (rcaError as Error).message,
          });
        }
      }
    }

    // ── Backfill PASS/SKIP Execution Records for the rest of the run ──
    // The failure loop above recorded every failing/healed test. The PROVIDER
    // already built one finalized record for every NON-failing test (passes +
    // skips) in `execResult.records` — persist those the failure loop didn't, so
    // the canonical store reflects the full run (exactly one record per test).
    // Then assert the invariant and reconcile counts against the legacy totals
    // (the universe is re-read from the local results file for verification).
    try {
      const universe: EnumeratedTest[] = enumerateAllTests(run.resultsFile);
      for (const rec of execResult.records) {
        if (recordedTests.has(rec.testName)) continue; // already recorded by the failure loop
        const ok = await persistExecutionRecordSafe(rec, job.companyId, resolvedProjectId);
        if (ok) recordedTests.add(rec.testName);
      }

      // Invariant: exactly one ExecutionRecord per test in the run universe.
      const recordedList = Array.from(recordedTests).map((testName) => ({ testName }));
      const invariant = assertOneRecordPerTest(recordedList, universe);
      if (!invariant.ok) {
        logger.warn(MOD, '⚠️ ExecutionRecord invariant violated (1 test = 1 record)', {
          jobId: job.id,
          violations: invariant.violations.slice(0, 20),
        });
      }
      // Parity: reconcile aggregated record results with the legacy job tallies.
      const counts = summarizeResultCounts(
        universe.map((t) => ({ result: deriveResult(t.status).result })),
      );
      logger.info(MOD, 'ExecutionRecord parity check', {
        jobId: job.id,
        universeTests: universe.length,
        recordedTests: recordedTests.size,
        resultCounts: counts,
        invariantOk: invariant.ok,
      });
    } catch (backfillErr) {
      logger.warn(MOD, 'Failed to backfill/verify Execution Records (non-blocking)', {
        jobId: job.id, error: (backfillErr as Error).message,
      });
    }

    // --- GitHub PR Automation ---
    let prResult: PRResult | null = null;
    const githubToken = process.env['GITHUB_TOKEN'];
    if (githubToken && healedCount > 0) {
      try {
        jobQueue.updateJob(job.id, { progress: 'Creating GitHub PR...' });

        const healingSummaries: HealingSummary[] = healings
          .filter((h) => h.success)
          .map((h) => ({
            testName: h.testName,
            failedLocator: h.failedLocator,
            healedLocator: h.healedLocator,
            strategy: h.strategy,
            confidence: h.confidence,
            filePath: '', // relative path captured in PR diff
          }));

        prResult = await createHealingPR({
          repoPath: testRepoPath,
          repoUrl,
          branch,
          jobId: job.id,
          healings: healingSummaries,
          totalTests: tests.length,
          failedTests: tests.filter((t) => t.status !== 'passed' && t.status !== 'healed').length,
          healedTests: healedCount,
          githubToken,
        });

        if (prResult) {
          const parsed = parseRepoUrl(repoUrl);
          await logPR({
            job_id: job.id,
            pr_url: prResult.prUrl,
            pr_number: prResult.prNumber,
            branch_name: prResult.branchName,
            commit_sha: prResult.commitSha,
            repo_owner: parsed?.owner ?? 'unknown',
            repo_name: parsed?.repo ?? 'unknown',
            base_branch: branch,
            files_changed: prResult.filesChanged,
            healing_count: prResult.healingCount,
            status: 'open',
          }, job.companyId);

          logger.info(MOD, 'PR created and logged', {
            prUrl: prResult.prUrl,
            prNumber: prResult.prNumber,
          });
        }
      } catch (prError) {
        logger.error(MOD, 'GitHub PR automation failed (non-blocking)', {
          error: (prError as Error).message,
        });
      }
    } else if (!githubToken && healedCount > 0) {
      logger.info(MOD, 'Skipping PR creation — GITHUB_TOKEN not configured');
    }

    // Generate report
    const now = new Date().toISOString();
    const hist = await getHistoricalStats();
    const reportData: ReportData = {
      timestamp: now,
      commitSha: job.commit || 'unknown',
      repo: job.repositoryId,
      siteUrl: '',
      totalTests: tests.length,
      passed: tests.filter((t) => t.status === 'passed').length,
      failed: tests.filter((t) => t.status !== 'passed' && t.status !== 'healed').length,
      healed: healedCount,
      validationRejected: 0,
      patchesGenerated: healings.length,
      totalTokensUsed,
      tests,
      healings,
      rcaAnalyses: rcaResults.map((r) => ({
        testName: r.affectedComponent || 'unknown',
        classification: r.classification,
        severity: r.severity,
        confidence: r.confidence,
        rootCause: r.rootCause,
        suggestedFix: r.suggestedFix,
        isFlaky: r.isFlaky,
        affectedComponent: r.affectedComponent,
      })),
      prInfo: prResult ? {
        prUrl: prResult.prUrl,
        prNumber: prResult.prNumber,
        branchName: prResult.branchName,
        filesChanged: prResult.filesChanged.length,
      } : null,
      historicalStats: hist,
    };

    const reportPath = path.join(reportDir, `report-${job.id}-${now.replace(/[:.]/g, '-')}.html`);
    generateReport(reportData, reportPath);

    return {
      totalTests: tests.length,
      failed: tests.filter((t) => t.status !== 'passed' && t.status !== 'healed').length,
      healed: healedCount,
      // Honest reporting: how many tests we stopped on due to the time budget or
      // a user cancellation, plus the total job wall-clock time.
      timedOut: timedOutTests,
      stoppedEarly: timedOutTests > 0 || isCancelled() || jobBudgetExhausted(),
      durationMs: Date.now() - jobStartMs,
      strategy: healings[0]?.strategy || 'none',
      tokensUsed: totalTokensUsed,
      testResults: tests,
      healingActions: healings,
      // 3-layer healing observability: per-failure attempt trail + honest summary.
      healingTrails,
      healingSummary: summarizeHealingTrails(healingTrails),
      rcaAnalyses: rcaResults.map((r) => ({
        testName: r.summary.split(':')[0] || 'unknown',
        classification: r.classification,
        severity: r.severity,
        confidence: r.confidence,
        rootCause: r.rootCause,
        suggestedFix: r.suggestedFix,
        isFlaky: r.isFlaky,
      })),
      pullRequest: prResult ? {
        prUrl: prResult.prUrl,
        prNumber: prResult.prNumber,
        branchName: prResult.branchName,
        filesChanged: prResult.filesChanged,
      } : null,
      reportPath,
    };
  };
}
