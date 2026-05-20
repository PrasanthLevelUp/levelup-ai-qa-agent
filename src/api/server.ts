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
import { errorHandler } from './middleware/error-handler';
import { createHealRouter } from './routes/heal';
import { createStatusRouter } from './routes/status';
import { createReportsRouter } from './routes/reports';
import { createReposRouter } from './routes/repos';
import { createWebhookRouter } from './routes/webhook';
import { JobQueue } from './queue/job-queue';
import { RepoManager } from './services/repo-manager';
import { logger } from '../utils/logger';
import { initDb, closeDb } from '../db/postgres';

// Import healing pipeline components
import { ExecutionEngine } from '../core/execution-engine';
import { ArtifactCollector } from '../core/artifact-collector';
import { FailureAnalyzer } from '../core/failure-analyzer';
import { HealingOrchestrator } from '../core/healing-orchestrator';
import { RuleEngine } from '../engines/rule-engine';
import { PatternEngine } from '../engines/pattern-engine';
import { AIEngine } from '../engines/ai-engine';
import { OpenAIClient } from '../ai/openai-client';
import { ValidationLayer } from '../validation/validation-layer';
import { generateReport, type ReportData, type ReportTest, type ReportHealing } from '../reports/html-report';
import { RCAEngine, type RCAResult } from '../engines/rca-engine';
import { createRCARouter } from './routes/rca';
import { createPRRouter } from './routes/pr';
import { createScriptGenRouter } from './routes/script-gen';
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
import { createROIRouter } from './routes/roi';
import { createBillingRouter } from './routes/billing';
import { createIngestRouter } from './routes/ingest';
import { apiKeysRouter } from './routes/api-keys';
import { hooksRouter } from './routes/hooks';
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
} from '../db/postgres';
import type { HealingJob } from './queue/job-queue';

const MOD = 'api-server';

