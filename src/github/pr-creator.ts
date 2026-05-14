/**
 * PR Creator — Git operations + GitHub Pull Request creation.
 * Handles branch creation, commit, push, and PR with rich body.
 */

import { execSync } from 'child_process';
import axios from 'axios';
import { logger } from '../utils/logger';

const MOD = 'pr-creator';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface CommitSpec {
  files: string[];
  message: string;
}

export interface HealingSummary {
  testName: string;
  failedLocator: string;
  healedLocator: string;
  strategy: string;
  confidence: number;
  filePath: string;
}

export interface PRResult {
  prUrl: string;
  prNumber: number;
  branchName: string;
  commitSha: string;
  filesChanged: string[];
  healingCount: number;
}

/* -------------------------------------------------------------------------- */
/*  Git helpers                                                               */
/* -------------------------------------------------------------------------- */

function git(repoPath: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repoPath, encoding: 'utf-8', timeout: 30_000 }).trim();
}

export function createBranch(repoPath: string, branchName: string, baseBranch: string): void {
  git(repoPath, `checkout ${baseBranch}`);
  git(repoPath, `pull origin ${baseBranch}`);
  try {
    git(repoPath, `checkout -b ${branchName}`);
  } catch {
    git(repoPath, `checkout ${branchName}`);
  }
  logger.info(MOD, 'Branch ready', { branchName, baseBranch });
}

export function hasChanges(repoPath: string): boolean {
  return git(repoPath, 'status --porcelain').length > 0;
}

export function getChangedFiles(repoPath: string): string[] {
  const output = git(repoPath, 'diff --name-only');
  return output ? output.split('\n').filter(Boolean) : [];
}

export function getDiff(repoPath: string): string {
  try {
    return git(repoPath, 'diff');
  } catch {
    return '';
  }
}

export function commitFiles(repoPath: string, spec: CommitSpec): string | null {
  for (const file of spec.files) {
    git(repoPath, `add "${file}"`);
  }

  if (!hasChanges(repoPath)) {
    logger.warn(MOD, 'No staged changes to commit', { message: spec.message });
    return null;
  }

  git(repoPath, `commit -m "${spec.message.replace(/"/g, '\\"')}"`);
  const sha = git(repoPath, 'rev-parse HEAD');
  logger.info(MOD, 'Commit created', { sha, message: spec.message });
  return sha;
}

export function commitAll(repoPath: string, message: string): string | null {
  git(repoPath, 'add -A');
  if (!hasChanges(repoPath)) {
    logger.warn(MOD, 'No changes to commit');
    return null;
  }
  git(repoPath, `commit -m "${message.replace(/"/g, '\\"')}"`);
  const sha = git(repoPath, 'rev-parse HEAD');
  logger.info(MOD, 'All changes committed', { sha });
  return sha;
}

export function pushBranch(repoPath: string, branch: string): void {
  git(repoPath, `push -u origin ${branch}`);
  logger.info(MOD, 'Branch pushed', { branch });
}

/* -------------------------------------------------------------------------- */
/*  GitHub API                                                                */
/* -------------------------------------------------------------------------- */

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** Parse "owner/repo" from a GitHub URL */
export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  // Supports https://github.com/owner/repo.git, git@github.com:owner/repo.git, owner/repo
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };

  const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1]!, repo: sshMatch[2]! };

  const simpleMatch = url.match(/^([^/]+)\/([^/]+)$/);
  if (simpleMatch) return { owner: simpleMatch[1]!, repo: simpleMatch[2]! };

  return null;
}

