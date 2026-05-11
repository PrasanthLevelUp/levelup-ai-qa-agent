/**
 * LevelUp AI QA Agent — Main Orchestrator
 *
 * End-to-end self-healing test automation:
 *   Run Tests → Analyze Failures → Heal (rule → DB → AI) → Patch → Re-run → PR → Report
 *
 * CLI: ts-node src/index.ts --repo <test-repo-path> [--site-url <url>] [--github-token <token>]
 *                           [--owner <owner>] [--repo-name <name>] [--report-dir <dir>]
 */

import * as path from 'path';
import * as fs from 'fs';
import { logger } from './utils/logger';
import { runTests } from './core/execution-engine';
import { analyzeResults, type FailureContext } from './core/failure-analyzer';
import { ruleBasedHeal, dbPatternHeal, applyFix, storeSuccessfulPattern } from './core/locator-healer';
import { healWithAI, type AIHealRequest } from './ai/openai-client';
import { logExecution, logHealing, getHistoricalStats, closePool, updateExecution } from './db/postgres';
import { createBranch, commitFiles, pushBranch, createPR } from './github/pr-creator';
import { generateReport, type ReportData, type ReportTest, type ReportHealing } from './reports/html-report';
import { backupFile, restoreFile, cleanupBackup } from './utils/file-utils';

const MOD = 'orchestrator';

// ─── Config ────────────────────────────────────────────────────

interface Config {
  testRepoPath: string;
  siteUrl: string;
  githubToken: string;
  owner: string;
  repoName: string;
  reportDir: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string = ''): string => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1]! : def;
  };

  return {
    testRepoPath: get('--repo', '/home/ubuntu/github_repos/selfhealing_agent_poc'),
    siteUrl: get('--site-url', 'https://opensource-demo.orangehrmlive.com'),
    githubToken: get('--github-token', process.env['GITHUB_TOKEN'] ?? ''),
    owner: get('--owner', 'PrasanthLevelUp'),
    repoName: get('--repo-name', 'selfhealing_agent_poc'),
    reportDir: get('--report-dir', '/home/ubuntu/healing_reports'),
  };
}

