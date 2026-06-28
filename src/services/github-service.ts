/**
 * GitHub Service — Centralised Git + GitHub API operations.
 *
 * Wraps clone, branch, commit, push and PR creation so that every
 * feature (Script Gen, Healing, Test-to-Script) uses the same code path.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import axios from 'axios';
import { logger } from '../utils/logger';

const MOD = 'github-service';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
}

export interface CommitFileSpec {
  /** Relative path inside the repo, e.g. "tests/login.spec.ts" */
  filePath: string;
  /** Full file content */
  content: string;
}

export interface CreatePRParams {
  title: string;
  body: string;
  labels?: string[];
}

export interface PRResult {
  prUrl: string;
  prNumber: number;
  branchName: string;
  commitSha: string;
  filesCount: number;
}

/* -------------------------------------------------------------------------- */
/*  Service                                                                   */
/* -------------------------------------------------------------------------- */

export class GitHubService {
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;

  constructor(config: GitHubConfig) {
    // Trim defensively: env vars frequently arrive with a trailing newline or
    // surrounding whitespace (copy-paste, Railway/Heroku UI, `.env` quoting).
    // An untrimmed token produces the SAME opaque git failure as an empty one
    // ("Password authentication is not supported"), so normalise once here.
    this.token = (config.token || '').trim();
    this.owner = config.owner;
    this.repo = config.repo;
  }

  /** True when a usable (non-empty, trimmed) token is present. */
  get hasToken(): boolean {
    return this.token.length > 0;
  }

  /** Token length only — safe to log for diagnosing empty/whitespace tokens. */
  get tokenLength(): number {
    return this.token.length;
  }

  /* ── helpers ──────────────────────────────────────────────── */