export async function createPR(params: {
  githubToken: string;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  labels?: string[];
}): Promise<{ url: string; number: number } | null> {
  try {
    const res = await axios.post(
      `https://api.github.com/repos/${params.owner}/${params.repo}/pulls`,
      {
        title: params.title,
        head: params.head,
        base: params.base,
        body: params.body,
      },
      { headers: githubHeaders(params.githubToken) },
    );

    const prNumber = res.data.number as number;
    const prUrl = res.data.html_url as string;

    // Add labels if specified
    if (params.labels?.length) {
      try {
        await axios.post(
          `https://api.github.com/repos/${params.owner}/${params.repo}/issues/${prNumber}/labels`,
          { labels: params.labels },
          { headers: githubHeaders(params.githubToken) },
        );
      } catch (labelErr) {
        logger.warn(MOD, 'Failed to add labels (non-critical)', {
          error: (labelErr as Error).message,
        });
      }
    }

    logger.info(MOD, 'PR created', { prUrl, prNumber });
    return { url: prUrl, number: prNumber };
  } catch (error: any) {
    // If PR already exists, find it
    if (error?.response?.status === 422 && error?.response?.data?.errors?.[0]?.message?.includes('already exists')) {
      logger.info(MOD, 'PR already exists, looking up existing PR');
      try {
        const existing = await axios.get(
          `https://api.github.com/repos/${params.owner}/${params.repo}/pulls`,
          {
            params: { head: `${params.owner}:${params.head}`, base: params.base, state: 'open' },
            headers: githubHeaders(params.githubToken),
          },
        );
        if (existing.data.length > 0) {
          return { url: existing.data[0].html_url, number: existing.data[0].number };
        }
      } catch {
        // fall through
      }
    }
    logger.error(MOD, 'Failed to create PR', { error: (error as Error).message });
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  PR Body Builder                                                           */
/* -------------------------------------------------------------------------- */

export function buildPRBody(params: {
  jobId: string;
  healings: HealingSummary[];
  totalTests: number;
  failedTests: number;
  healedTests: number;
  diff?: string;
}): string {
  const { jobId, healings, totalTests, failedTests, healedTests } = params;

  const healingRows = healings.map((h) => {
    const conf = (h.confidence * 100).toFixed(0);
    return `| \`${h.testName}\` | \`${truncate(h.failedLocator, 40)}\` | \`${truncate(h.healedLocator, 40)}\` | ${h.strategy} | ${conf}% |`;
  }).join('\n');

  const strategies = [...new Set(healings.map((h) => h.strategy))];

  return `## 🔧 LevelUp AI — Self-Healing Test Fix

> Automated PR created by [LevelUp AI QA](https://app.leveluptesting.in) self-healing engine.

### 📊 Summary

| Metric | Value |
|--------|-------|
| **Job ID** | \`${jobId}\` |
| **Total Tests** | ${totalTests} |
| **Failed** | ${failedTests} |
| **Healed** | ${healedTests} |
| **Strategies Used** | ${strategies.join(', ')} |

### 🩹 Healing Details

| Test | Failed Locator | Healed Locator | Strategy | Confidence |
|------|---------------|----------------|----------|------------|
${healingRows}

### ✅ Validation

- All healed locators have been **validated** by re-running the affected tests
- Each fix passed the automated test suite before being included in this PR
- Confidence scores reflect the engine's certainty in each fix

### 🤖 How It Works

1. **Detect** — Playwright tests run and failures are captured
2. **Analyze** — AI analyzes the DOM, error context, and historical patterns
3. **Heal** — A new locator is generated using rule-based, pattern, or AI strategies
4. **Validate** — The healed test is re-run to confirm the fix works
5. **PR** — This automated PR is created for human review

---

<details>
<summary>🔍 View detailed diff</summary>

\`\`\`diff
${params.diff ? truncate(params.diff, 3000) : 'Diff not available'}
\`\`\`

</details>

---

> ⚠️ **Review recommended** — While all changes have been validated, please review before merging.
>
> 🏷️ *Generated by LevelUp AI QA Engine • Job: ${jobId}*
`;
}

/* -------------------------------------------------------------------------- */
/*  Orchestrator — Full PR creation flow                                      */
/* -------------------------------------------------------------------------- */

export async function createHealingPR(params: {
  repoPath: string;
  repoUrl: string;
  branch: string;
  jobId: string;
  healings: HealingSummary[];
  totalTests: number;
  failedTests: number;
  healedTests: number;
  githubToken: string;
}): Promise<PRResult | null> {
  const { repoPath, repoUrl, branch, jobId, healings, githubToken } = params;

  // 1. Parse owner/repo from URL
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) {
    logger.error(MOD, 'Cannot parse repo URL for PR', { repoUrl });
    return null;
  }

  // 2. Check for actual changes
  if (!hasChanges(repoPath)) {
    logger.info(MOD, 'No changes to create PR for');
    return null;
  }

  // 3. Capture diff before committing
  const diff = getDiff(repoPath);
  const changedFiles = getChangedFiles(repoPath);

  // 4. Create healing branch
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const branchName = `levelup/heal-${jobId.slice(0, 8)}-${timestamp}`;

  try {
    createBranch(repoPath, branchName, branch);
  } catch (branchErr) {
    logger.error(MOD, 'Failed to create branch', { error: (branchErr as Error).message });
    return null;
  }

  // 5. Stage and commit all healed files
  const commitMsg = `fix: auto-heal ${healings.length} broken locator(s) [LevelUp AI]\n\nJob: ${jobId}\nHealed: ${healings.map(h => h.testName).join(', ')}`;
  const commitSha = commitAll(repoPath, commitMsg);
  if (!commitSha) {
    logger.warn(MOD, 'No changes to commit after staging');
    // Switch back to original branch
    try { git(repoPath, `checkout ${branch}`); } catch { /* ignore */ }
    return null;
  }

  // 6. Push branch
  try {
    pushBranch(repoPath, branchName);
  } catch (pushErr) {
    logger.error(MOD, 'Failed to push branch', { error: (pushErr as Error).message });
    try { git(repoPath, `checkout ${branch}`); } catch { /* ignore */ }
    return null;
  }

  // 7. Create PR via GitHub API
  const prBody = buildPRBody({
    jobId,
    healings,
    totalTests: params.totalTests,
    failedTests: params.failedTests,
    healedTests: params.healedTests,
    diff,
  });

  const pr = await createPR({
    githubToken,
    owner: parsed.owner,
    repo: parsed.repo,
    head: branchName,
    base: branch,
    title: `🔧 [LevelUp AI] Auto-heal ${healings.length} broken test locator(s)`,
    body: prBody,
    labels: ['levelup-ai', 'auto-heal', 'test-fix'],
  });

  // 8. Switch back to original branch
  try { git(repoPath, `checkout ${branch}`); } catch { /* ignore */ }

  if (!pr) {
    logger.error(MOD, 'PR creation failed');
    return null;
  }

  logger.info(MOD, 'Healing PR created successfully', {
    prUrl: pr.url,
    prNumber: pr.number,
    branchName,
    filesChanged: changedFiles.length,
  });

  return {
    prUrl: pr.url,
    prNumber: pr.number,
    branchName,
    commitSha: commitSha,
    filesChanged: changedFiles,
    healingCount: healings.length,
  };
}

/* -------------------------------------------------------------------------- */
/*  Utilities                                                                 */
/* -------------------------------------------------------------------------- */

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
