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
import {
  getPool,
  getRepository,
  getRepositoryByUrl,
  getHealingJob,
  getHealingActionsByJobId,
  linkHealingActionsToPR,
  logPR,
} from '../../db/postgres';
import { GitHubService, GitHubPRError, type CommitFileSpec } from '../../services/github-service';
// The connected Tools-page token (notification_configs) — the SAME token the
// script-generation PR flow authenticates with. Aliased to avoid colliding with
// the git-push GitHubService above. Healing must resolve its token from here
// first so it behaves identically to script-gen instead of silently depending
// on a separate process.env.GITHUB_TOKEN that is usually unset in production.
import { GitHubService as ConnectedGitHubService } from '../../integrations/github-service';
import { CodePatcher, type HealingFix } from '../../services/code-patcher';
import { createRepoPathResolver } from '../../intelligence/repo-path-resolver';
import { getReportStore } from '../../reports/report-store';
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
    const userId = (req as any).userId;
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
        userId,
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
    const userId = (req as any).userId;

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
        userId,
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
/*  Job-scoped router — the frontend only knows the Job                       */
/* -------------------------------------------------------------------------- */

/**
 * Mounted at /api/jobs. Exposes:
 *   POST /api/jobs/:jobId/create-pr
 *
 * The frontend already shows a Job, so it should NOT have to know which
 * healing ids belong to it. The backend owns that relationship:
 *
 *   Job → successful healings → group by file → patch → ONE PR.
 *
 * The repository is derived from the persisted job (its repository_url), so the
 * body can be empty. An explicit `repositoryId` in the body still overrides,
 * and `githubToken` is optional (falls back to GITHUB_TOKEN).
 */
export function createJobPRRouter(): Router {
  const router = Router();
  const patcher = new CodePatcher();

  router.post('/:jobId/create-pr', async (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const companyId = (req as any).companyId;
    const userId = (req as any).userId;

    try {
      const { repositoryId, githubToken } = req.body || {};

      // 1. The job owns the repo relationship.
      const job = await getHealingJob(jobId, companyId);
      if (!job) {
        return res.status(404).json({ error: `Job not found: ${jobId}` });
      }

      // 2. Backend finds the job's successful healings — frontend stays dumb.
      const healings = await getHealingActionsByJobId(jobId, companyId);
      if (healings.length === 0) {
        return res.status(404).json({ error: 'No healing actions found for this job' });
      }

      // 3. Resolve the repo to target: explicit override → repo row matched by
      //    the job's stored URL → the job's raw URL + branch as a last resort.
      let repo: ResolvedRepo | undefined;
      if (!repositoryId) {
        if (job.repository_url && companyId != null) {
          const row = await getRepositoryByUrl(job.repository_url, companyId);
          if (row?.url) repo = { url: row.url, branch: row.branch || job.branch || 'main' };
        }
        if (!repo && job.repository_url) {
          repo = { url: job.repository_url, branch: job.branch || 'main' };
        }
        if (!repo) {
          return res.status(400).json({
            error:
              'Could not resolve a repository for this job. Pass repositoryId explicitly in the body.',
          });
        }
      }

      const data = await executeHealingPR({
        patcher,
        healings,
        repositoryId, // honoured only when repo is undefined
        repo,
        companyId,
        userId,
        githubToken,
        jobId,
      });
      return res.json({ success: true, data });
    } catch (err: any) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }
      logger.error(MOD, 'Job healing PR failed', { jobId, error: err.message });
      return res.status(500).json({ error: 'Failed to create healing PR', details: err.message });
    }
  });

  return router;
}

/* -------------------------------------------------------------------------- */
/*  Core: resolve files → apply fixes per file → ONE PR                       */
/* -------------------------------------------------------------------------- */

interface ResolvedRepo {
  url: string;
  branch: string;
}

/**
 * Resolve the repository (url + branch) a PR should target. Callers may pass a
 * numeric repositoryId (looked up + company-scoped) OR an already-resolved
 * { url, branch } (used by the jobId path, which derives the repo from the
 * persisted job). Throws HttpError with the right status on failure.
 */