export function createServer(): express.Application {
  const app = express();

  // Middleware
  app.use(cors({
    origin: process.env.DASHBOARD_URL || true,
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

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

  // Webhook — no auth (uses its own signature validation)
  app.use('/api/webhook', createWebhookRouter(jobQueue, repoManager));

  // Ingest API — uses its own API key auth (Bearer lvlp_live_xxx)
  // Must support both JSON and raw text/xml bodies
  app.use('/api/ingest', express.text({ type: ['text/xml', 'application/xml'], limit: '50mb' }), createIngestRouter(jobQueue));

  // Cloud platform webhook receivers — use API key via ?token= param
  app.use('/api/hooks', hooksRouter);

  // Auth routes — no API key required (uses cookie-based JWT)
  app.use('/api/auth', createAuthRouter());

  // Authenticated routes (API key)
  app.use('/api/heal', authMiddleware, companyMiddleware, createHealRouter(jobQueue, repoManager));
  app.use('/api/status', authMiddleware, companyMiddleware, createStatusRouter(jobQueue));
  app.use('/api/reports', authMiddleware, companyMiddleware, createReportsRouter(jobQueue));
  app.use('/api/repos', authMiddleware, companyMiddleware, createReposRouter(repoManager));
  app.use('/api/rca', authMiddleware, companyMiddleware, createRCARouter());
  app.use('/api/pr', authMiddleware, companyMiddleware, createPRRouter());
  app.use('/api/scripts', authMiddleware, companyMiddleware, createScriptGenRouter());
  app.use('/api/notifications', authMiddleware, companyMiddleware, createNotificationsRouter());
  app.use('/api/dom', authMiddleware, companyMiddleware, createDomMemoryRouter());
  app.use('/api/learning', authMiddleware, companyMiddleware, createLearningRouter());
  app.use('/api/companies', authMiddleware, createCompaniesRouter());
  app.use('/api/similarity', authMiddleware, companyMiddleware, createSimilarityRouter());
  app.use('/api/release-risk', authMiddleware, companyMiddleware, createReleaseRiskRouter());
  app.use('/api/release-signoff', authMiddleware, companyMiddleware, createReleaseSignoffRouter());
  app.use('/api/rca-intelligence', authMiddleware, companyMiddleware, createRCAIntelligenceRouter());
  app.use('/api/roi', authMiddleware, companyMiddleware, createROIRouter());
  app.use('/api/test-coverage', authMiddleware, companyMiddleware, createTestCoverageRouter());
  app.use('/api/billing', authMiddleware, companyMiddleware, createBillingRouter());
  app.use('/api/keys', authMiddleware, companyMiddleware, apiKeysRouter);

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

  // Initialize PostgreSQL schema before starting server
  await initDb();

  const app = createServer();

  const server = app.listen(port, () => {
    logger.info(MOD, `API server started on port ${port}`, { port });
    console.log(`\n🚀 LevelUp AI QA Agent API running at http://localhost:${port}`);
    console.log(`   Health: http://localhost:${port}/api/health`);
    console.log(`   Docs:   See README.md for API documentation\n`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info(MOD, 'Shutting down gracefully...');
    server.close(async () => {
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
    const repoName = repo?.name || job.repositoryId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-50) || 'test_repo';
    const testRepoPath = repo?.localPath || path.join(workspaceDir, repoName);
    const repoUrl = job.repositoryUrl || repo?.url || '';
    const branch = job.branch || repo?.branch || 'main';

    logger.info(MOD, 'Starting healing worker', {
      jobId: job.id,
      testRepoPath,
      repoUrl,
      branch,
      repoName,
      workspaceDir,
      repoLocalPath: repo?.localPath,
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
    jobQueue.updateJob(job.id, { progress: 'Running tests...' });
    const run = ExecutionEngine.run(testRepoPath);

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
        message = `Tests exited with code ${run.exitCode} but no failure artifacts were collected. stderr: ${(run.stderr || '').slice(0, 300)}`;
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

    const analyzer = new FailureAnalyzer();
    const orchestrator = new HealingOrchestrator(
      new RuleEngine(),
      new PatternEngine(),
      new AIEngine(new OpenAIClient({
        model: 'gpt-4o-mini',
        apiKey: process.env['OPENAI_API_KEY'],
      })),
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

    const MAX_HEAL_ITERATIONS = 10; // Max locator fixes per test before giving up

    for (const artifact of artifacts) {
      let failure = analyzer.analyze(artifact);
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
                const rerun = ExecutionEngine.run(testRepoPath, relativeTestFile);
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

        // Iterative healing loop: fix one locator → rerun → if still fails, fix next locator → rerun...
        const healedLocators = new Set<string>(); // Cycle detection

        for (let iteration = 0; iteration < MAX_HEAL_ITERATIONS; iteration++) {
          jobQueue.updateJob(job.id, {
            progress: `Healing: ${failure.testName} (locator ${iteration + 1})...`,
          });

          // Cycle detection: if we've already tried to heal this exact locator, stop
          if (healedLocators.has(failure.failedLocator)) {
            logger.warn(MOD, 'Cycle detected — already healed this locator, stopping', {
              testName: failure.testName,
              failedLocator: failure.failedLocator,
              iteration,
            });
            break;
          }
          healedLocators.add(failure.failedLocator);

          const outcome = await orchestrator.heal(failure);
          logger.info(MOD, 'Orchestrator result', {
            testName: failure.testName,
            failedLocator: failure.failedLocator,
            iteration,
            hasSuggestion: !!outcome.suggestion,
            suggestion: outcome.suggestion ? {
              newLocator: outcome.suggestion.newLocator,
              strategy: outcome.suggestion.strategy,
              confidence: outcome.suggestion.confidence,
            } : null,
            attemptedStrategies: outcome.attemptedStrategies,
            selectedEngine: outcome.selectedEngine,
          });

          if (!outcome.suggestion) {
            logger.warn(MOD, 'No suggestion at iteration', { iteration, testName: failure.testName });
            break;
          }

          const validation = validationLayer.validate(outcome.suggestion, failure);
          logger.info(MOD, 'Validation result', {
            testName: failure.testName,
            approved: validation.approved,
            reason: validation.reason,
            newLocator: outcome.suggestion.newLocator,
            iteration,
          });

          if (!validation.approved || !validation.updatedContent) {
            logger.warn(MOD, 'Validation rejected at iteration', { iteration, reason: validation.reason });
            break;
          }

          totalTokensUsed += outcome.suggestion.tokensUsed;
          validationLayer.applyValidatedFix(failure.filePath, validation.updatedContent);
          iterFixCount++;
          lastStrategy = outcome.suggestion.strategy;
          lastConfidence = outcome.suggestion.confidence;

          logger.info(MOD, 'Applied fix, running rerun', {
            testName: failure.testName,
            iteration,
            fixedLocator: failure.failedLocator,
            newLocator: outcome.suggestion.newLocator,
          });

          // Log each individual locator fix
          await logHealing({
            test_execution_id: executionId,
            test_name: failure.testName,
            failed_locator: failure.failedLocator,
            healed_locator: outcome.suggestion.newLocator,
            healing_strategy: outcome.suggestion.strategy,
            ai_tokens_used: outcome.suggestion.tokensUsed,
            success: false, // Will update to true if final rerun passes
            confidence: outcome.suggestion.confidence,
            validation_status: 'approved',
            validation_reason: `[Iter ${iteration + 1}] ${outcome.suggestion.reasoning}`,
            patch_path: validation.patchPath,
          }, job.companyId);

          healings.push({
            testName: failure.testName,
            failedLocator: failure.failedLocator,
            healedLocator: outcome.suggestion.newLocator,
            strategy: outcome.suggestion.strategy,
            aiTokensUsed: outcome.suggestion.tokensUsed,
            success: false, // Placeholder — updated below if final pass
            confidence: outcome.suggestion.confidence,
            validated: true,
            validationReason: `[Iter ${iteration + 1}] ${outcome.suggestion.reasoning}`,
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
          }, job.companyId);

          // Rerun the specific test file
          const relativeTestFile = path.relative(
            path.join(testRepoPath, 'tests'),
            failure.filePath,
          );
          const rerun = ExecutionEngine.run(testRepoPath, relativeTestFile);

          logger.info(MOD, 'Rerun result', {
            exitCode: rerun.exitCode,
            iteration,
            stdout: rerun.stdout?.substring(0, 300),
            stderr: rerun.stderr?.substring(0, 300),
          });

          if (rerun.exitCode === 0) {
            // All locators healed — test passes!
            iterationSuccess = true;
            logger.info(MOD, 'Iterative healing SUCCESS', {
              testName: failure.testName,
              totalIterations: iteration + 1,
              totalFixesApplied: iterFixCount,
            });
            break;
          }

          // Test still fails — collect new artifacts to find the NEXT broken locator
          let newArtifacts: any[] = [];
          try {
            newArtifacts = collector.collect(rerun.resultsFile, testRepoPath);
          } catch (e) {
            logger.warn(MOD, 'Could not collect artifacts from rerun', { error: (e as Error).message });
          }

          if (newArtifacts.length === 0) {
            logger.warn(MOD, 'Rerun failed but no new artifacts — cannot continue iterative healing', {
              testName: failure.testName, iteration,
            });
            break;
          }

          // Find the artifact for the SAME test (it should have a NEW failed locator)
          const nextArtifact = newArtifacts.find((a: any) => {
            const nextFailure = analyzer.analyze(a);
            // Must be for the same test file and a DIFFERENT locator than what we just fixed
            return nextFailure.filePath === failure.filePath
              && nextFailure.failedLocator !== failure.failedLocator;
          }) || newArtifacts[0]; // Fallback to first artifact if no match

          if (!nextArtifact) {
            logger.warn(MOD, 'No next artifact found for iterative healing', { testName: failure.testName });
            break;
          }

          // Update failure to the next broken locator and continue the loop
          failure = analyzer.analyze(nextArtifact);
          logger.info(MOD, 'Iterative healing — next locator', {
            testName: failure.testName,
            nextFailedLocator: failure.failedLocator,
            iteration: iteration + 1,
          });
        }

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
