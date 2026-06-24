/**
 * REST API Server — Express server for the AI Self-Healing Agent.
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
import { JobQueue } from './queue/job-queue';
import { RepoManager } from './services/repo-manager';
import { logger } from '../utils/logger';
import { initDb, closeDb, getDatabaseHealth } from '../db/postgres';

// Import healing pipeline components
import { ExecutionEngine } from '../core/execution-engine';
import { ArtifactCollector, extractTopLevelErrors } from '../core/artifact-collector';
import { FailureAnalyzer } from '../core/failure-analyzer';
import { HealingOrchestrator } from '../core/healing-orchestrator';
import { HealingStrategySelector, type StrategyConfig } from '../core/healing-strategy-selector';
import { RuleEngine } from '../engines/rule-engine';
import { PatternEngine } from '../engines/pattern-engine';
import { AIEngine } from '../engines/ai-engine';
import { OpenAIClient } from '../ai/openai-client';
import { ValidationLayer } from '../validation/validation-layer';
import { acceptCandidate, type LiveValidationInput } from '../core/healing-acceptance';
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
  getLatestDomHtmlForUrl,
  type HealingSettings,
} from '../db/postgres';
import {
  HealingIntelligenceContext,
  getHealingIntelligenceContext,
  emptyHealingContext,
} from '../services/healing-intelligence-context';
import type { HealingJob } from './queue/job-queue';

const MOD = 'api-server';

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

    // Step 1: Clone/pull repo (MUST succeed — failing here means stale/missing code)
    jobQueue.updateJob(job.id, { progress: 'Cloning/pulling repository...' });
    try {
      fs.mkdirSync(workspaceDir, { recursive: true });
      await ExecutionEngine.cloneRepository(repoUrl, testRepoPath, branch);
      // Verify the tests directory exists after clone
      const testsDir = path.join(testRepoPath, 'tests');
      const pkgFile = path.join(testRepoPath, 'package.json');
      const testFiles = fs.existsSync(testsDir) ? fs.readdirSync(testsDir).filter(f => f.endsWith('.spec.ts') || f.endsWith('.test.ts')) : [];
      logger.info(MOD, 'Repository ready', {
        testRepoPath,
        hasTestsDir: fs.existsSync(testsDir),
        testFileCount: testFiles.length,
        testFiles: testFiles.slice(0, 10),
        hasPackageJson: fs.existsSync(pkgFile),
      });
    } catch (error) {
      const errMsg = (error as Error).message;
      logger.error(MOD, 'Clone/pull FAILED', { error: errMsg, repoUrl, testRepoPath });
      // If directory exists with tests, continue with warning; otherwise fail
      if (!fs.existsSync(path.join(testRepoPath, 'package.json'))) {
        jobQueue.updateJob(job.id, { progress: `FAILED: Repository clone failed — ${errMsg}` });
        return {
          totalTests: 0, failed: 0, healed: 0, strategy: 'none', tokensUsed: 0,
          testResults: { exitCode: 128, durationMs: 0 },
          healingActions: [],
          message: `Repository clone/pull failed: ${errMsg}. Verify the repo URL is accessible and the branch exists.`,
          error: errMsg,
        };
      }
      logger.warn(MOD, 'Clone failed but repo directory exists, continuing with existing code', {
        testRepoPath,
      });
    }

    // Step 2: Install dependencies (MUST succeed before running tests)
    jobQueue.updateJob(job.id, { progress: 'Installing dependencies...' });
    try {
      await ExecutionEngine.installDependencies(testRepoPath);
    } catch (error) {
      const errMsg = (error as Error).message;
      logger.error(MOD, 'Dependency install FAILED — cannot proceed with test execution', {
        error: errMsg,
        testRepoPath,
      });
      jobQueue.updateJob(job.id, { progress: `FAILED: ${errMsg}` });
      return {
        totalTests: 0,
        failed: 0,
        healed: 0,
        strategy: 'none',
        tokensUsed: 0,
        testResults: { exitCode: 127, durationMs: 0 },
        healingActions: [],
        message: `Dependency installation failed: ${errMsg}. Check that the repository has a valid package.json and npm install can succeed.`,
        error: errMsg,
      };
    }

    // Step 3: Run tests
    // When the job specifies a single test file, scope the run to it; otherwise run the whole suite.
    jobQueue.updateJob(job.id, {
      progress: job.testFile ? `Running tests (${job.testFile})...` : 'Running tests...',
    });
    const run = ExecutionEngine.run(testRepoPath, job.testFile);

    // Step 4: Collect artifacts
    jobQueue.updateJob(job.id, { progress: 'Collecting failure artifacts...' });
    const collector = new ArtifactCollector();
    let artifacts: any[] = [];
    try {
      artifacts = collector.collect(run.resultsFile, testRepoPath);
    } catch (error) {
      logger.warn(MOD, 'Artifact collection failed', {
        error: (error as Error).message,
      });
    }

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

      const result = {
        totalTests: run.exitCode === 0 ? 1 : 0,
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

    // ── Issue #3: apply admin-configured healing strategy settings ──
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
    let healedCount = 0;
    let totalTokensUsed = 0;

    // RCA engine (instantiate once per job)
    const rcaEngine = process.env['OPENAI_API_KEY']
      ? new RCAEngine({ apiKey: process.env['OPENAI_API_KEY'] })
      : null;

    const MAX_HEAL_ITERATIONS = 15; // Max locator fixes per test before giving up

    // De-duplicate artifacts by test name (multiple artifacts may come from the same test)
    const seenTests = new Set<string>();
    const uniqueArtifacts = artifacts.filter((a: any) => {
      const f = analyzer.analyze(a);
      if (seenTests.has(f.testName)) return false;
      seenTests.add(f.testName);
      return true;
    });

    for (const artifact of uniqueArtifacts) {
      let failure = analyzer.analyze(artifact);

      // PRE-CHECK: Re-run this specific test to see if it still fails.
      // A previous test's healing may have already fixed shared locators in the same file.
      const preCheckRelFile = path.relative(path.join(testRepoPath, 'tests'), failure.filePath);
      const preCheck = ExecutionEngine.run(testRepoPath, preCheckRelFile, failure.testName);
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

      const backupPath = backupFile(failure.filePath);
      let iterationSuccess = false;
      let lastStrategy = 'rule_based';
      let lastConfidence = 0;
      let iterFixCount = 0;

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
                const rerun = ExecutionEngine.run(testRepoPath, relativeTestFile, failure.testName);
                if (rerun.exitCode === 0) {
                  iterationSuccess = true;
                  healedCount++;
                  iterFixCount = 1;
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
                  restoreFile(failure.filePath);
                }
              }
            }
          }

          if (!iterationSuccess) {
            restoreFile(failure.filePath);
          }

          // Continue to RCA analysis below (skip the locator healing loop)
        } else {

        // Iterative healing loop with retry-per-locator:
        //   For each broken locator, try multiple suggestions (up to RETRIES_PER_LOCATOR).
        //   If a suggestion fails, REVERT the file and try the next suggestion.
        //   Only advance to the next locator when the current one is truly fixed.
        const healedLocators = new Set<string>(); // Cycle detection across locators
        const triedLocators = new Set<string>();   // All tried suggestions (global across retries)
        const RETRIES_PER_LOCATOR = 8;             // Max suggestions to try per broken locator

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

        for (let iteration = 0; iteration < MAX_HEAL_ITERATIONS; iteration++) {
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

          // Try multiple suggestions for the SAME broken locator
          for (let retry = 0; retry < RETRIES_PER_LOCATOR; retry++) {
            const outcome = await orchestrator.heal(failure, domHtmlForFailure, triedLocators, resolvedProjectId, job.companyId, repoHealingContext);
            if (outcome.suggestion) {
              triedLocators.add(outcome.suggestion.newLocator);
            }

            logger.info(MOD, 'Orchestrator result', {
              testName: failure.testName, failedLocator: failure.failedLocator,
              iteration, retry, hasSuggestion: !!outcome.suggestion,
              suggestion: outcome.suggestion ? {
                newLocator: outcome.suggestion.newLocator,
                strategy: outcome.suggestion.strategy,
                confidence: outcome.suggestion.confidence,
              } : null,
            });

            if (!outcome.suggestion) {
              logger.warn(MOD, 'No more suggestions for this locator', {
                iteration, retry, testName: failure.testName,
              });
              break;
            }

            // Pre-flight: static validation via Healing Acceptance Engine
            const preCheck = acceptCandidate(outcome.suggestion, failure, fileContentBeforeFix);
            if (preCheck.decision === 'reject') {
              logger.warn(MOD, 'Acceptance pre-check rejected', {
                iteration, retry, reason: preCheck.reason, locator: outcome.suggestion.newLocator,
              });
              continue; // Skip this suggestion entirely
            }

            const validation = validationLayer.validate(outcome.suggestion, failure);
            if (!validation.approved || !validation.updatedContent) {
              logger.warn(MOD, 'Validation rejected', { iteration, retry, reason: validation.reason });
              continue; // Try next suggestion without reverting (no file change made)
            }

            // Apply the fix
            validationLayer.applyValidatedFix(failure.filePath, validation.updatedContent);

            logger.info(MOD, 'Applied fix, running rerun', {
              testName: failure.testName, iteration, retry,
              fixedLocator: failure.failedLocator,
              newLocator: outcome.suggestion.newLocator,
            });

            // Rerun ONLY the current test for isolation
            const relativeTestFile = path.relative(
              path.join(testRepoPath, 'tests'), failure.filePath,
            );
            const currentTestName = failure.testName;
            const rerun = ExecutionEngine.run(testRepoPath, relativeTestFile, currentTestName);

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
              const confirmRerun = ExecutionEngine.run(testRepoPath, relativeTestFile, currentTestName);
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

              // Still can't determine — revert and try next suggestion
              logger.warn(MOD, 'Cannot confirm fix, reverting', { iteration, retry });
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

      // --- RCA Analysis for this failure ---
      if (rcaEngine) {
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
      strategy: healings[0]?.strategy || 'none',
      tokensUsed: totalTokensUsed,
      testResults: tests,
      healingActions: healings,
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