  private git(cwd: string, args: string): string {
    return execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 60_000 }).trim();
  }

  private get cloneUrl(): string {
    return `https://x-access-token:${this.token}@github.com/${this.owner}/${this.repo}.git`;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /* ── public API ──────────────────────────────────────────── */

  /**
   * Pre-flight check: confirm the configured token can authenticate AND has
   * push (write) permission to the target repo BEFORE we spend time cloning,
   * patching and committing.
   *
   * This exists because a PUBLIC repo can be cloned with an invalid/expired
   * token (git ignores the bad creds for anonymous read), so the failure only
   * surfaces much later at `git push` with the opaque message
   * "Password authentication is not supported". Failing fast here lets us
   * return a clear, actionable error to the caller instead.
   *
   * Returns `{ ok: true }` on success, or `{ ok: false, reason }` describing
   * exactly what is wrong (missing token, bad token, or no push permission).
   */
  async verifyAccess(): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
    if (!this.token) {
      return { ok: false, status: 400, reason: 'No GitHub token configured.' };
    }
    try {
      const res = await axios.get(
        `https://api.github.com/repos/${this.owner}/${this.repo}`,
        { headers: this.headers, timeout: 15_000 },
      );
      const perms = res.data?.permissions || {};
      if (perms.push === true || perms.admin === true || perms.maintain === true) {
        return { ok: true };
      }
      return {
        ok: false,
        status: 403,
        reason:
          `The configured GitHub token can read ${this.owner}/${this.repo} but does NOT have ` +
          `push permission. Use a token (or GitHub App installation) with write access to this repo.`,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) {
        return {
          ok: false,
          status: 401,
          reason:
            'The configured GitHub token is invalid or expired. Update GITHUB_TOKEN on the ' +
            'backend (or pass a valid githubToken) with push access to the target repo.',
        };
      }
      if (status === 404) {
        return {
          ok: false,
          status: 404,
          reason:
            `Repository ${this.owner}/${this.repo} not found, or the token cannot see it. ` +
            'For a private repo the token needs repo scope / installation access.',
        };
      }
      return {
        ok: false,
        status: status || 500,
        reason: `Could not verify GitHub access: ${err?.message || 'unknown error'}`,
      };
    }
  }

  /**
   * Clone the repo into a temporary directory.
   * Returns the absolute path to the cloned repo.
   */
  async cloneRepo(baseBranch = 'main'): Promise<string> {
    const dir = path.join(os.tmpdir(), `levelup-${this.repo}-${Date.now()}`);
    logger.info(MOD, 'Cloning repo', { owner: this.owner, repo: this.repo, baseBranch });
    execSync(`git clone --depth 1 --branch ${baseBranch} ${this.cloneUrl} ${dir}`, {
      encoding: 'utf-8',
      timeout: 120_000,
    });
    // Configure git identity
    this.git(dir, 'config user.email "bot@leveluptesting.in"');
    this.git(dir, 'config user.name "LevelUp AI Bot"');
    return dir;
  }

  /**
   * Create a new branch from the current HEAD.
   */
  createBranch(repoDir: string, branchName: string): void {
    try {
      this.git(repoDir, `checkout -b ${branchName}`);
    } catch {
      this.git(repoDir, `checkout ${branchName}`);
    }
    logger.info(MOD, 'Branch created', { branchName });
  }

  /**
   * Write files into the repo working tree, stage, and commit.
   * Returns the commit SHA or null if there were no changes.
   */
  commitFiles(repoDir: string, files: CommitFileSpec[], message: string): string | null {
    // Write each file
    for (const f of files) {
      const abs = path.join(repoDir, f.filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content, 'utf-8');
    }

    // Stage all
    this.git(repoDir, 'add -A');

    // Check for changes
    const status = this.git(repoDir, 'status --porcelain');
    if (!status) {
      logger.warn(MOD, 'No changes to commit');
      return null;
    }

    // Commit
    const safeMsg = message.replace(/"/g, '\\"');
    this.git(repoDir, `commit -m "${safeMsg}"`);
    const sha = this.git(repoDir, 'rev-parse HEAD');
    logger.info(MOD, 'Committed', { sha, filesCount: files.length });
    return sha;
  }

  /**
   * Push the current branch to origin.
   */
  pushBranch(repoDir: string, branchName: string): void {
    this.git(repoDir, `push -u origin ${branchName}`);
    logger.info(MOD, 'Pushed', { branchName });
  }

  /**
   * Create a Pull Request via GitHub REST API.
   */
  async createPR(
    branchName: string,
    baseBranch: string,
    params: CreatePRParams,
  ): Promise<{ url: string; number: number } | null> {
    try {
      const res = await axios.post(
        `https://api.github.com/repos/${this.owner}/${this.repo}/pulls`,
        {
          title: params.title,
          head: branchName,
          base: baseBranch,
          body: params.body,
        },
        { headers: this.headers },
      );

      const prNumber: number = res.data.number;
      const prUrl: string = res.data.html_url;

      // Labels (best-effort)
      if (params.labels?.length) {
        try {
          await axios.post(
            `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${prNumber}/labels`,
            { labels: params.labels },
            { headers: this.headers },
          );
        } catch { /* non-critical */ }
      }

      logger.info(MOD, 'PR created', { prUrl, prNumber });
      return { url: prUrl, number: prNumber };
    } catch (error: any) {
      // Handle "PR already exists" gracefully
      if (error?.response?.status === 422) {
        try {
          const existing = await axios.get(
            `https://api.github.com/repos/${this.owner}/${this.repo}/pulls`,
            {
              params: { head: `${this.owner}:${branchName}`, base: baseBranch, state: 'open' },
              headers: this.headers,
            },
          );
          if (existing.data.length > 0) {
            return { url: existing.data[0].html_url, number: existing.data[0].number };
          }
        } catch { /* fall through */ }
      }
      logger.error(MOD, 'PR creation failed', { error: error.message });
      return null;
    }
  }

  /**
   * Full workflow: clone → branch → write files → commit → push → PR.
   * Returns PR details or throws.
   */
  async commitAndCreatePR(opts: {
    files: CommitFileSpec[];
    branchName: string;
    baseBranch?: string;
    commitMessage: string;
    pr: CreatePRParams;
  }): Promise<PRResult> {
    const base = opts.baseBranch || 'main';
    let repoDir: string | null = null;

    try {
      // 1. Clone
      repoDir = await this.cloneRepo(base);

      // 2. Branch
      this.createBranch(repoDir, opts.branchName);

      // 3. Write & commit
      const sha = this.commitFiles(repoDir, opts.files, opts.commitMessage);
      if (!sha) {
        throw new Error('No changes to commit — files may already exist in the repository');
      }

      // 4. Push
      this.pushBranch(repoDir, opts.branchName);

      // 5. Create PR
      const pr = await this.createPR(opts.branchName, base, opts.pr);
      if (!pr) {
        throw new Error('PR creation failed — branch was pushed but PR could not be created');
      }

      return {
        prUrl: pr.url,
        prNumber: pr.number,
        branchName: opts.branchName,
        commitSha: sha,
        filesCount: opts.files.length,
      };
    } finally {
      // Cleanup
      if (repoDir) {
        try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ok */ }
      }
    }
  }

  /* ── static factory ──────────────────────────────────────── */

  /**
   * Parse "owner/repo" from a GitHub URL (https or SSH).
   */
  static parseRepoUrl(url: string): { owner: string; repo: string } | null {
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };

    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) return { owner: sshMatch[1]!, repo: sshMatch[2]! };

    const simpleMatch = url.match(/^([^/]+)\/([^/]+)$/);
    if (simpleMatch) return { owner: simpleMatch[1]!, repo: simpleMatch[2]! };

    return null;
  }
}