async function resolveRepoForPR(opts: {
  repositoryId?: number | string;
  repo?: ResolvedRepo;
  companyId: number | undefined;
}): Promise<ResolvedRepo> {
  if (opts.repo) {
    if (!opts.repo.url) throw new HttpError(400, 'Resolved repository has no URL');
    return { url: opts.repo.url, branch: opts.repo.branch || 'main' };
  }
  if (opts.repositoryId == null) {
    throw new HttpError(400, 'repositoryId is required');
  }
  if (opts.companyId == null) throw new HttpError(401, 'Missing company context');
  const row = await getRepository(Number(opts.repositoryId), opts.companyId);
  if (!row) throw new HttpError(404, 'Repository not found');
  if (!row.url) throw new HttpError(400, 'Repository has no URL configured');
  return { url: row.url, branch: row.branch || 'main' };
}

async function executeHealingPR(opts: {
  patcher: CodePatcher;
  healings: any[];
  repositoryId?: number | string;
  /** Pre-resolved repo (jobId path). Takes precedence over repositoryId. */
  repo?: ResolvedRepo;
  companyId: number | undefined;
  userId?: number;
  githubToken?: string;
  /** Only honoured when committing a single healing. */
  testFilePathOverride?: string;
  /** Real owning job id — used for PR bookkeeping (pr_automations.job_id). */
  jobId?: string;
}): Promise<any> {
  const { patcher, healings, companyId, userId, githubToken, testFilePathOverride, jobId } = opts;

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
  const repo = await resolveRepoForPR({
    repositoryId: opts.repositoryId,
    repo: opts.repo,
    companyId,
  });

  // Resolve the token EXACTLY like the script-generation PR flow does:
  //   1. explicit githubToken in the request (rare override)
  //   2. the connected Tools-page token in the DB (notification_configs) —
  //      this is what script-gen uses and what the user actually connected
  //   3. process.env.GITHUB_TOKEN — last-resort fallback for headless/CI use
  // Previously healing only looked at (1)/(3), so a perfectly-connected Tools
  // token still produced a "git push … Password authentication" failure.
  let token = githubToken;
  let tokenSource = token ? 'request' : '';
  if (!token) {
    try {
      const connected = await new ConnectedGitHubService().getToken(companyId, userId);
      if (connected) {
        token = connected;
        tokenSource = 'connected-tools-token';
      }
    } catch (e: any) {
      logger.warn(MOD, 'Could not load connected GitHub token; falling back to env', {
        error: e?.message,
      });
    }
  }
  if (!token && process.env.GITHUB_TOKEN) {
    token = process.env.GITHUB_TOKEN;
    tokenSource = 'env';
  }
  if (!token) {
    throw new HttpError(
      400,
      'GitHub token required. Connect GitHub on the Tools page, pass githubToken in the request body, or set the GITHUB_TOKEN env variable.',
    );
  }
  logger.info(MOD, 'Resolved GitHub token for healing PR', { tokenSource });

  const parsed = GitHubService.parseRepoUrl(repo.url);
  if (!parsed) throw new HttpError(400, `Cannot parse GitHub URL: ${repo.url}`);

  const github = new GitHubService({ token, owner: parsed.owner, repo: parsed.repo });
  const baseBranch = repo.branch || 'main';
  const singleHealing = committable.length === 1;

  // 2b. Pre-flight: fail FAST with a clear, actionable message if the token
  //     cannot push to this repo. Without this, a PUBLIC repo clones fine with
  //     a bad/expired token and only blows up much later at `git push` with the
  //     opaque "Password authentication is not supported" error.
  const access = await github.verifyAccess();
  if (!access.ok) {
    throw new HttpError(access.status, access.reason);
  }

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

    // 4. Build the combined healing report — but DO NOT commit it to the customer
    //    repo. The report is execution METADATA owned by LevelUp. The DOCUMENT is
    //    persisted to object storage (see report-store.ts) and only an opaque
    //    reference (report_uri) is kept in the database; it is also summarised in the
    //    PR body. Keeping it out of git means (a) customer repositories contain only
    //    source code — never an ever-growing healing-reports/ folder — and (b) the
    //    report's live timestamp can no longer pollute `git status`/`git diff`, so a
    //    heal that changed no source file now produces a genuinely empty changeset and
    //    is caught cleanly below instead of pushing a phantom, fix-less PR.
    const timestamp = Date.now();
    const reportName = singleHealing
      ? `healing-report-${committable[0].id}.md`
      : `healing-report-batch-${timestamp}.md`;
    const reportMarkdown = generateCombinedReport(fileOutcomes, skipped);
    // Storage key namespaced by repo so the layout maps 1:1 onto an object-storage
    // bucket/prefix when we migrate off the local volume.
    const reportKey = `healing-reports/${parsed.owner}/${parsed.repo}/${reportName}`;

    // 5. Branch name.
    const branchName = singleHealing
      ? `heal/${slug(committable[0].test_name)}-${timestamp}`
      : `heal/batch-${changedFiles.length || fileOutcomes.length}-files-${timestamp}`;

    // 6. Write files, commit, push, PR — using one cloned worktree.
    //    Defensive: selectCommitFiles guarantees no healing report ever lands in
    //    the commit, even if an upstream change re-introduces one.
    const filesToCommit = selectCommitFiles(commitFiles);
    for (const f of filesToCommit) {
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

    // ── Pre-push invariant #1: a PR MUST contain a real SOURCE change ────────
    // Because the healing report is NO LONGER committed (it is platform metadata),
    // an empty working tree here unambiguously means healing changed no source
    // file — the locator is already fixed on the base branch, or it did not match
    // the freshly-cloned file. Stop cleanly: do NOT commit, push, or call GitHub.
    const status = git('status --porcelain');
    if (!status) {
      logger.warn(MOD, 'No source change after healing — skipping commit/push/PR', {
        branchName,
        baseBranch,
        changedSourceFiles: changedFiles,
        patchedCount,
      });
      return {
        message:
          'No repository changes detected: healing did not modify any source file. This usually ' +
          'means the target locator is already fixed on the base branch, or it did not match the ' +
          'current file contents. No branch was pushed and no pull request was opened.',
        patchedCount,
        changedFiles,
        skipped,
      };
    }

    const commitMsg = buildCommitMessage(fileOutcomes, patchedCount, changedFiles.length);
    git(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
    const commitSha = git('rev-parse HEAD');

    // ── Pre-push invariant #2 (defense-in-depth): diff vs base must be non-empty.
    // With the report out of git this should always hold when invariant #1 passed,
    // but a tree-identical commit (e.g. a stale/already-merged state) would still
    // be rejected by GitHub as 422 "No commits between". Catch it locally first.
    let committedPaths: string[] = [];
    try {
      committedPaths = git(`diff --name-only origin/${baseBranch} HEAD`)
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean);
    } catch { /* origin ref may be unavailable on shallow edge cases — fall through */ }

    // Per-stage diagnostics so a failed/empty heal self-explains in the logs.
    logger.info(MOD, 'Post-commit changeset', {
      branchName,
      commitSha,
      committedPaths,
      changedSourceFiles: changedFiles,
      patchedCount,
    });

    if (committedPaths.length === 0) {
      logger.warn(MOD, 'Commit is tree-identical to base — skipping push/PR', {
        branchName,
        baseBranch,
        commitSha,
      });
      return {
        message:
          `No repository changes detected: the commit is identical to "${baseBranch}" (the fix is ` +
          `already present there). No branch was pushed and no pull request was opened.`,
        patchedCount,
        changedFiles,
        skipped,
      };
    }

    // Pre-push diagnostics (token-safe). These pinpoint the three most common
    // causes of a "Password authentication is not supported" push failure:
    //   • token absent/empty  → tokenPresent=false / tokenLength=0
    //   • token whitespace    → tokenLength looks wrong vs expected
    //   • origin not authed   → remoteRedacted shows no "x-access-token:***@"
    // The remote URL is redacted so the secret never reaches logs.
    let remoteRedacted = '(unknown)';
    try {
      remoteRedacted = git('remote -v')
        .split('\n')[0]
        .replace(/x-access-token:[^@]+@/g, 'x-access-token:***@')
        .replace(/https:\/\/[^@/]+@/g, 'https://***@');
    } catch { /* non-fatal */ }
    logger.info(MOD, 'Pre-push diagnostics', {
      branchName,
      tokenSource,
      tokenPresent: github.hasToken,
      tokenLength: github.tokenLength,
      remoteRedacted,
      authedOrigin: /x-access-token:\*\*\*@/.test(remoteRedacted),
    });

    try {
      git(`push -u origin ${branchName}`);
    } catch (pushErr: any) {
      const raw = String(pushErr?.stderr || pushErr?.message || pushErr);
      // Never leak the tokenised remote URL in the error surfaced to the client.
      const sanitized = raw.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
      if (/Authentication failed|Password authentication is not supported|invalid username or token/i.test(sanitized)) {
        // Translate the opaque git auth failure into an actionable message that
        // names the token SOURCE healing actually used and the exact fix per source.
        const sourceLabel =
          tokenSource === 'connected-tools-token' ? 'Connected GitHub account (Tools page)'
          : tokenSource === 'request' ? 'token supplied in the request'
          : tokenSource === 'env' ? 'GITHUB_TOKEN environment variable'
          : 'unknown source';
        const fix =
          tokenSource === 'connected-tools-token'
            ? 'Reconnect GitHub from the Tools page, or grant the token push access to this repo ' +
              '(classic PAT: "repo" scope; fine-grained PAT: Contents: Write + Pull requests: Write on this repository).'
            : tokenSource === 'env'
            ? 'Replace GITHUB_TOKEN on the backend with a token that has push access (repo / Contents: Write + Pull requests: Write).'
            : 'Provide a token with push access (repo / Contents: Write + Pull requests: Write).';
        throw new HttpError(
          401,
          `Unable to authenticate with GitHub for push.\nToken source: ${sourceLabel}\n` +
            `The token is invalid/expired or lacks push access to ${parsed.owner}/${parsed.repo}.\n${fix}`,
        );
      }
      throw new HttpError(500, `git push failed: ${sanitized}`);
    }

    let pr: { url: string; number: number } | null;
    try {
      pr = await github.createPR(branchName, baseBranch, {
        title: buildPRTitle(fileOutcomes, changedFiles.length, patchedCount),
        body: generateCombinedPRBody(fileOutcomes, skipped, baseBranch),
        labels: ['levelup-ai', 'auto-heal', 'test-fix'],
      });
    } catch (prErr) {
      // Surface GitHub's REAL reason instead of an opaque "PR creation failed".
      if (prErr instanceof GitHubPRError) {
        if (prErr.isNoDiff) {
          // Branch pushed but tree-identical to base (fix already on base).
          throw new HttpError(
            409,
            `The branch "${branchName}" was pushed but GitHub rejected the PR: ${prErr.message}. ` +
              `The healed change appears to already be present on "${baseBranch}" (a previous PR with the ` +
              `same fix was likely merged). Nothing new to review.`,
          );
        }
        if (prErr.isPermission) {
          throw new HttpError(
            403,
            `The branch "${branchName}" was pushed, but the GitHub token cannot open a pull request on ` +
              `${parsed.owner}/${parsed.repo} (GitHub said: ${prErr.message}). ` +
              `Grant the token "Pull requests: Write" (fine-grained PAT) or the "repo" scope (classic PAT), ` +
              `then retry.`,
          );
        }
        throw new HttpError(
          502,
          `The branch "${branchName}" was pushed, but GitHub rejected the PR` +
            (prErr.status ? ` (HTTP ${prErr.status})` : '') + `: ${prErr.message}`,
        );
      }
      throw prErr;
    }
    if (!pr) {
      throw new HttpError(500, 'Branch was pushed but PR creation failed');
    }

    // 7. Persist the PR linkage. PR metadata is stored ONCE in pr_automations
    //    (the single source of truth, keyed by the REAL owning job id when we
    //    have it). Each healing_action that landed in this PR then just
    //    references that row via its pr_automation_id FK — no duplicated
    //    pr_url/number/status, and a later status change (open→merged→closed)
    //    is a single pr_automations update. Dashboard joins through the FK.
    const patchedHealingIds = fileOutcomes
      .flatMap((f) => f.fixes)
      .filter((fx) => fx.patched)
      .map((fx) => fx.healingId);

    // Persist the report DOCUMENT to object storage; the DB keeps only the reference.
    // Storage is best-effort: a failure here must not fail an otherwise-successful PR.
    let reportUri: string | null = null;
    try {
      const saved = await getReportStore().save(reportKey, reportMarkdown);
      reportUri = saved.uri;
    } catch (storeErr) {
      logger.warn(MOD, 'Failed to persist healing report to object storage (non-critical)', {
        reportKey,
        error: (storeErr as Error).message,
      });
    }

    try {
      const prAutomationId = await logPR(
        {
          job_id: jobId || (singleHealing ? `heal-${committable[0].id}` : `heal-batch-${timestamp}`),
          pr_url: pr.url,
          pr_number: pr.number,
          branch_name: branchName,
          commit_sha: commitSha,
          repo_owner: parsed.owner,
          repo_name: parsed.repo,
          base_branch: baseBranch,
          files_changed: filesToCommit.map((f) => f.filePath),
          healing_count: patchedCount,
          status: 'open',
          report_uri: reportUri ?? undefined,
        },
        companyId,
      );
      await linkHealingActionsToPR(patchedHealingIds, prAutomationId);
    } catch (dbErr) {
      logger.warn(MOD, 'Failed to persist PR linkage to DB (non-critical)', {
        error: (dbErr as Error).message,
      });
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
      // Healing report is platform-owned metadata: the document lives in object
      // storage (referenced by uri/key, also persisted to pr_automations.report_uri)
      // and is intentionally NOT committed to the customer repo. The dashboard fetches
      // the document separately via GET /api/reports/healing/<key>, keeping this
      // response small and enabling cleaner caching / future PDF/HTML rendering.
      report: {
        name: reportName,
        key: reportKey,
        uri: reportUri,
      },
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

/**
 * Is this repo-relative path a LevelUp healing report?
 *
 * Healing reports are execution metadata owned by the platform (persisted to the
 * DB and surfaced in the PR body / dashboard) — they must NEVER be committed to
 * the customer repository. This recogniser is the single source of truth for what
 * counts as a report artifact, used to keep the commit set source-only.
 */
export function isHealingReportPath(p: string): boolean {
  const norm = p.trim().replace(/^\.?\//, '');
  // Primary invariant: the route only ever writes reports under healing-reports/.
  // Secondary (defensive): a root-level file matching the generated naming
  //   healing-report-<id>.md  /  healing-report-batch-<ts>.md  (digit-led, so a
  //   doc like "healing-report-format.md" is NOT misclassified).
  return (
    /^healing-reports\//i.test(norm) ||
    /(^|\/)healing-report-(?:batch-)?\d[^/]*\.md$/i.test(norm)
  );
}

/**
 * The files that actually get COMMITTED to the customer repo: source changes only.
 *
 * Architectural invariant (Option A): the customer repository contains only source
 * code, never an ever-growing healing-reports/ folder. This is a defensive filter —
 * the route already builds its commit list from source fixes only, but routing every
 * write through here guarantees a report can never slip into a commit even if an
 * upstream change re-introduces one. It also removes the previous failure mode where
 * the report's live timestamp polluted `git status`/`git diff` and let a no-op heal
 * push a phantom, fix-less PR.
 */
export function selectCommitFiles<T extends { filePath: string }>(files: T[]): T[] {
  return files.filter((f) => !isHealingReportPath(f.filePath));
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
