/**
 * REST API Server — Express server for the AI Self-Healing Agent.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as path from 'path';
import * as fs from 'fs';

import { authMiddleware } from './middleware/auth';
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
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

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

  // Authenticated routes
  app.use('/api/heal', authMiddleware, createHealRouter(jobQueue, repoManager));
  app.use('/api/status', authMiddleware, createStatusRouter(jobQueue));
  app.use('/api/reports', authMiddleware, createReportsRouter(jobQueue));
  app.use('/api/repos', authMiddleware, createReposRouter(repoManager));
  app.use('/api/rca', authMiddleware, createRCARouter());
  app.use('/api/pr', authMiddleware, createPRRouter());
  app.use('/api/scripts', authMiddleware, createScriptGenRouter());

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
    const reportDir = process.env['REPORT_DIR'] || '/home/ubuntu/healing_reports';
    fs.mkdirSync(reportDir, { recursive: true });

    // Resolve repo configuration
    const repo = repoManager.findRepo(job.repositoryId);
    const testRepoPath = repo?.localPath || `/home/ubuntu/github_repos/${repo?.name || 'test_repo'}`;
    const repoUrl = job.repositoryUrl || repo?.url || '';
    const branch = job.branch || repo?.branch || 'main';

    logger.info(MOD, 'Starting healing worker', {
      jobId: job.id,
      testRepoPath,
      branch,
    });

    // Step 1: Clone/pull repo
    jobQueue.updateJob(job.id, { progress: 'Cloning/pulling repository...' });
    try {
      await ExecutionEngine.cloneRepository(repoUrl, testRepoPath, branch);
    } catch (error) {
      logger.warn(MOD, 'Clone failed, using existing repo', {
        error: (error as Error).message,
      });
    }

    // Step 2: Install dependencies
    jobQueue.updateJob(job.id, { progress: 'Installing dependencies...' });
    try {
      await ExecutionEngine.installDependencies(testRepoPath);
    } catch (error) {
      logger.warn(MOD, 'Dependency install had issues', {
        error: (error as Error).message,
      });
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
      const result = {
        totalTests: 1,
        failed: 0,
        healed: 0,
        strategy: 'none',
        tokensUsed: 0,
        testResults: { exitCode: run.exitCode, durationMs: run.durationMs },
        healingActions: [],
        message: run.exitCode === 0 ? 'All tests passed — no healing needed' : 'No failure artifacts collected',
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

    for (const artifact of artifacts) {
      const failure = analyzer.analyze(artifact);
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
      });

      jobQueue.updateJob(job.id, {
        progress: `Healing: ${failure.testName}...`,
      });

      const backupPath = backupFile(failure.filePath);

      try {
        const outcome = await orchestrator.heal(failure);
        logger.info(MOD, 'Orchestrator result', {
          testName: failure.testName,
          failedLocator: failure.failedLocator,
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
          restoreFile(failure.filePath);
          continue;
        }

        const validation = validationLayer.validate(outcome.suggestion, failure);
        logger.info(MOD, 'Validation result', {
          testName: failure.testName,
          approved: validation.approved,
          reason: validation.reason,
          newLocator: outcome.suggestion.newLocator,
        });

        if (!validation.approved || !validation.updatedContent) {
          restoreFile(failure.filePath);
          continue;
        }

        totalTokensUsed += outcome.suggestion.tokensUsed;
        validationLayer.applyValidatedFix(failure.filePath, validation.updatedContent);

        // Log the transformed file content for debugging
        const transformedContent = fs.readFileSync(failure.filePath, 'utf-8');
        logger.info(MOD, 'Transformed test file content', {
          testName: failure.testName,
          filePath: failure.filePath,
          contentPreview: transformedContent.substring(0, 500),
        });

        const relativeTestFile = path.relative(
          path.join(testRepoPath, 'tests'),
          failure.filePath,
        );
        logger.info(MOD, 'Running healed test rerun', {
          testRepoPath,
          relativeTestFile,
          cmd: `npx playwright test "${relativeTestFile}" --reporter=json --output=test-results`,
        });

        const rerun = ExecutionEngine.run(testRepoPath, relativeTestFile);
        const success = rerun.exitCode === 0;

        logger.info(MOD, 'Rerun result', {
          exitCode: rerun.exitCode,
          success,
          stdout: rerun.stdout?.substring(0, 300),
          stderr: rerun.stderr?.substring(0, 300),
        });

        await logHealing({
          test_execution_id: executionId,
          test_name: failure.testName,
          failed_locator: failure.failedLocator,
          healed_locator: outcome.suggestion.newLocator,
          healing_strategy: outcome.suggestion.strategy,
          ai_tokens_used: outcome.suggestion.tokensUsed,
          success,
          confidence: outcome.suggestion.confidence,
          validation_status: 'approved',
          validation_reason: outcome.suggestion.reasoning,
          patch_path: validation.patchPath,
        });

        healings.push({
          testName: failure.testName,
          failedLocator: failure.failedLocator,
          healedLocator: outcome.suggestion.newLocator,
          strategy: outcome.suggestion.strategy,
          aiTokensUsed: outcome.suggestion.tokensUsed,
          success,
          confidence: outcome.suggestion.confidence,
          validated: true,
          validationReason: outcome.suggestion.reasoning,
          patchPath: validation.patchPath,
        });

        if (success) {
          healedCount++;
          await updateExecution(executionId, { healing_succeeded: true, status: 'healed' });
          cleanupBackup(failure.filePath);

          await storePattern({
            test_name: failure.testName,
            error_pattern: failure.errorPattern,
            failed_locator: failure.failedLocator,
            healed_locator: outcome.suggestion.newLocator,
            solution_strategy: outcome.suggestion.strategy,
            confidence: outcome.suggestion.confidence,
            avg_tokens_saved: outcome.suggestion.tokensUsed,
          });

          const testRow = tests.find((t) => t.testName === failure.testName);
          if (testRow) {
            testRow.healed = true;
            testRow.status = 'healed';
          }
        } else {
          restoreFile(failure.filePath);
        }
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
          });

          logger.info(MOD, 'RCA analysis complete', {
            testName: failure.testName,
            classification: rcaResult.classification,
            severity: rcaResult.severity,
            confidence: rcaResult.confidence,
          });
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
          });

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
