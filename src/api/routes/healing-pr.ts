/**
 * Healing Auto-Commit Routes
 *
 * POST /api/healings/:id/create-pr   — Create a PR for ONE healing (back-compat).
 * POST /api/healings/create-pr       — Create a SINGLE PR for MANY healings.
 *                                       Bundles exactly the file(s) that were
 *                                       fixed (grouping multiple fixes per file)
 *                                       so a reviewer can merge to main manually.
 * GET  /api/healings/:id/preview-fix — Preview what a fix would look like.
 *
 * Design goals (kept deliberately small + scalable):
 *   • One healing == one (file, locator) repair. A job may produce many.
 *   • A PR is built from the *resolved set* of healings: each fix is mapped to
 *     its target file, fixes are grouped by file, and every fix for a file is
 *     applied to that file's content in sequence. The PR therefore contains
 *     exactly the files we changed — 1 or N — plus one combined healing report.
 *   • We NEVER auto-merge. The PR targets the repo's default branch for a human
 *     to review and merge manually.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import { getPool, getRepository, logPR } from '../../db/postgres';
import { GitHubService, type CommitFileSpec } from '../../services/github-service';
import { CodePatcher, type HealingFix } from '../../services/code-patcher';
import { createRepoPathResolver } from '../../intelligence/repo-path-resolver';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const MOD = 'healing-pr';

/* -------------------------------------------------------------------------- */
/*  Small typed HTTP error so the core can signal a status code               */
/* -------------------------------------------------------------------------- */

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/* -------------------------------------------------------------------------- */
/*  Result shapes                                                             */
/* -------------------------------------------------------------------------- */

interface FixOutcome {
  healingId: number;
  testName: string;
  failedLocator: string;
  healedLocator: string;
  strategy: string;
  confidence: number;
  patched: boolean;
  replacements: number;
  description: string;
}