// ─── Main Flow ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = parseArgs();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  logger.info(MOD, '═══ LevelUp AI QA Agent starting ═══', { timestamp, repo: cfg.testRepoPath });

  // Ensure report dir exists
  fs.mkdirSync(cfg.reportDir, { recursive: true });

  // ── Step 1: Get current commit SHA ──
  const { execSync } = await import('child_process');
  let commitSha = 'unknown';
  try {
    commitSha = execSync('git rev-parse HEAD', { cwd: cfg.testRepoPath, encoding: 'utf-8' }).trim();
  } catch { /* ignore */ }
  logger.info(MOD, `Starting commit: ${commitSha.slice(0, 8)}`);

  // ── Step 2: Run tests ──
  logger.info(MOD, '── Step 1: Running Playwright tests ──');
  const runResult = runTests(cfg.testRepoPath);

  // Save run log
  const logPath = path.join(cfg.reportDir, `run_log_${timestamp}.txt`);
  fs.writeFileSync(logPath, `STDOUT:\n${runResult.stdout}\n\nSTDERR:\n${runResult.stderr}`, 'utf-8');

  // ── Step 3: Analyze results ──
  logger.info(MOD, '── Step 2: Analyzing results ──');
  const analysis = analyzeResults(runResult.resultsFile, cfg.testRepoPath, cfg.siteUrl);

  // ── Step 4: Log initial executions ──
  const execIds: Map<string, number> = new Map();
  for (const test of analysis.tests) {
    const id = await logExecution({
      test_name: test.testName,
      status: test.status,
      error_message: test.errors.join('\n').slice(0, 1000),
      github_commit_sha: commitSha,
      duration_ms: test.durationMs,
    });
    if (test.status !== 'passed') execIds.set(test.testName, id);
  }

  // Track results for report
  const reportTests: ReportTest[] = analysis.tests.map(t => ({
    testName: t.testName, status: t.status, durationMs: t.durationMs,
    error: t.errors.join('\n').slice(0, 200), healed: false,
  }));
  const reportHealings: ReportHealing[] = [];
  const commits: Array<{ files: string[]; message: string }> = [];
  let healedCount = 0;

  // ── Step 5: Healing loop ──
  if (analysis.failures.length > 0) {
    logger.info(MOD, `── Step 3: Healing ${analysis.failures.length} failure(s) ──`);

    for (const failure of analysis.failures) {
      const execId = execIds.get(failure.testName) ?? 0;
      let healed = false;

      // Backup original file
      backupFile(failure.testFilePath);

      // ─── Level 1: Rule-based ───
      logger.info(MOD, `[L1] Rule-based healing for "${failure.testName}"`);
      const ruleResult = ruleBasedHeal(failure);

      for (const suggestion of ruleResult.alternatives) {
        if (healed) break;
        const failedLoc = failure.failedLocator ?? '';
        const applied = applyFix(failure.testFilePath, failedLoc, suggestion.newLocator, ruleResult.addWait);
        if (!applied) continue;

        // Re-run just this test
        const rerun = runTests(cfg.testRepoPath, failure.file);
        const success = rerun.exitCode === 0;

        await logHealing({
          test_execution_id: execId,
          failed_locator: failedLoc,
          healed_locator: suggestion.newLocator,
          healing_strategy: 'rule_based',
          ai_tokens_used: 0,
          success,
          confidence: suggestion.confidence,
          error_context: failure.errorMessage.slice(0, 500),
        });

        if (success) {
          healed = true;
          cleanupBackup(failure.testFilePath);
          await storeSuccessfulPattern(failedLoc, suggestion.newLocator, 'rule_based', failure.errorMessage, cfg.siteUrl);
          commits.push({
            files: [path.relative(cfg.testRepoPath, failure.testFilePath)],
            message: `🔧 Auto-heal: Fixed ${failure.testName} - ${failedLoc} → ${suggestion.newLocator}`,
          });
          reportHealings.push({
            testName: failure.testName, failedLocator: failedLoc,
            healedLocator: suggestion.newLocator, strategy: 'rule_based',
            aiTokensUsed: 0, success: true,
          });
          logger.info(MOD, `✅ [L1] Healed with rule-based: "${suggestion.newLocator}"`);
        } else {
          restoreFile(failure.testFilePath);
        }
      }
      if (healed) { healedCount++; updateReportTest(reportTests, failure.testName); continue; }

      // ─── Level 2: DB pattern ───
      logger.info(MOD, `[L2] DB pattern lookup for "${failure.testName}"`);
      const dbResult = await dbPatternHeal(failure);
      if (dbResult) {
        const failedLoc = failure.failedLocator ?? '';
        const applied = applyFix(failure.testFilePath, failedLoc, dbResult.newLocator);
        if (applied) {
          const rerun = runTests(cfg.testRepoPath, failure.file);
          const success = rerun.exitCode === 0;

          await logHealing({
            test_execution_id: execId,
            failed_locator: failedLoc,
            healed_locator: dbResult.newLocator,
            healing_strategy: 'database_pattern',
            success,
            confidence: dbResult.confidence,
          });

          if (success) {
            healed = true;
            cleanupBackup(failure.testFilePath);
            await storeSuccessfulPattern(failedLoc, dbResult.newLocator, 'database_pattern', failure.errorMessage, cfg.siteUrl);
            commits.push({
              files: [path.relative(cfg.testRepoPath, failure.testFilePath)],
              message: `🔧 Auto-heal: Fixed ${failure.testName} - ${failedLoc} → ${dbResult.newLocator}`,
            });
            reportHealings.push({
              testName: failure.testName, failedLocator: failedLoc,
              healedLocator: dbResult.newLocator, strategy: 'database_pattern',
              aiTokensUsed: 0, success: true,
            });
            logger.info(MOD, `✅ [L2] Healed with DB pattern: "${dbResult.newLocator}"`);
          } else {
            restoreFile(failure.testFilePath);
          }
        }
      }
      if (healed) { healedCount++; updateReportTest(reportTests, failure.testName); continue; }

      // ─── Level 3: AI reasoning ───
      logger.info(MOD, `[L3] AI reasoning for "${failure.testName}"`);
      try {
        const aiReq: AIHealRequest = {
          failedLocator: failure.failedLocator ?? '',
          errorMessage: failure.errorMessage,
          failedCodeLine: failure.failedCodeLine,
          domSnippet: '',  // Will be populated by daemon's browser automation if needed
          testFileName: failure.file,
          siteUrl: cfg.siteUrl,
        };
        const aiResult = await healWithAI(aiReq);

        if (aiResult.newLocator) {
          const failedLoc = failure.failedLocator ?? '';
          const applied = applyFix(failure.testFilePath, failedLoc, aiResult.newLocator);
          if (applied) {
            const rerun = runTests(cfg.testRepoPath, failure.file);
            const success = rerun.exitCode === 0;

            await logHealing({
              test_execution_id: execId,
              failed_locator: failedLoc,
              healed_locator: aiResult.newLocator,
              healing_strategy: 'ai_reasoning',
              ai_tokens_used: aiResult.tokensUsed,
              success,
              confidence: aiResult.confidence,
              error_context: failure.errorMessage.slice(0, 500),
            });

            reportHealings.push({
              testName: failure.testName, failedLocator: failedLoc,
              healedLocator: aiResult.newLocator, strategy: 'ai_reasoning',
              aiTokensUsed: aiResult.tokensUsed, success,
            });

            if (success) {
              healed = true;
              cleanupBackup(failure.testFilePath);
              await storeSuccessfulPattern(failedLoc, aiResult.newLocator, 'ai_reasoning', failure.errorMessage, cfg.siteUrl, aiResult.tokensUsed);
              commits.push({
                files: [path.relative(cfg.testRepoPath, failure.testFilePath)],
                message: `🔧 Auto-heal: Fixed ${failure.testName} - ${failedLoc} → ${aiResult.newLocator}`,
              });
              logger.info(MOD, `✅ [L3] Healed with AI: "${aiResult.newLocator}" (${aiResult.tokensUsed} tokens)`);
            } else {
              restoreFile(failure.testFilePath);
            }
          }
        }
      } catch (e) {
        logger.warn(MOD, `[L3] AI healing failed: ${(e as Error).message}`);
      }

      if (healed) { healedCount++; updateReportTest(reportTests, failure.testName); }
      else {
        restoreFile(failure.testFilePath);
        logger.warn(MOD, `❌ Could not heal "${failure.testName}" — all 3 levels failed`);
      }
    }
  }

  // ── Step 6: Commit & PR ──
  let prUrl: string | null = null;
  if (commits.length > 0 && cfg.githubToken) {
    logger.info(MOD, `── Step 4: Creating PR with ${commits.length} commit(s) ──`);
    const branchName = `auto-heal/${timestamp}`;
    createBranch(cfg.testRepoPath, branchName, 'main');

    for (const c of commits) {
      commitFiles(cfg.testRepoPath, c);
    }

    pushBranch(cfg.testRepoPath, branchName, cfg.githubToken, cfg.owner, cfg.repoName);
    const pr = await createPR(
      cfg.githubToken, cfg.owner, cfg.repoName,
      branchName, 'main',
      `🔧 Auto-heal: ${commits.length} fix(es) — ${timestamp}`,
      buildPRBody(commits, reportHealings)
    );
    prUrl = pr?.url ?? null;
  }

  // ── Step 7: Generate report ──
  logger.info(MOD, '── Step 5: Generating report ──');
  const histStats = await getHistoricalStats();
  const reportData: ReportData = {
    timestamp: new Date().toISOString(),
    commitSha,
    prUrl: prUrl ?? undefined,
    siteUrl: cfg.siteUrl,
    repo: `${cfg.owner}/${cfg.repoName}`,
    totalTests: analysis.totalTests,
    passed: analysis.passed,
    failed: analysis.failed,
    healed: healedCount,
    tests: reportTests,
    healings: reportHealings,
    historicalStats: histStats,
  };

  const reportPath = path.join(cfg.reportDir, `report_${timestamp}.html`);
  generateReport(reportData, reportPath);

  // Also save raw data
  const dataPath = path.join(cfg.reportDir, `report_data_${timestamp}.json`);
  fs.writeFileSync(dataPath, JSON.stringify(reportData, null, 2));

  logger.info(MOD, '═══ Agent finished ═══', {
    totalTests: analysis.totalTests,
    passed: analysis.passed,
    failed: analysis.failed,
    healed: healedCount,
    report: reportPath,
    prUrl,
  });

  await closePool();
}

