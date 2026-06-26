/**
 * Healing Auto-Commit Routes
 *
 * POST /api/healings/:id/create-pr — Apply healing fix to test file and create GitHub PR
 * GET  /api/healings/:id/preview-fix — Preview what the fix would look like
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import { getPool, getRepository, logPR } from '../../db/postgres';
import { GitHubService, type CommitFileSpec } from '../../services/github-service';
import { CodePatcher, type HealingFix } from '../../services/code-patcher';
import { createRepoPathResolver } from '../../intelligence/repo-path-resolver';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';

const MOD = 'healing-pr';

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function createHealingPRRouter(): Router {
  const router = Router();
  const patcher = new CodePatcher();

  /* ── POST /:id/create-pr — Full auto-commit flow ──────────── */
  router.post('/:id/create-pr', async (req: Request, res: Response) => {
    const healingId = parseInt(String(req.params.id), 10);
    const companyId = (req as any).companyId;

    try {
      const {
        repositoryId,
        projectId,
        testFilePath,    // e.g. "tests/login.spec.ts" — optional, auto-detected
        githubToken,
      } = req.body;

      if (!repositoryId) {
        return res.status(400).json({ error: 'repositoryId is required' });
      }

      logger.info(MOD, 'Healing auto-commit started', { healingId, repositoryId });

      // 1. Fetch the healing record
      const healing = await getHealingAction(healingId);
      if (!healing) {
        return res.status(404).json({ error: 'Healing action not found' });
      }

      if (!healing.success) {
        return res.status(400).json({ error: 'Cannot create PR for a failed healing — only successful healings can be committed' });
      }

      if (!healing.healed_locator) {
        return res.status(400).json({ error: 'Healing has no healed locator' });
      }

      // 2. Get repository
      const repo = await getRepository(repositoryId, companyId);
      if (!repo) {
        return res.status(404).json({ error: 'Repository not found' });
      }
      if (!repo.url) {
        return res.status(400).json({ error: 'Repository has no URL configured' });
      }

      // Determine GitHub token
      const token = githubToken || process.env.GITHUB_TOKEN;
      if (!token) {
        return res.status(400).json({
          error: 'GitHub token required. Provide githubToken in request body or set GITHUB_TOKEN env variable.',
        });
      }

      // 3. Parse repo URL
      const parsed = GitHubService.parseRepoUrl(repo.url);
      if (!parsed) {
        return res.status(400).json({ error: `Cannot parse GitHub URL: ${repo.url}` });
      }

      const github = new GitHubService({ token, owner: parsed.owner, repo: parsed.repo });
      const baseBranch = repo.branch || 'main';

      // 4. Clone and find the test file
      let cloneDir: string | null = null;
      try {
        cloneDir = await github.cloneRepo(baseBranch);

        // ── Repo Intelligence (Phase 4): "Patch the Page Object" ──
        // When the heal was attributed to a shared Page Object / helper, patch
        // THAT one file — one edit repairs every dependent test — instead of
        // grepping for an individual spec. The target file + line came from the
        // failure stack and were persisted on the healing_actions row.
        const isPageObjectPatch =
          healing.is_page_object_patch === true && !!healing.target_file_path;

        let filePath: string | null;
        if (isPageObjectPatch) {
          filePath = createRepoPathResolver(cloneDir).toRepoRelative(healing.target_file_path);
          if (!filePath) {
            return res.status(400).json({
              error: `Page Object target "${healing.target_file_path}" could not be located in the repository.`,
            });
          }
          logger.info(MOD, 'Patching shared Page Object (fixes all dependents)', {
            healingId,
            targetFile: filePath,
            impactedTests: healing.page_object_impact || 0,
          });
        } else {
          // Find the test file — use provided path or search
          filePath = testFilePath || await findTestFile(cloneDir, healing.test_name);
          if (!filePath) {
            return res.status(400).json({
              error: `Could not locate test file for "${healing.test_name}". Please provide testFilePath in the request body.`,
            });
          }
        }

        const absPath = path.join(cloneDir, filePath);
        if (!fs.existsSync(absPath)) {
          return res.status(400).json({ error: `Target file not found: ${filePath}` });
        }

        // 5. Read the original file and apply the patch
        const originalCode = fs.readFileSync(absPath, 'utf-8');

        const fix: HealingFix = {
          testName: healing.test_name,
          failedLocator: healing.failed_locator,
          healedLocator: healing.healed_locator,
          strategy: healing.healing_strategy,
          confidence: healing.confidence || 0,
          filePath,
        };

        const patchResult = patcher.applyHealingFix(originalCode, fix);

        if (!patchResult.patched) {
          // Even if we can't auto-patch, create a PR with a fix suggestion file
          logger.warn(MOD, 'Auto-patch failed, creating suggestion PR instead', { healingId });
        }

        // 6. Prepare files for commit
        const files: CommitFileSpec[] = [];

        if (patchResult.patched) {
          // Write the patched file
          files.push({ filePath, content: patchResult.patchedCode });
        }

        // Always create a healing report file
        const reportPath = `${path.dirname(filePath)}/healing-report-${healingId}.md`;
        files.push({
          filePath: reportPath,
          content: generateHealingReport(healing, fix, patchResult),
        });

        // 7. Create branch, commit, push, PR
        const timestamp = Date.now();
        const safeName = healing.test_name
          .replace(/[^a-zA-Z0-9]/g, '-')
          .replace(/-+/g, '-')
          .toLowerCase()
          .slice(0, 40);
        const branchName = `heal/${safeName}-${timestamp}`;

        const impactNote =
          isPageObjectPatch && (healing.page_object_impact || 0) > 0
            ? `\nShared Page Object patched — fixes ${healing.page_object_impact} dependent test(s).`
            : isPageObjectPatch
              ? `\nShared Page Object patched — fixes all dependent tests.`
              : '';
        const commitSubject = isPageObjectPatch
          ? `🤖 fix: auto-heal broken selector in shared Page Object (${path.basename(filePath)})`
          : `🤖 fix: auto-heal broken selector in "${healing.test_name}"`;
        const commitMsg = patchResult.patched
          ? `${commitSubject}\n\nHealing ID: ${healingId}\nStrategy: ${healing.healing_strategy}\nConfidence: ${Math.round((healing.confidence || 0) * 100)}%${impactNote}\n\n- Old: ${healing.failed_locator}\n- New: ${healing.healed_locator}\n\nGenerated by LevelUp AI Self-Healing Engine`
          : `🤖 docs: healing suggestion for "${healing.test_name}"\n\nHealing ID: ${healingId}\nNote: Auto-patch could not be applied — see healing report for manual fix instructions.`;

        // Write files to the cloned repo before committing
        for (const f of files) {
          const abs = path.join(cloneDir, f.filePath);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, f.content, 'utf-8');
        }

        // Git operations
        const git = (args: string) =>
          execSync(`git ${args}`, { cwd: cloneDir!, encoding: 'utf-8', timeout: 30_000 }).trim();

        git('config user.email "bot@leveluptesting.in"');
        git('config user.name "LevelUp AI Bot"');

        try {
          git(`checkout -b ${branchName}`);
        } catch {
          git(`checkout ${branchName}`);
        }

        git('add -A');
        const status = git('status --porcelain');
        if (!status) {
          return res.json({
            success: true,
            data: {
              message: 'No changes to commit — fix may already be applied',
              healingId,
            },
          });
        }

        const safeMsg = commitMsg.replace(/"/g, '\\"');
        git(`commit -m "${safeMsg}"`);
        const commitSha = git('rev-parse HEAD');
        git(`push -u origin ${branchName}`);

        // Create PR
        const prBody = generateHealingPRBody(healing, fix, patchResult);
        const pr = await github.createPR(branchName, baseBranch, {
          title: patchResult.patched
            ? (isPageObjectPatch
                ? `🤖 Auto-Heal (shared Page Object): ${path.basename(filePath)}`
                : `🤖 Auto-Heal: ${healing.test_name}`)
            : `📋 Healing Suggestion: ${healing.test_name}`,
          body: prBody,
          labels: ['levelup-ai', 'auto-heal', 'test-fix'],
        });

        if (!pr) {
          return res.status(500).json({ error: 'Branch was pushed but PR creation failed' });
        }

        // 8. Log PR to database
        try {
          await logPR({
            job_id: `heal-${healingId}`,
            pr_url: pr.url,
            pr_number: pr.number,
            branch_name: branchName,
            commit_sha: commitSha,
            repo_owner: parsed.owner,
            repo_name: parsed.repo,
            base_branch: baseBranch,
            files_changed: files.map(f => f.filePath),
            healing_count: 1,
            status: 'open',
          }, companyId);
        } catch (dbErr) {
          logger.warn(MOD, 'Failed to log PR to DB (non-critical)', { error: (dbErr as Error).message });
        }

        logger.info(MOD, 'Healing PR created successfully', {
          healingId,
          prUrl: pr.url,
          prNumber: pr.number,
          patched: patchResult.patched,
        });

        return res.json({
          success: true,
          data: {
            healingId,
            testName: healing.test_name,
            patched: patchResult.patched,
            patchDescription: patchResult.description,
            github: {
              prUrl: pr.url,
              prNumber: pr.number,
              branchName,
              commitSha,
              repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
            },
            files: files.map(f => f.filePath),
          },
        });
      } finally {
        // Cleanup
        if (cloneDir) {
          try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch { /* ok */ }
        }
      }
    } catch (err: any) {
      logger.error(MOD, 'Healing auto-commit failed', { healingId, error: err.message });
      return res.status(500).json({
        error: 'Failed to create healing PR',
        details: err.message,
      });
    }
  });

  /* ── GET /:id/preview-fix — Preview the fix without creating PR ── */
  router.get('/:id/preview-fix', async (req: Request, res: Response) => {
    const healingId = parseInt(String(req.params.id), 10);

    try {
      const healing = await getHealingAction(healingId);
      if (!healing) {
        return res.status(404).json({ error: 'Healing action not found' });
      }

      const fix: HealingFix = {
        testName: healing.test_name,
        failedLocator: healing.failed_locator,
        healedLocator: healing.healed_locator || '',
        strategy: healing.healing_strategy,
        confidence: healing.confidence || 0,
      };

      // Generate a sample patch preview
      const sampleCode = `// Sample test code showing the fix\nawait page.click('${healing.failed_locator}');\nawait page.locator('${healing.failed_locator}').fill('test');\n`;
      const preview = patcher.applyHealingFix(sampleCode, fix);

      return res.json({
        success: true,
        data: {
          healingId,
          testName: healing.test_name,
          status: healing.success ? 'healed' : 'failed',
          fix: {
            failedLocator: healing.failed_locator,
            healedLocator: healing.healed_locator,
            strategy: healing.healing_strategy,
            confidence: healing.confidence,
          },
          preview: {
            before: sampleCode,
            after: preview.patchedCode,
            canAutoFix: preview.patched,
          },
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to preview fix', details: err.message });
    }
  });

  return router;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

async function getHealingAction(id: number): Promise<any | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ha.*, te.test_name AS exec_test_name, te.duration_ms
     FROM healing_actions ha
     LEFT JOIN test_executions te ON ha.test_execution_id = te.id
     WHERE ha.id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Attempt to find the test file in the repo that matches the test name.
 * Searches for .spec.ts, .test.ts, .spec.js, .test.js files.
 */
async function findTestFile(repoDir: string, testName: string): Promise<string | null> {
  try {
    // Strategy 1: Search for files containing the test name
    const result = execSync(
      `grep -rl "${testName.replace(/"/g, '\\"').slice(0, 80)}" --include="*.spec.ts" --include="*.test.ts" --include="*.spec.js" --include="*.test.js" . 2>/dev/null | head -5`,
      { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 },
    ).trim();

    if (result) {
      const files = result.split('\n').filter(Boolean);
      // Return relative path (strip leading ./)
      return files[0].replace(/^\.\//, '');
    }

    // Strategy 2: Fuzzy match on filename
    const safeName = testName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '*');

    const findResult = execSync(
      `find . -type f \\( -name "*.spec.ts" -o -name "*.test.ts" -o -name "*.spec.js" -o -name "*.test.js" \\) 2>/dev/null | head -20`,
      { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 },
    ).trim();

    if (findResult) {
      const files = findResult.split('\n').filter(Boolean);
      // Try to find a file that partially matches the test name
      const words = testName.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      for (const f of files) {
        const fname = f.toLowerCase();
        if (words.some(w => fname.includes(w))) {
          return f.replace(/^\.\//, '');
        }
      }
      // Fallback: return the first test file
      return files[0].replace(/^\.\//, '');
    }

    return null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  PR Body Generator                                                         */
/* -------------------------------------------------------------------------- */

function generateHealingPRBody(healing: any, fix: HealingFix, patchResult: any): string {
  const confidence = Math.round((healing.confidence || 0) * 100);
  const strategyEmoji: Record<string, string> = {
    rule_based: '⚙️ Rule Engine',
    pattern_match: '🧠 Pattern Engine',
    ai: '🤖 AI Engine',
  };
  const strategyLabel = strategyEmoji[healing.healing_strategy] || healing.healing_strategy;
  const isPO = healing.is_page_object_patch === true && !!healing.target_file_path;
  const impact = Number(healing.page_object_impact) || 0;
  const poRow = isPO
    ? `| **Patch Target** | 🧩 Shared Page Object \`${fix.filePath}\`${impact > 0 ? ` — fixes ${impact} dependent test(s)` : ''} |\n`
    : '';
  const poCallout = isPO
    ? `\n### 🧩 Repo Intelligence — Patched a Shared Page Object\n\n` +
      `The broken selector lived inside a shared Page Object / helper, not an individual spec. ` +
      `Patching this one file (\`${fix.filePath}\`) repairs **every test that depends on it**` +
      `${impact > 0 ? ` — an estimated **${impact} test(s)** in one change` : ''}. ` +
      `This is more durable than editing each spec separately.\n`
    : '';

  return `## 🤖 LevelUp AI — Automated Healing Fix

> This PR was automatically generated by [LevelUp AI QA](https://app.leveluptesting.in) Self-Healing Engine.

### 📋 Summary

| Field | Value |
|-------|-------|
| **Test Name** | \`${healing.test_name}\` |
| **Healing ID** | #${healing.id} |
| **Strategy** | ${strategyLabel} |
| **Confidence** | ${confidence}% |
${poRow}| **Status** | ${patchResult.patched ? '✅ Auto-patched' : '📋 Suggestion only'} |
${poCallout}
### 🔧 What Changed

\`\`\`diff
- ${healing.failed_locator}
+ ${healing.healed_locator}
\`\`\`

${patchResult.patched
    ? `**${patchResult.replacements} replacement(s)** applied automatically.`
    : `⚠️ **Auto-patch could not be applied.** The selector was not found in the expected format. Please apply the fix manually.`
  }

${patchResult.description ? `**Details:** ${patchResult.description}` : ''}

### 🔍 Root Cause

${healing.error_context
    ? `\`\`\`\n${healing.error_context.slice(0, 500)}\n\`\`\``
    : 'Error context not available.'
  }

### ✅ Validation

- ${healing.validation_status === 'passed' ? '✅' : '⚠️'} Validation Status: **${healing.validation_status || 'unknown'}**
${healing.validation_reason ? `- ${healing.validation_reason}` : ''}
- Confidence Score: **${confidence}%**

### 🧪 How to Verify

1. Pull this branch
2. Run the affected test: \`npx playwright test --grep "${healing.test_name.slice(0, 60)}"\`
3. Verify the test passes with the new selector
4. Check that no other tests are affected

### 🤖 How It Works

1. **Detect** — Test runs and failure is captured with full DOM context
2. **Analyze** — ${strategyLabel} analyzes the failure pattern
3. **Heal** — A new locator is generated with ${confidence}% confidence
4. **Validate** — The healed locator is verified for existence, uniqueness, and interactability
5. **PR** — This automated PR is created for human review

---

> ⚠️ **Review recommended** — While this fix has been validated by the AI engine, please review the selector change before merging.
>
> 🏷️ *Generated by LevelUp AI Self-Healing Engine • Healing #${healing.id}*
`;
}

/* -------------------------------------------------------------------------- */
/*  Healing Report Generator                                                  */
/* -------------------------------------------------------------------------- */

function generateHealingReport(healing: any, fix: HealingFix, patchResult: any): string {
  const confidence = Math.round((healing.confidence || 0) * 100);
  const isPO = healing.is_page_object_patch === true && !!healing.target_file_path;
  const impact = Number(healing.page_object_impact) || 0;
  const poSection = isPO
    ? `\n## 🧩 Repo Intelligence — Shared Page Object\n\n` +
      `The broken selector lived inside a shared Page Object / helper (\`${fix.filePath}\`), ` +
      `so this single patch repairs **every dependent test**` +
      `${impact > 0 ? ` (≈ ${impact} test(s))` : ''} rather than one spec.\n`
    : '';

  return `# Healing Report — ${healing.test_name}

**Generated:** ${new Date().toISOString()}
**Healing ID:** ${healing.id}
**Strategy:** ${healing.healing_strategy}
**Confidence:** ${confidence}%
${isPO ? `**Patch Target:** Shared Page Object \`${fix.filePath}\`${impact > 0 ? ` (fixes ${impact} test(s))` : ''}\n` : ''}${poSection}
## Selector Change

| | Selector |
|---|---|
| **Before (broken)** | \`${healing.failed_locator}\` |
| **After (healed)** | \`${healing.healed_locator}\` |

## Patch Status

${patchResult.patched
    ? `✅ **Auto-patched successfully** — ${patchResult.replacements} replacement(s) made.`
    : `⚠️ **Manual fix needed** — The auto-patcher could not find the exact selector in the source code.`
  }

${patchResult.description}

## Error Context

\`\`\`
${healing.error_context || 'Not available'}
\`\`\`

## Validation

- Status: ${healing.validation_status || 'unknown'}
- Reason: ${healing.validation_reason || 'N/A'}

---

*Generated by LevelUp AI Self-Healing Engine*
`;
}
