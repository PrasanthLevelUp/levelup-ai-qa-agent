import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import { logger } from './utils/logger';
import { backupFile, cleanupBackup, restoreFile } from './utils/file-utils';
import { ExecutionEngine } from './core/execution-engine';
import { ArtifactCollector } from './core/artifact-collector';
import { FailureAnalyzer } from './core/failure-analyzer';
import { HealingOrchestrator } from './core/healing-orchestrator';
import { RuleEngine } from './engines/rule-engine';
import { PatternEngine } from './engines/pattern-engine';
import { AIEngine } from './engines/ai-engine';
import { ValidationLayer } from './validation/validation-layer';
import { OpenAIClient } from './ai/openai-client';
import {
  initDb,
  closeDb,
  logExecution,
  updateExecution,
  logHealing,
  storePattern,
  getHistoricalStats,
} from './db/postgres';
import { generateReport, type ReportData, type ReportHealing, type ReportTest } from './reports/html-report';
import { startAPIServer } from './api/server';

const MOD = 'index';

interface Config {
  testRepoPath: string;
  siteUrl: string;
  owner: string;
  repoName: string;
  reportDir: string;
  autoCommit: boolean;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const get = (flag: string, def = ''): string => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1]! : def;
  };
  const has = (flag: string): boolean => args.includes(flag);

  return {
    testRepoPath: get('--repo', '/home/ubuntu/github_repos/selfhealing_agent_poc'),
    siteUrl: get('--site-url', 'https://opensource-demo.orangehrmlive.com'),
    owner: get('--owner', 'PrasanthLevelUp'),
    repoName: get('--repo-name', 'selfhealing_agent_poc'),
    reportDir: get('--report-dir', '/home/ubuntu/healing_reports'),
    autoCommit: has('--auto-commit'),
  };
}

function readTestSummary(resultsFile: string): ReportTest[] {
  if (!fs.existsSync(resultsFile)) return [];
  const raw = JSON.parse(fs.readFileSync(resultsFile, 'utf-8')) as {
    suites?: Array<{
      specs?: Array<{
        title?: string;
        tests?: Array<{ results?: Array<{ status?: string; duration?: number; errors?: Array<{ message?: string }> }> }>;
      }>;
    }>;
  };

  const rows: ReportTest[] = [];
  for (const suite of raw.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const result = t.results?.[0];
        const status = result?.status ?? 'unknown';
        const err = result?.errors?.map((e) => e.message || '').join('\n') || '';
        rows.push({
          testName: spec.title ?? 'unknown',
          status,
          durationMs: result?.duration ?? 0,
          error: err,
          healed: false,
        });
      }
    }
  }
  return rows;
}

function getCommitSha(repoPath: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function maybeCommitFix(repoPath: string, filePath: string, message: string, autoCommit: boolean): void {
  if (!autoCommit) return;
  const relativeFile = path.relative(repoPath, filePath);

  try {
    execSync(`git add "${relativeFile}"`, { cwd: repoPath, stdio: 'pipe' });
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: repoPath, stdio: 'pipe' });
    logger.info(MOD, 'Auto-committed healed fix', { relativeFile, message });
  } catch (error) {
    logger.warn(MOD, 'Auto-commit skipped or failed', { error: (error as Error).message });
  }
}