function updateReportTest(tests: ReportTest[], testName: string): void {
  const t = tests.find(x => x.testName === testName);
  if (t) { t.healed = true; t.status = 'healed'; }
}

function buildPRBody(commits: Array<{ message: string }>, healings: ReportHealing[]): string {
  const lines = [
    '## 🔧 Self-Healing Test Fixes\n',
    'This PR was automatically created by the **LevelUp AI QA Agent**.\n',
    '### Changes:',
    ...commits.map(c => `- ${c.message}`),
    '\n### Strategy Breakdown:',
    `- Rule-based: ${healings.filter(h => h.strategy === 'rule_based').length}`,
    `- DB Pattern: ${healings.filter(h => h.strategy === 'database_pattern').length}`,
    `- AI Reasoning: ${healings.filter(h => h.strategy === 'ai_reasoning').length}`,
    `- Total AI tokens: ${healings.reduce((s, h) => s + h.aiTokensUsed, 0)}`,
    '\n---',
    '*Generated by [LevelUp AI QA Agent](https://github.com/PrasanthLevelUp/levelup-ai-qa-agent)*',
  ];
  return lines.join('\n');
}

// Run
main().catch(err => {
  logger.error(MOD, `Fatal: ${(err as Error).message}`, { stack: (err as Error).stack });
  process.exit(1);
});