interface FileOutcome {
  filePath: string;
  isPageObject: boolean;
  changed: boolean;
  totalReplacements: number;
  fixes: FixOutcome[];
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function createHealingPRRouter(): Router {
  const router = Router();
  const patcher = new CodePatcher();

  /* ── POST /create-pr — bundle MANY healings into ONE PR ───────────────── */
  router.post('/create-pr', async (req: Request, res: Response) => {
    const companyId = (req as any).companyId;
    try {
      const { repositoryId, healingIds, githubToken } = req.body || {};

      if (!repositoryId) {
        return res.status(400).json({ error: 'repositoryId is required' });
      }
      if (!Array.isArray(healingIds) || healingIds.length === 0) {
        return res.status(400).json({ error: 'healingIds (non-empty array) is required' });
      }

      const ids = healingIds
        .map((x: unknown) => parseInt(String(x), 10))
        .filter((n: number) => Number.isFinite(n));
      if (ids.length === 0) {
        return res.status(400).json({ error: 'healingIds contained no valid numeric ids' });
      }

      const healings = await getHealingActionsByIds(ids);
      if (healings.length === 0) {
        return res.status(404).json({ error: 'No healing actions found for the provided ids' });
      }

      const data = await executeHealingPR({
        patcher,
        healings,
        repositoryId,
        companyId,
        githubToken,
      });
      return res.json({ success: true, data });
    } catch (err: any) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }
      logger.error(MOD, 'Batch healing PR failed', { error: err.message });
      return res.status(500).json({ error: 'Failed to create healing PR', details: err.message });
    }
  });

  /* ── POST /:id/create-pr — single healing (back-compat) ───────────────── */
  router.post('/:id/create-pr', async (req: Request, res: Response) => {
    const healingId = parseInt(String(req.params.id), 10);
    const companyId = (req as any).companyId;

    try {
      const { repositoryId, testFilePath, githubToken } = req.body || {};

      if (!repositoryId) {
        return res.status(400).json({ error: 'repositoryId is required' });
      }

      const healing = await getHealingAction(healingId);
      if (!healing) {
        return res.status(404).json({ error: 'Healing action not found' });
      }

      const data = await executeHealingPR({
        patcher,
        healings: [healing],
        repositoryId,
        companyId,
        githubToken,
        testFilePathOverride: testFilePath,
      });
      return res.json({ success: true, data });
    } catch (err: any) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }
      logger.error(MOD, 'Healing auto-commit failed', { healingId, error: err.message });
      return res.status(500).json({ error: 'Failed to create healing PR', details: err.message });
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
/*  Core: resolve files → apply fixes per file → ONE PR                       */
/* -------------------------------------------------------------------------- */

async function executeHealingPR(opts: {
  patcher: CodePatcher;
  healings: any[];
  repositoryId: number | string;
  companyId: number | undefined;
  githubToken?: string;
  /** Only honoured when committing a single healing. */
  testFilePathOverride?: string;
}): Promise<any> {
  const { patcher, healings, repositoryId, companyId, githubToken, testFilePathOverride } = opts;

  // 1. Keep only healings we can actually commit.
  const committable = healings.filter((h) => h.success && h.healed_locator);
  const skipped = healings
    .filter((h) => !(h.success && h.healed_locator))
    .map((h) => ({
      healingId: h.id,
      testName: h.test_name,
      reason: !h.success ? 'healing was not successful' : 'no healed locator',
    }));

  if (committable.length === 0) {
    throw new HttpError(
      400,
      'No committable healings — only successful healings with a healed locator can be turned into a PR.',
    );
  }

  // 2. Resolve repository + token.
  if (companyId == null) throw new HttpError(401, 'Missing company context');
  const repo = await getRepository(Number(repositoryId), companyId);
  if (!repo) throw new HttpError(404, 'Repository not found');
  if (!repo.url) throw new HttpError(400, 'Repository has no URL configured');

  const token = githubToken || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new HttpError(
      400,
      'GitHub token required. Provide githubToken in request body or set GITHUB_TOKEN env variable.',
    );
  }

  const parsed = GitHubService.parseRepoUrl(repo.url);
  if (!parsed) throw new HttpError(400, `Cannot parse GitHub URL: ${repo.url}`);

  const github = new GitHubService({ token, owner: parsed.owner, repo: parsed.repo });
  const baseBranch = repo.branch || 'main';
  const singleHealing = committable.length === 1;

  // 3. Clone once, do all work, always clean up.
  let cloneDir: string | null = null;
  try {
    cloneDir = await github.cloneRepo(baseBranch);
    const resolver = createRepoPathResolver(cloneDir);

    /* 3a. Map every committable healing → a repo-relative file path.        */
    /*     fixesByFile preserves insertion order so reports read naturally.  */
    const fixesByFile = new Map<string, Array<{ healing: any; fix: HealingFix; isPageObject: boolean }>>();

    for (const healing of committable) {
      const isPageObject = healing.is_page_object_patch === true && !!healing.target_file_path;

      let filePath: string | null = null;
      if (isPageObject) {
        // Patch the shared Page Object — one edit repairs every dependent test.
        filePath = resolver.toRepoRelative(healing.target_file_path);
        if (!filePath) {
          skipped.push({
            healingId: healing.id,
            testName: healing.test_name,
            reason: `Page Object target "${healing.target_file_path}" not found in repo`,
          });
          continue;
        }
      } else if (singleHealing && testFilePathOverride) {
        filePath = testFilePathOverride;
      } else if (healing.target_file_path) {
        // Prefer the exact file captured from the failure stack when present.
        filePath = resolver.toRepoRelative(healing.target_file_path) || null;
      }

      if (!filePath) {
        filePath = await findTestFile(cloneDir, healing.test_name);
      }
      if (!filePath) {
        skipped.push({
          healingId: healing.id,
          testName: healing.test_name,
          reason: 'Could not locate the test/source file in the repo',
        });
        continue;
      }

      const absPath = path.join(cloneDir, filePath);
      if (!fs.existsSync(absPath)) {
        skipped.push({
          healingId: healing.id,
          testName: healing.test_name,
          reason: `Resolved file does not exist: ${filePath}`,
        });
        continue;
      }

      const fix: HealingFix = {
        testName: healing.test_name,
        failedLocator: healing.failed_locator,
        healedLocator: healing.healed_locator,
        strategy: healing.healing_strategy,
        confidence: healing.confidence || 0,
        filePath,
      };

      if (!fixesByFile.has(filePath)) fixesByFile.set(filePath, []);
      fixesByFile.get(filePath)!.push({ healing, fix, isPageObject });
    }

    if (fixesByFile.size === 0) {
      throw new HttpError(
        400,
        `Could not locate any target file for the requested healing(s). ` +
          `Provide testFilePath (single healing) or ensure the repository matches the tested code.`,
      );
    }

    /* 3b. Apply every fix for a file to THAT file's content, in sequence.   */
    const fileOutcomes: FileOutcome[] = [];
    const commitFiles: CommitFileSpec[] = [];

    for (const [filePath, entries] of fixesByFile) {
      const absPath = path.join(cloneDir, filePath);
      const originalCode = fs.readFileSync(absPath, 'utf-8');

      let current = originalCode;
      let totalReplacements = 0;
      const fixOutcomes: FixOutcome[] = [];

      for (const { healing, fix } of entries) {
        const result = patcher.applyHealingFix(current, fix);
        if (result.patched) {
          current = result.patchedCode;
          totalReplacements += result.replacements;
        }
        fixOutcomes.push({
          healingId: healing.id,
          testName: fix.testName,
          failedLocator: fix.failedLocator,
          healedLocator: fix.healedLocator,
          strategy: fix.strategy,
          confidence: fix.confidence,
          patched: result.patched,
          replacements: result.replacements,
          description: result.description,
        });
      }

      const changed = current !== originalCode;
      if (changed) {
        commitFiles.push({ filePath, content: current });
      }
      fileOutcomes.push({
        filePath,
        isPageObject: entries.some((e) => e.isPageObject),
        changed,
        totalReplacements,
        fixes: fixOutcomes,
      });
    }

    const patchedCount = fileOutcomes.reduce(
      (n, f) => n + f.fixes.filter((x) => x.patched).length,
      0,
    );
    const changedFiles = fileOutcomes.filter((f) => f.changed).map((f) => f.filePath);

    // 4. Always include a combined healing report (gives manual instructions
    //    even when a selector could not be auto-patched).
    const timestamp = Date.now();
    const reportName = singleHealing
      ? `healing-report-${committable[0].id}.md`
      : `healing-report-batch-${timestamp}.md`;
    const reportPath = `healing-reports/${reportName}`;
    commitFiles.push({
      filePath: reportPath,
      content: generateCombinedReport(fileOutcomes, skipped),
    });

    // 5. Branch name.
    const branchName = singleHealing
      ? `heal/${slug(committable[0].test_name)}-${timestamp}`
      : `heal/batch-${changedFiles.length || fileOutcomes.length}-files-${timestamp}`;

    // 6. Write files, commit, push, PR — using one cloned worktree.
    for (const f of commitFiles) {
      const abs = path.join(cloneDir, f.filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content, 'utf-8');
    }

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
      return {
        message: 'No changes to commit — the fix(es) may already be applied on the base branch.',
        patchedCount,
        changedFiles,
        skipped,
      };
    }

    const commitMsg = buildCommitMessage(fileOutcomes, patchedCount, changedFiles.length);
    git(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
    const commitSha = git('rev-parse HEAD');
    git(`push -u origin ${branchName}`);

    const pr = await github.createPR(branchName, baseBranch, {
      title: buildPRTitle(fileOutcomes, changedFiles.length, patchedCount),
      body: generateCombinedPRBody(fileOutcomes, skipped, baseBranch),
      labels: ['levelup-ai', 'auto-heal', 'test-fix'],
    });
    if (!pr) {
      throw new HttpError(500, 'Branch was pushed but PR creation failed');
    }

    // 7. Best-effort PR log.
    try {
      await logPR(
        {
          job_id: singleHealing ? `heal-${committable[0].id}` : `heal-batch-${timestamp}`,
          pr_url: pr.url,
          pr_number: pr.number,
          branch_name: branchName,
          commit_sha: commitSha,
          repo_owner: parsed.owner,
          repo_name: parsed.repo,
          base_branch: baseBranch,
          files_changed: commitFiles.map((f) => f.filePath),
          healing_count: patchedCount,
          status: 'open',
        },
        companyId,
      );
    } catch (dbErr) {
      logger.warn(MOD, 'Failed to log PR to DB (non-critical)', { error: (dbErr as Error).message });
    }

    logger.info(MOD, 'Healing PR created', {
      prUrl: pr.url,
      prNumber: pr.number,
      files: changedFiles.length,
      patchedCount,
      skipped: skipped.length,
    });

    return {
      patchedCount,
      changedFiles,
      skipped,
      files: fileOutcomes.map((f) => ({
        filePath: f.filePath,
        changed: f.changed,
        isPageObject: f.isPageObject,
        replacements: f.totalReplacements,
        fixes: f.fixes,
      })),
      github: {
        prUrl: pr.url,
        prNumber: pr.number,
        branchName,
        commitSha,
        baseBranch,
        repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
      },
    };
  } finally {
    if (cloneDir) {
      try {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      } catch {
        /* ok */
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  DB helpers                                                                */
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

async function getHealingActionsByIds(ids: number[]): Promise<any[]> {
  if (ids.length === 0) return [];
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ha.*, te.test_name AS exec_test_name, te.duration_ms
     FROM healing_actions ha
     LEFT JOIN test_executions te ON ha.test_execution_id = te.id
     WHERE ha.id = ANY($1::int[])
     ORDER BY ha.id ASC`,
    [ids],
  );
  return rows;
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
    const findResult = execSync(
      `find . -type f \\( -name "*.spec.ts" -o -name "*.test.ts" -o -name "*.spec.js" -o -name "*.test.js" \\) 2>/dev/null | head -20`,
      { cwd: repoDir, encoding: 'utf-8', timeout: 10_000 },
    ).trim();

    if (findResult) {
      const files = findResult.split('\n').filter(Boolean);
      // Try to find a file that partially matches the test name
      const words = testName.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      for (const f of files) {
        const fname = f.toLowerCase();
        if (words.some((w) => fname.includes(w))) {
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
/*  Small formatting helpers                                                  */
/* -------------------------------------------------------------------------- */

function slug(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

const STRATEGY_LABEL: Record<string, string> = {
  rule_based: '⚙️ Rule Engine',
  pattern_match: '🧠 Pattern Engine',
  ai: '🤖 AI Engine',
};

function labelFor(strategy: string): string {
  return STRATEGY_LABEL[strategy] || strategy;
}

function buildCommitMessage(files: FileOutcome[], patchedCount: number, changedFiles: number): string {
  if (changedFiles <= 1 && files.length === 1 && files[0].fixes.length === 1) {
    const f = files[0];
    const fx = f.fixes[0];
    const subject = f.isPageObject
      ? `🤖 fix: auto-heal broken selector in shared Page Object (${path.basename(f.filePath)})`
      : `🤖 fix: auto-heal broken selector in "${fx.testName}"`;
    return `${subject}\n\nStrategy: ${fx.strategy}\nConfidence: ${Math.round(fx.confidence * 100)}%\n\n- Old: ${fx.failedLocator}\n- New: ${fx.healedLocator}\n\nGenerated by LevelUp AI Self-Healing Engine`;
  }
  const lines = files
    .filter((f) => f.changed)
    .map((f) => `- ${f.filePath} (${f.fixes.filter((x) => x.patched).length} fix(es))`)
    .join('\n');
  return `🤖 fix: auto-heal ${patchedCount} broken selector(s) across ${changedFiles} file(s)\n\n${lines}\n\nGenerated by LevelUp AI Self-Healing Engine`;
}

function buildPRTitle(files: FileOutcome[], changedFiles: number, patchedCount: number): string {
  if (files.length === 1 && files[0].fixes.length === 1) {
    const f = files[0];
    if (!f.changed) return `📋 Healing Suggestion: ${f.fixes[0].testName}`;
    return f.isPageObject
      ? `🤖 Auto-Heal (shared Page Object): ${path.basename(f.filePath)}`
      : `🤖 Auto-Heal: ${f.fixes[0].testName}`;
  }
  return `🤖 Auto-Heal: ${patchedCount} selector fix(es) across ${changedFiles} file(s)`;
}

/* -------------------------------------------------------------------------- */
/*  PR body + report generators (handle 1..N files)                          */
/* -------------------------------------------------------------------------- */

function generateCombinedPRBody(files: FileOutcome[], skipped: any[], baseBranch: string): string {
  const totalFixes = files.reduce((n, f) => n + f.fixes.length, 0);
  const patched = files.reduce((n, f) => n + f.fixes.filter((x) => x.patched).length, 0);
  const changed = files.filter((f) => f.changed);

  const fileSections = files
    .map((f) => {
      const poNote = f.isPageObject
        ? ' 🧩 _shared Page Object — repairs every dependent test_'
        : '';
      const diffs = f.fixes
        .map(
          (fx) =>
            `\`\`\`diff\n- ${fx.failedLocator}\n+ ${fx.healedLocator}\n\`\`\`\n` +
            `${fx.patched ? `✅ ${fx.replacements} replacement(s)` : '⚠️ not auto-patched — apply manually'} · ${labelFor(fx.strategy)} · ${Math.round(fx.confidence * 100)}% · healing #${fx.healingId}`,
        )
        .join('\n\n');
      return `#### \`${f.filePath}\`${poNote}\n\n${diffs}`;
    })
    .join('\n\n');

  const skippedSection =
    skipped.length > 0
      ? `\n### ⏭️ Skipped (${skipped.length})\n\n` +
        skipped.map((s) => `- healing #${s.healingId} — ${s.reason}`).join('\n') +
        '\n'
      : '';

  return `## 🤖 LevelUp AI — Automated Healing Fix

> This PR was automatically generated by the LevelUp AI QA Self-Healing Engine.
> It targets \`${baseBranch}\` for **manual review and merge** — nothing is merged automatically.

### 📋 Summary

| Field | Value |
|-------|-------|
| **Files changed** | ${changed.length} |
| **Selectors healed** | ${patched} / ${totalFixes} |
| **Status** | ${patched === totalFixes ? '✅ all auto-patched' : patched > 0 ? '⚠️ partial — some need manual fixes' : '📋 suggestion only'} |

### 🔧 Changes by file

${fileSections}
${skippedSection}
### 🧪 How to Verify

1. Pull this branch.
2. Run the affected tests, e.g. \`npx playwright test\`.
3. Confirm the previously-broken selectors now pass and no other tests regress.

---

> ⚠️ **Review recommended** — these fixes were validated by the healing engine, but please review the selector change(s) before merging to \`${baseBranch}\`.
>
> 🏷️ *Generated by LevelUp AI Self-Healing Engine*
`;
}

function generateCombinedReport(files: FileOutcome[], skipped: any[]): string {
  const totalFixes = files.reduce((n, f) => n + f.fixes.length, 0);
  const patched = files.reduce((n, f) => n + f.fixes.filter((x) => x.patched).length, 0);

  const fileSections = files
    .map((f) => {
      const rows = f.fixes
        .map(
          (fx) =>
            `| \`${fx.failedLocator}\` | \`${fx.healedLocator}\` | ${fx.strategy} | ${Math.round(
              fx.confidence * 100,
            )}% | ${fx.patched ? `✅ ${fx.replacements}` : '⚠️ manual'} | #${fx.healingId} |`,
        )
        .join('\n');
      return (
        `## ${f.filePath}${f.isPageObject ? ' (shared Page Object)' : ''}\n\n` +
        `${f.changed ? `✅ Auto-patched — ${f.totalReplacements} replacement(s).` : '⚠️ No change applied — apply the fix(es) below manually.'}\n\n` +
        `| Before | After | Strategy | Confidence | Patched | Healing |\n` +
        `|--------|-------|----------|------------|---------|---------|\n${rows}\n`
      );
    })
    .join('\n');

  const skippedSection =
    skipped.length > 0
      ? `\n## Skipped\n\n${skipped.map((s) => `- healing #${s.healingId} (${s.testName || 'unknown'}) — ${s.reason}`).join('\n')}\n`
      : '';

  return `# Healing Report

**Generated:** ${new Date().toISOString()}
**Files:** ${files.length}
**Selectors healed:** ${patched} / ${totalFixes}

${fileSections}${skippedSection}
---

*Generated by LevelUp AI Self-Healing Engine*
`;
}
