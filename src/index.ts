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
    testRepoPath: get('--repo', process.env['WORKSPACE_DIR'] ? process.env['WORKSPACE_DIR'] + '/selfhealing_agent_poc' : '/tmp/healing-repos/selfhealing_agent_poc'),
    siteUrl: get('--site-url', 'https://opensource-demo.orangehrmlive.com'),
    owner: get('--owner', 'PrasanthLevelUp'),
    repoName: get('--repo-name', 'selfhealing_agent_poc'),
    reportDir: get('--report-dir', '/tmp/healing_reports'),
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

  await ExecutionEngine.installDependencies(cfg.testRepoPath);
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

  const MAX_HEAL_ITERATIONS = 10;

  // De-duplicate artifacts by test name
  const seenTestsCli = new Set<string>();
  const uniqueArtifactsCli = artifacts.filter((a: any) => {
    const f = analyzer.analyze(a);
    if (seenTestsCli.has(f.testName)) return false;
    seenTestsCli.add(f.testName);
    return true;
  });

  for (const artifact of uniqueArtifactsCli) {
    let failure = analyzer.analyze(artifact);

    // PRE-CHECK: Re-run this specific test to see if it still fails
    const preRelFile = path.relative(path.join(cfg.testRepoPath, 'tests'), failure.filePath);
    const preCheck = ExecutionEngine.run(cfg.testRepoPath, preRelFile, failure.testName);
    if (preCheck.exitCode === 0) {
      logger.info(MOD, 'Test already passes (fixed by prior healing) — skipping', { testName: failure.testName });
      healedCount++;
      const testRow = tests.find((t) => t.testName === failure.testName);
      if (testRow) { testRow.healed = true; testRow.status = 'healed'; }
      continue;
    }

    // Re-collect fresh artifacts
    try {
      const freshArts = collector.collect(preCheck.resultsFile, cfg.testRepoPath);
      const freshForTest = freshArts.find((a: any) => analyzer.analyze(a).testName === failure.testName);
      if (freshForTest) failure = analyzer.analyze(freshForTest);
    } catch (_e) { /* use original */ }

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
    let iterationSuccess = false;
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
        logger.info(MOD, 'Skipping locator healing — assertion/timeout failure', {
          testName: failure.testName,
          failureType: failure.failureType,
          failedLocator: failure.failedLocator,
          errorMessage: failure.errorMessage.slice(0, 200),
        });

        // For timing-related failures, try adding explicit wait
        if (failure.isTimingIssue || failure.errorMessage.includes('Received ""') || failure.errorMessage.includes('Received: ""')) {
          logger.info(MOD, 'Failure may be timing-related — attempting wait injection');
          const originalContent = fs.readFileSync(failure.filePath, 'utf-8');
          if (!originalContent.includes("waitForLoadState('networkidle')")) {
            const updatedContent = originalContent.replace(
              /(await page\.goto\([^;]+;)/g,
              "$1\n    await page.waitForLoadState('networkidle');"
            );
            if (updatedContent !== originalContent) {
              fs.writeFileSync(failure.filePath, updatedContent, 'utf-8');
              const relativeTestFile = path.relative(path.join(cfg.testRepoPath, 'tests'), failure.filePath);
              const rerun = ExecutionEngine.run(cfg.testRepoPath, relativeTestFile, failure.testName);
              if (rerun.exitCode === 0) {
                iterationSuccess = true;
                healedCount++;
                iterFixCount = 1;
                healings.push({
                  testName: failure.testName,
                  failedLocator: failure.failedLocator || 'assertion',
                  healedLocator: 'Added waitForLoadState(networkidle)',
                  strategy: 'rule_based',
                  aiTokensUsed: 0,
                  success: true,
                  confidence: 0.85,
                  validated: true,
                  validationReason: 'Timing fix — added explicit wait',
                });
                const testRow = tests.find((t) => t.testName === failure.testName);
                if (testRow) {
                  testRow.healed = true;
                  testRow.status = 'healed';
                }
              } else {
                restoreFile(failure.filePath);
              }
            }
          }
        } else {
          restoreFile(failure.filePath);
        }
      } else {

      // Iterative healing loop with retry-per-locator (same logic as server.ts)
      const healedLocators = new Set<string>();
      const triedLocators = new Set<string>();
      const RETRIES_PER_LOCATOR = 5;

      for (let iteration = 0; iteration < MAX_HEAL_ITERATIONS; iteration++) {
        if (healedLocators.has(failure.failedLocator)) {
          logger.warn(MOD, 'Cycle detected — stopping', { failedLocator: failure.failedLocator });
          break;
        }

        const fileContentBeforeFix = fs.readFileSync(failure.filePath, 'utf-8');
        let locatorFixed = false;

        for (let retry = 0; retry < RETRIES_PER_LOCATOR; retry++) {
          const outcome = await orchestrator.heal(failure, undefined, triedLocators);
          if (outcome.suggestion) triedLocators.add(outcome.suggestion.newLocator);

          if (!outcome.suggestion) {
            if (iteration === 0 && retry === 0) {
              await logHealing({
                test_execution_id: executionId,
                test_name: failure.testName,
                failed_locator: failure.failedLocator,
                healing_strategy: 'rule_based',
                success: false, confidence: 0,
                error_context: failure.errorMessage.slice(0, 500),
                validation_status: 'rejected',
                validation_reason: 'No strategy generated suggestion',
              });
            }
            break;
          }

          const validation = validationLayer.validate(outcome.suggestion, failure);
          if (!validation.approved || !validation.updatedContent) {
            validationRejected += 1;
            continue; // Try next suggestion
          }

          patchesGenerated += 1;
          totalTokensUsed += outcome.suggestion.tokensUsed;
          validationLayer.applyValidatedFix(failure.filePath, validation.updatedContent);

          // Rerun current test only
          const relativeTestFile = path.relative(path.join(cfg.testRepoPath, 'tests'), failure.filePath);
          const currentTestName = failure.testName;
          const rerun = ExecutionEngine.run(cfg.testRepoPath, relativeTestFile, currentTestName);

          if (rerun.exitCode === 0) {
            locatorFixed = true;
            iterFixCount++;
            iterationSuccess = true;

            await logHealing({
              test_execution_id: executionId,
              test_name: failure.testName,
              failed_locator: failure.failedLocator,
              healed_locator: outcome.suggestion.newLocator,
              healing_strategy: outcome.suggestion.strategy,
              ai_tokens_used: outcome.suggestion.tokensUsed,
              success: true, confidence: outcome.suggestion.confidence,
              validation_status: 'approved',
              validation_reason: `[Iter ${iteration + 1} R${retry + 1}] ${outcome.suggestion.reasoning}`,
              patch_path: validation.patchPath,
            });
            healings.push({
              testName: failure.testName, failedLocator: failure.failedLocator,
              healedLocator: outcome.suggestion.newLocator, strategy: outcome.suggestion.strategy,
              aiTokensUsed: outcome.suggestion.tokensUsed, success: true,
              confidence: outcome.suggestion.confidence, validated: true,
              validationReason: `[Iter ${iteration + 1} R${retry + 1}] ${outcome.suggestion.reasoning}`,
              patchPath: validation.patchPath,
            });
            break;
          }

          // Check if test progressed to a different locator
          let newArtifacts: any[] = [];
          try { newArtifacts = collector.collect(rerun.resultsFile, cfg.testRepoPath); } catch {}
          const sameTestArts = newArtifacts.filter((a: any) => {
            const nf = analyzer.analyze(a);
            return nf.filePath === failure.filePath && nf.testName === currentTestName;
          });
          const nextFailure = sameTestArts.length > 0 ? analyzer.analyze(sameTestArts[0]) : null;

          if (sameTestArts.length === 0) {
            locatorFixed = true; iterFixCount++; iterationSuccess = true;
            healings.push({
              testName: failure.testName, failedLocator: failure.failedLocator,
              healedLocator: outcome.suggestion.newLocator, strategy: outcome.suggestion.strategy,
              aiTokensUsed: outcome.suggestion.tokensUsed, success: true,
              confidence: outcome.suggestion.confidence, validated: true,
              validationReason: `[Iter ${iteration + 1} R${retry + 1}] ${outcome.suggestion.reasoning}`,
              patchPath: validation.patchPath,
            });
            break;
          }

          const appliedLocator = outcome.suggestion.newLocator;
          const isSameLocatorFailing = !nextFailure
            || nextFailure.failedLocator === failure.failedLocator
            || nextFailure.failedLocator === appliedLocator
            || appliedLocator.includes(nextFailure.failedLocator)
            || nextFailure.failedLocator.includes(appliedLocator);

          if (nextFailure && !isSameLocatorFailing) {
            // Fix worked for this locator — advance to next
            locatorFixed = true; iterFixCount++;
            healings.push({
              testName: failure.testName, failedLocator: failure.failedLocator,
              healedLocator: outcome.suggestion.newLocator, strategy: outcome.suggestion.strategy,
              aiTokensUsed: outcome.suggestion.tokensUsed, success: false,
              confidence: outcome.suggestion.confidence, validated: true,
              validationReason: `[Iter ${iteration + 1} R${retry + 1}] ${outcome.suggestion.reasoning}`,
              patchPath: validation.patchPath,
            });
            await storePattern({
              test_name: failure.testName, error_pattern: failure.errorPattern,
              failed_locator: failure.failedLocator, healed_locator: outcome.suggestion.newLocator,
              solution_strategy: outcome.suggestion.strategy, confidence: outcome.suggestion.confidence,
              avg_tokens_saved: outcome.suggestion.tokensUsed,
            });
            healedLocators.add(failure.failedLocator);
            failure = nextFailure;
            break;
          }

          // Same locator still failing — REVERT and try next suggestion
          logger.info(MOD, 'Fix did not work, reverting', {
            failedLocator: failure.failedLocator, tried: outcome.suggestion.newLocator, retry,
          });
          fs.writeFileSync(failure.filePath, fileContentBeforeFix, 'utf-8');
        } // end retry loop

        if (iterationSuccess) break;
        if (!locatorFixed) break; // Exhausted suggestions
      }

      if (iterationSuccess) {
        healedCount += 1;
        await updateExecution(executionId, { healing_succeeded: true, status: 'healed' });
        cleanupBackup(failure.filePath);

        for (const h of healings) {
          if (h.testName === failure.testName) h.success = true;
        }

        maybeCommitFix(
          cfg.testRepoPath,
          failure.filePath,
          `🔧 Auto-heal: ${failure.testName} (${iterFixCount} locators fixed)`,
          cfg.autoCommit,
        );

        const testRow = tests.find((t) => t.testName === failure.testName);
        if (testRow) {
          testRow.healed = true;
          testRow.status = 'healed';
        }

        logger.info(MOD, 'Healing success (iterative)', {
          testName: failure.testName,
          fixesApplied: iterFixCount,
        });
      } else {
        restoreFile(failure.filePath);
      }

      } // end else (locator/locator_timeout healing branch)
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