async function runCLI(): Promise<void> {
  const cfg = parseArgs();
  fs.mkdirSync(cfg.reportDir, { recursive: true });

  logger.info(MOD, 'Starting refined self-healing orchestrator (CLI mode)', {
    testRepoPath: cfg.testRepoPath,
    siteUrl: cfg.siteUrl,
  });

  // Initialize DB upfront.
  await initDb();

  const run = ExecutionEngine.run(cfg.testRepoPath);
  const tests = readTestSummary(run.resultsFile);

  const collector = new ArtifactCollector();
  const artifacts = collector.collect(run.resultsFile, cfg.testRepoPath);

  const analyzer = new FailureAnalyzer();
  const orchestrator = new HealingOrchestrator(
    new RuleEngine(),
    new PatternEngine(),
    new AIEngine(new OpenAIClient({
      model: 'gpt-4o-mini',
      apiKey: process.env['OPENAI_API_KEY'],
    })),
  );
  const validationLayer = new ValidationLayer(path.join(cfg.reportDir, 'patches'));

  const healings: ReportHealing[] = [];
  let healedCount = 0;
  let validationRejected = 0;
  let patchesGenerated = 0;
  let totalTokensUsed = 0;

  for (const test of tests) {
    await logExecution({
      test_name: test.testName,
      status: test.status,
      error_message: test.error.slice(0, 1000),
      github_commit_sha: getCommitSha(cfg.testRepoPath),
      duration_ms: test.durationMs,
      healing_attempted: false,
      healing_succeeded: false,
    });
  }

  for (const artifact of artifacts) {
    const failure = analyzer.analyze(artifact);

    const executionId = await logExecution({
      test_name: failure.testName,
      status: 'failed',
      error_message: failure.errorMessage.slice(0, 1000),
      screenshot_path: failure.screenshotPath ?? undefined,
      github_commit_sha: getCommitSha(cfg.testRepoPath),
      healing_attempted: true,
      healing_succeeded: false,
    });

    const backupPath = backupFile(failure.filePath);

    try {
      const outcome = await orchestrator.heal(failure);
      if (!outcome.suggestion) {
        await logHealing({
          test_execution_id: executionId,
          test_name: failure.testName,
          failed_locator: failure.failedLocator,
          healing_strategy: 'rule_based',
          success: false,
          confidence: 0,
          error_context: failure.errorMessage.slice(0, 500),
          validation_status: 'rejected',
          validation_reason: 'No strategy generated suggestion',
        });
        restoreFile(failure.filePath);
        continue;
      }

      const validation = validationLayer.validate(outcome.suggestion, failure);
      if (!validation.approved || !validation.updatedContent) {
        validationRejected += 1;
        await logHealing({
          test_execution_id: executionId,
          test_name: failure.testName,
          failed_locator: failure.failedLocator,
          healed_locator: outcome.suggestion.newLocator,
          healing_strategy: outcome.suggestion.strategy,
          ai_tokens_used: outcome.suggestion.tokensUsed,
          success: false,
          confidence: outcome.suggestion.confidence,
          error_context: failure.errorMessage.slice(0, 500),
          validation_status: 'rejected',
          validation_reason: validation.reason,
        });
        restoreFile(failure.filePath);
        continue;
      }

      patchesGenerated += 1;
      totalTokensUsed += outcome.suggestion.tokensUsed;
      validationLayer.applyValidatedFix(failure.filePath, validation.updatedContent);

      const relativeTestFile = path.relative(path.join(cfg.testRepoPath, 'tests'), failure.filePath);
      const rerun = ExecutionEngine.run(cfg.testRepoPath, relativeTestFile);
      const success = rerun.exitCode === 0;

      await logHealing({
        test_execution_id: executionId,
        test_name: failure.testName,
        failed_locator: failure.failedLocator,
        healed_locator: outcome.suggestion.newLocator,
        healing_strategy: outcome.suggestion.strategy,
        ai_tokens_used: outcome.suggestion.tokensUsed,
        success,
        confidence: outcome.suggestion.confidence,
        error_context: failure.errorMessage.slice(0, 500),
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

      if (!success) {
        restoreFile(failure.filePath);
        continue;
      }

      healedCount += 1;
      await updateExecution(executionId, { healing_succeeded: true, status: 'healed' });
      cleanupBackup(failure.filePath);
      maybeCommitFix(
        cfg.testRepoPath,
        failure.filePath,
        `🔧 Auto-heal: ${failure.testName} (${failure.failedLocator} -> ${outcome.suggestion.newLocator})`,
        cfg.autoCommit,
      );

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

      logger.info(MOD, 'Healing success', {
        testName: failure.testName,
        strategy: outcome.suggestion.strategy,
      });
    } catch (error) {
      restoreFile(failure.filePath);
      logger.error(MOD, 'Healing pipeline failed for test', {
        testName: failure.testName,
        error: (error as Error).message,
      });
    } finally {
      if (fs.existsSync(backupPath)) cleanupBackup(failure.filePath);
    }
  }

  const hist = await getHistoricalStats();
  const now = new Date().toISOString();
  const reportData: ReportData = {
    timestamp: now,
    commitSha: getCommitSha(cfg.testRepoPath),
    repo: `${cfg.owner}/${cfg.repoName}`,
    siteUrl: cfg.siteUrl,
    totalTests: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status !== 'passed' && t.status !== 'healed').length,
    healed: healedCount,
    validationRejected,
    patchesGenerated,
    totalTokensUsed,
    tests,
    healings,
    historicalStats: hist,
  };

  const reportPath = path.join(cfg.reportDir, `refined-report-${now.replace(/[:.]/g, '-')}.html`);
  generateReport(reportData, reportPath);
  fs.writeFileSync(path.join(cfg.reportDir, 'latest-report-data.json'), JSON.stringify(reportData, null, 2));

  logger.info(MOD, 'Refined orchestrator completed', {
    reportPath,
    healedCount,
    validationRejected,
    patchesGenerated,
  });

  await closeDb();
}

// Entry point — support both CLI and API modes
const mode = process.env['MODE'] || 'cli';

if (mode === 'api') {
  startAPIServer().catch((error) => {
    logger.error(MOD, 'Failed to start API server', { error: (error as Error).message });
    process.exit(1);
  });
} else {
  runCLI().catch(async (error) => {
    logger.error(MOD, 'Fatal orchestration error', { error: (error as Error).message });
    await closeDb();
    process.exit(1);
  });
}
