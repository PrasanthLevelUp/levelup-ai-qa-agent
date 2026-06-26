/**
 * GitHub Service — Enterprise-grade GitHub API integration
 *
 * Uses the stored GitHub PAT from notification_configs to perform:
 * - Token validation & user info
 * - Repository listing
 * - Branch creation
 * - File commits via Git tree API
 * - Pull request creation
 *
 * Security:
 * - Never logs token values
 * - All errors sanitized before returning to callers
 * - Rate limit headers tracked and surfaced
 */

import { getNotificationConfigByType } from '../db/postgres';
import { logger } from '../utils/logger';

const MOD = 'github-service';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface GitHubUser {
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
  scopes: string[];
}

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  description: string | null;
  language: string | null;
  updatedAt: string;
  owner: string;
}

export interface GitHubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export interface PRCreationRequest {
  repoOwner: string;
  repoName: string;
  branchName: string;
  title: string;
  body: string;
  files: Array<{
    path: string;
    content: string;
  }>;
  baseBranch?: string;
}

export interface PRCreationResult {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  branchName?: string;
  branchUrl?: string;
  commitSha?: string;
  filesCommitted?: number;
  error?: string;
}

export interface GitHubConnectionStatus {
  connected: boolean;
  user?: GitHubUser;
  rateLimit?: {
    remaining: number;
    limit: number;
    resetsAt: string;
  };
  error?: string;
}

/* ── GitHub Actions types (Execution Mode: GitHub Actions) ───────────── */

export interface GitHubWorkflow {
  /** Numeric workflow id (stable across renames). */
  id: number;
  /** Display name from the YAML `name:` field. */
  name: string;
  /** Repo-relative path, e.g. `.github/workflows/playwright.yml`. */
  path: string;
  /** `active` | `disabled_manually` | `disabled_inactivity` … */
  state: string;
  htmlUrl: string;
}

export interface GitHubWorkflowRun {
  id: number;
  name: string | null;
  /** The commit/dispatch title shown in the Actions UI. */
  displayTitle: string;
  /** `queued` | `in_progress` | `completed` */
  status: string;
  /** `success` | `failure` | `cancelled` | `timed_out` | null (while running) */
  conclusion: string | null;
  /** Trigger event, e.g. `workflow_dispatch`, `push`, `pull_request`. */
  event: string;
  headBranch: string;
  headSha: string;
  htmlUrl: string;
  runNumber: number;
  workflowId: number;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
}

export interface GitHubArtifact {
  id: number;
  name: string;
  sizeInBytes: number;
  expired: boolean;
  /** Authenticated zip download URL (requires the same PAT to fetch). */
  archiveDownloadUrl: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const GITHUB_API = 'https://api.github.com';

async function ghFetch(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: any; headers: Headers }> {
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'LevelUp-AI-QA-Agent/2.0',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

/**
 * Produce an actionable error message for a failed GitHub write call.
 *
 * GitHub returns a terse "Resource not accessible by personal access token"
 * (HTTP 403) when the configured PAT lacks the permission/scope required for
 * the operation. We surface a clear, fix-oriented message so users know exactly
 * what token permission to grant.
 */
function describeGitHubWriteError(
  operation: string,
  status: number,
  apiMessage: string,
): string {
  const base = `Failed to ${operation}`;
  const notAccessible =
    status === 403 ||
    /resource not accessible by (personal access token|integration)/i.test(apiMessage || '');

  if (notAccessible) {
    return (
      `${base}: ${apiMessage || 'Resource not accessible by personal access token'}. ` +
      `Your GitHub token is missing the required permissions. ` +
      `Classic PAT: enable the "repo" scope (and "workflow" scope to push .github/workflows/*.yml files). ` +
      `Fine-grained PAT: grant this repository "Contents: Read and write", "Pull requests: Read and write", ` +
      `and "Workflows: Read and write", and make sure the token has access to this repository. ` +
      `Update the token on the Tools → GitHub page, then retry.`
    );
  }
  return `${base}: ${apiMessage || `GitHub API returned ${status}`}`;
}

function parseRateLimit(headers: Headers) {
  const remaining = parseInt(headers.get('x-ratelimit-remaining') || '', 10);
  const limit = parseInt(headers.get('x-ratelimit-limit') || '', 10);
  const resetEpoch = parseInt(headers.get('x-ratelimit-reset') || '', 10);
  if (isNaN(remaining) || isNaN(limit)) return undefined;
  return {
    remaining,
    limit,
    resetsAt: isNaN(resetEpoch) ? '' : new Date(resetEpoch * 1000).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  GitHub Service                                                     */
/* ------------------------------------------------------------------ */

export class GitHubService {
  /**
   * Retrieve the stored GitHub PAT for a company.
   * Returns null if not configured.
   */
  async getToken(companyId?: number, userId?: number): Promise<string | null> {
    try {
      const config = await getNotificationConfigByType('github', companyId, userId);
      if (!config || !config.config?.token) return null;
      return config.config.token as string;
    } catch (err) {
      logger.error(MOD, 'Failed to retrieve GitHub token', {
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Check if GitHub is connected and the token is valid.
   */
  async getConnectionStatus(companyId?: number, userId?: number): Promise<GitHubConnectionStatus> {
    const token = await this.getToken(companyId, userId);
    if (!token) {
      return { connected: false, error: 'GitHub not configured. Connect via Tools page.' };
    }

    try {
      const { ok, status, data, headers } = await ghFetch('/user', token);
      const rateLimit = parseRateLimit(headers);

      if (!ok) {
        if (status === 401) {
          return { connected: false, error: 'GitHub token is invalid or expired. Reconnect via Tools page.' };
        }
        return { connected: false, error: `GitHub API returned ${status}`, rateLimit };
      }

      // Fetch token scopes from response headers
      const scopeHeader = headers.get('x-oauth-scopes') || '';
      const scopes = scopeHeader.split(',').map((s: string) => s.trim()).filter(Boolean);

      return {
        connected: true,
        user: {
          login: data.login,
          name: data.name,
          avatarUrl: data.avatar_url,
          htmlUrl: data.html_url,
          scopes,
        },
        rateLimit,
      };
    } catch (err) {
      logger.error(MOD, 'GitHub connection check failed', {
        error: (err as Error).message,
      });
      return { connected: false, error: 'Failed to reach GitHub API' };
    }
  }

  /**
   * List repositories the authenticated user has access to.
   */
  async listRepos(
    companyId?: number,
    options?: { page?: number; perPage?: number; sort?: string },
    userId?: number,
  ): Promise<{ repos: GitHubRepo[]; hasMore: boolean; error?: string }> {
    const token = await this.getToken(companyId, userId);
    if (!token) return { repos: [], hasMore: false, error: 'GitHub not connected' };

    const page = options?.page ?? 1;
    const perPage = Math.min(options?.perPage ?? 30, 100);
    const sort = options?.sort ?? 'pushed';

    try {
      const { ok, data } = await ghFetch(
        `/user/repos?per_page=${perPage}&page=${page}&sort=${sort}&affiliation=owner,collaborator,organization_member`,
        token,
      );

      if (!ok) {
        return { repos: [], hasMore: false, error: `GitHub API error: ${data.message || 'Unknown'}` };
      }

      const repos: GitHubRepo[] = (data as any[]).map((r: any) => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        htmlUrl: r.html_url,
        description: r.description,
        language: r.language,
        updatedAt: r.updated_at,
        owner: r.owner?.login || '',
      }));

      return { repos, hasMore: repos.length === perPage };
    } catch (err) {
      logger.error(MOD, 'Failed to list repos', { error: (err as Error).message });
      return { repos: [], hasMore: false, error: 'Failed to fetch repositories' };
    }
  }

  /**
   * List branches for a repository.
   */
  async listBranches(
    repoOwner: string,
    repoName: string,
    companyId?: number,
    userId?: number,
  ): Promise<{ branches: GitHubBranch[]; error?: string }> {
    const token = await this.getToken(companyId, userId);
    if (!token) return { branches: [], error: 'GitHub not connected' };

    try {
      const { ok, data } = await ghFetch(
        `/repos/${repoOwner}/${repoName}/branches?per_page=100`,
        token,
      );
      if (!ok) {
        return { branches: [], error: data.message || 'Failed to list branches' };
      }
      const branches: GitHubBranch[] = (data as any[]).map((b: any) => ({
        name: b.name,
        sha: b.commit.sha,
        protected: b.protected,
      }));
      return { branches };
    } catch (err) {
      return { branches: [], error: (err as Error).message };
    }
  }

  /**
   * Create a pull request with files committed to a new branch.
   *
   * Flow:
   * 1. Get default branch SHA
   * 2. Create Git blobs for each file
   * 3. Create a Git tree
   * 4. Create a Git commit
   * 5. Create the branch reference
   * 6. Create the pull request
   */
  async createPullRequest(
    request: PRCreationRequest,
    companyId?: number,
    userId?: number,
  ): Promise<PRCreationResult> {
    const token = await this.getToken(companyId, userId);
    if (!token) {
      return { success: false, error: 'GitHub not connected. Connect via Tools page.' };
    }

    const { repoOwner, repoName, branchName, title, body, files, baseBranch } = request;

    // Validate inputs
    if (!repoOwner || !repoName || !branchName || !title || !files?.length) {
      return { success: false, error: 'Missing required fields: repoOwner, repoName, branchName, title, files' };
    }

    // Validate branch name (no spaces, special chars)
    if (!/^[\w\-./]+$/.test(branchName)) {
      return { success: false, error: 'Invalid branch name. Use only alphanumeric, dash, dot, slash, underscore.' };
    }

    // Sanitize file paths
    for (const f of files) {
      if (f.path.includes('..') || f.path.startsWith('/')) {
        return { success: false, error: `Invalid file path: ${f.path}` };
      }
    }

    const repo = `${repoOwner}/${repoName}`;
    logger.info(MOD, 'Creating PR', { repo, branchName, fileCount: files.length });

    try {
      // Step 1: Get the base branch SHA
      const base = baseBranch || 'main';
      const refRes = await ghFetch(`/repos/${repo}/git/ref/heads/${base}`, token);
      if (!refRes.ok) {
        // Try 'master' if 'main' fails
        if (base === 'main') {
          const masterRes = await ghFetch(`/repos/${repo}/git/ref/heads/master`, token);
          if (!masterRes.ok) {
            return { success: false, error: `Could not find base branch (tried main and master). ${masterRes.data.message || ''}` };
          }
          return this._createPRFromSha(token, repo, masterRes.data.object.sha, 'master', branchName, title, body, files);
        }
        return { success: false, error: `Base branch '${base}' not found: ${refRes.data.message || ''}` };
      }

      return this._createPRFromSha(token, repo, refRes.data.object.sha, base, branchName, title, body, files);
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(MOD, 'PR creation failed', { repo, error: msg });
      return { success: false, error: `PR creation failed: ${msg}` };
    }
  }

  /**
   * Internal: Create PR from a known base SHA.
   */
  private async _createPRFromSha(
    token: string,
    repo: string,
    baseSha: string,
    baseBranch: string,
    branchName: string,
    title: string,
    body: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<PRCreationResult> {
    // Step 2: Create blobs for each file
    const tree: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    for (const file of files) {
      const blobRes = await ghFetch(`/repos/${repo}/git/blobs`, token, {
        method: 'POST',
        body: JSON.stringify({
          content: file.content,
          encoding: 'utf-8',
        }),
      });
      if (!blobRes.ok) {
        return {
          success: false,
          error: describeGitHubWriteError(`create blob for ${file.path}`, blobRes.status, blobRes.data.message),
        };
      }
      tree.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blobRes.data.sha,
      });
    }

    // Step 3: Create tree
    const treeRes = await ghFetch(`/repos/${repo}/git/trees`, token, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseSha,
        tree,
      }),
    });
    if (!treeRes.ok) {
      return { success: false, error: describeGitHubWriteError('create git tree', treeRes.status, treeRes.data.message) };
    }

    // Step 4: Create commit
    const commitRes = await ghFetch(`/repos/${repo}/git/commits`, token, {
      method: 'POST',
      body: JSON.stringify({
        message: title,
        tree: treeRes.data.sha,
        parents: [baseSha],
      }),
    });
    if (!commitRes.ok) {
      return { success: false, error: describeGitHubWriteError('create commit', commitRes.status, commitRes.data.message) };
    }

    // Step 5: Create branch reference
    const refCreateRes = await ghFetch(`/repos/${repo}/git/refs`, token, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: commitRes.data.sha,
      }),
    });
    if (!refCreateRes.ok) {
      // If branch already exists, try to update it
      if (refCreateRes.status === 422) {
        const refUpdateRes = await ghFetch(`/repos/${repo}/git/refs/heads/${branchName}`, token, {
          method: 'PATCH',
          body: JSON.stringify({ sha: commitRes.data.sha, force: true }),
        });
        if (!refUpdateRes.ok) {
          return { success: false, error: `Branch '${branchName}' exists and could not be updated` };
        }
      } else {
        return { success: false, error: describeGitHubWriteError('create branch', refCreateRes.status, refCreateRes.data.message) };
      }
    }

    // Step 6: Create pull request
    const prRes = await ghFetch(`/repos/${repo}/pulls`, token, {
      method: 'POST',
      body: JSON.stringify({
        title,
        body,
        head: branchName,
        base: baseBranch,
      }),
    });
    if (!prRes.ok) {
      // PR might already exist for this branch
      if (prRes.status === 422 && prRes.data.errors?.[0]?.message?.includes('pull request already exists')) {
        return {
          success: true,
          branchName,
          branchUrl: `https://github.com/${repo}/tree/${branchName}`,
          commitSha: commitRes.data.sha,
          filesCommitted: files.length,
          error: 'Files committed to branch, but a PR already exists for this branch.',
        };
      }
      return {
        success: false,
        error: describeGitHubWriteError('create PR', prRes.status, prRes.data.message || prRes.data.errors?.[0]?.message),
      };
    }

    logger.info(MOD, 'PR created successfully', {
      repo,
      pr: prRes.data.number,
      url: prRes.data.html_url,
    });

    return {
      success: true,
      prUrl: prRes.data.html_url,
      prNumber: prRes.data.number,
      branchName,
      branchUrl: `https://github.com/${repo}/tree/${branchName}`,
      commitSha: commitRes.data.sha,
      filesCommitted: files.length,
    };
  }

  /* ================================================================== */
  /*  GitHub Actions — Execution Mode 2                                  */
  /*                                                                     */
  /*  These let LevelUp AI plug into a customer's EXISTING CI: list the  */
  /*  workflows already in `.github/workflows`, trigger one via the      */
  /*  workflow_dispatch API, track the resulting run, and surface its    */
  /*  artifacts — WITHOUT recreating any CI logic.                       */
  /* ================================================================== */

  /** Map a raw GitHub Actions run object to our typed shape. */
  private mapRun(r: any): GitHubWorkflowRun {
    return {
      id: r.id,
      name: r.name ?? null,
      displayTitle: r.display_title ?? r.name ?? '',
      status: r.status,
      conclusion: r.conclusion ?? null,
      event: r.event,
      headBranch: r.head_branch,
      headSha: r.head_sha,
      htmlUrl: r.html_url,
      runNumber: r.run_number,
      workflowId: r.workflow_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      runStartedAt: r.run_started_at ?? null,
    };
  }

  /**
   * List the workflows defined in `.github/workflows` for a repository.
   * Returns only the fields the dashboard needs to render a picker.
   */
  async listWorkflows(
    owner: string,
    repo: string,
    companyId?: number,
    userId?: number,
  ): Promise<{ workflows: GitHubWorkflow[]; error?: string }> {
    const token = await this.getToken(companyId, userId);
    if (!token) return { workflows: [], error: 'GitHub not connected. Connect via Tools page.' };

    try {
      const { ok, status, data } = await ghFetch(
        `/repos/${owner}/${repo}/actions/workflows?per_page=100`,
        token,
      );
      if (!ok) {
        if (status === 404) {
          return { workflows: [], error: `Repository ${owner}/${repo} not found or no Actions access.` };
        }
        return { workflows: [], error: data?.message || `GitHub API returned ${status}` };
      }
      const workflows: GitHubWorkflow[] = (data.workflows || []).map((w: any) => ({
        id: w.id,
        name: w.name,
        path: w.path,
        state: w.state,
        htmlUrl: w.html_url,
      }));
      return { workflows };
    } catch (err) {
      logger.error(MOD, 'Failed to list workflows', { error: (err as Error).message });
      return { workflows: [], error: 'Failed to list workflows' };
    }
  }

  /**
   * Trigger a workflow via the `workflow_dispatch` API.
   *
   * `workflowId` may be the numeric id OR the workflow file name
   * (e.g. `playwright.yml`). The workflow MUST declare an `on: workflow_dispatch`
   * trigger, otherwise GitHub returns 422 ("Workflow does not have
   * 'workflow_dispatch' trigger").
   *
   * The dispatch endpoint returns 204 with NO body and does NOT return the run
   * it created. Callers that need the run should follow up with
   * `findRunForDispatch()`.
   */
  async dispatchWorkflow(
    owner: string,
    repo: string,
    workflowId: string | number,
    ref: string,
    inputs?: Record<string, string>,
    companyId?: number,
    userId?: number,
  ): Promise<{ success: boolean; error?: string }> {
    const token = await this.getToken(companyId, userId);
    if (!token) return { success: false, error: 'GitHub not connected. Connect via Tools page.' };

    if (!ref || !ref.trim()) return { success: false, error: 'A git ref (branch/tag) is required to dispatch a workflow.' };

    try {
      const { ok, status, data } = await ghFetch(
        `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(String(workflowId))}/dispatches`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ ref, ...(inputs && Object.keys(inputs).length ? { inputs } : {}) }),
        },
      );
      if (!ok) {
        if (status === 422) {
          return {
            success: false,
            error:
              data?.message ||
              `Workflow cannot be dispatched. Ensure it declares "on: workflow_dispatch" and that "${ref}" is a valid branch/tag.`,
          };
        }
        if (status === 403) {
          return { success: false, error: describeGitHubWriteError('dispatch workflow', status, data?.message) };
        }
        return { success: false, error: data?.message || `GitHub API returned ${status}` };
      }
      return { success: true };
    } catch (err) {
      logger.error(MOD, 'Failed to dispatch workflow', { error: (err as Error).message });
      return { success: false, error: 'Failed to dispatch workflow' };
    }
  }

  /**
   * List recent runs for a repository, optionally scoped to a single workflow.
   * Supports the filters needed to correlate a dispatch back to its run.
   */
  async listWorkflowRuns(
    owner: string,
    repo: string,
    opts?: {
      workflowId?: string | number;
      branch?: string;
      event?: string;
      perPage?: number;
      created?: string; // e.g. ">=2026-06-26T12:00:00Z"
    },
    companyId?: number,
    userId?: number,
  ): Promise<{ runs: GitHubWorkflowRun[]; error?: string }> {
    const token = await this.getToken(companyId, userId);
    if (!token) return { runs: [], error: 'GitHub not connected. Connect via Tools page.' };

    const params = new URLSearchParams();
    params.set('per_page', String(Math.min(opts?.perPage ?? 20, 100)));
    if (opts?.branch) params.set('branch', opts.branch);
    if (opts?.event) params.set('event', opts.event);
    if (opts?.created) params.set('created', opts.created);

    const base = opts?.workflowId
      ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(String(opts.workflowId))}/runs`
      : `/repos/${owner}/${repo}/actions/runs`;

    try {
      const { ok, status, data } = await ghFetch(`${base}?${params.toString()}`, token);
      if (!ok) return { runs: [], error: data?.message || `GitHub API returned ${status}` };
      const runs: GitHubWorkflowRun[] = (data.workflow_runs || []).map((r: any) => this.mapRun(r));
      return { runs };
    } catch (err) {
      logger.error(MOD, 'Failed to list workflow runs', { error: (err as Error).message });
      return { runs: [], error: 'Failed to list workflow runs' };
    }
  }

  /**
   * Correlate a just-issued `workflow_dispatch` to the run it created.
   *
   * GitHub does not return the run id from the dispatch call, so we poll the
   * runs list (scoped to the workflow, branch, dispatch event, and created
   * since just before we dispatched) until the run appears.
   */
  async findRunForDispatch(
    owner: string,
    repo: string,
    workflowId: string | number,
    ref: string,
    sinceIso: string,
    companyId?: number,
    userId?: number,
    opts?: { attempts?: number; intervalMs?: number },
  ): Promise<{ run?: GitHubWorkflowRun; error?: string }> {
    const attempts = opts?.attempts ?? 8;
    const intervalMs = opts?.intervalMs ?? 2000;

    for (let i = 0; i < attempts; i++) {
      const { runs, error } = await this.listWorkflowRuns(
        owner, repo,
        { workflowId, branch: ref, event: 'workflow_dispatch', created: `>=${sinceIso}`, perPage: 10 },
        companyId, userId,
      );
      if (error) return { error };
      if (runs.length > 0) {
        // Most recent first (GitHub returns newest first); pick the newest.
        return { run: runs[0] };
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { error: 'Workflow was dispatched but the run did not appear in time. Check the repository Actions tab.' };
  }

  /** Fetch a single workflow run by id (used for status polling). */
  async getWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
    companyId?: number,
    userId?: number,
  ): Promise<{ run?: GitHubWorkflowRun; error?: string }> {
    const token = await this.getToken(companyId, userId);
    if (!token) return { error: 'GitHub not connected. Connect via Tools page.' };

    try {
      const { ok, status, data } = await ghFetch(`/repos/${owner}/${repo}/actions/runs/${runId}`, token);
      if (!ok) {
        if (status === 404) return { error: `Run ${runId} not found.` };
        return { error: data?.message || `GitHub API returned ${status}` };
      }
      return { run: this.mapRun(data) };
    } catch (err) {
      logger.error(MOD, 'Failed to get workflow run', { error: (err as Error).message });
      return { error: 'Failed to get workflow run' };
    }
  }

  /** List the artifacts produced by a workflow run (e.g. the Playwright report). */
  async listRunArtifacts(
    owner: string,
    repo: string,
    runId: number,
    companyId?: number,
    userId?: number,
  ): Promise<{ artifacts: GitHubArtifact[]; error?: string }> {
    const token = await this.getToken(companyId, userId);
    if (!token) return { artifacts: [], error: 'GitHub not connected. Connect via Tools page.' };

    try {
      const { ok, status, data } = await ghFetch(
        `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
        token,
      );
      if (!ok) return { artifacts: [], error: data?.message || `GitHub API returned ${status}` };
      const artifacts: GitHubArtifact[] = (data.artifacts || []).map((a: any) => ({
        id: a.id,
        name: a.name,
        sizeInBytes: a.size_in_bytes,
        expired: a.expired,
        archiveDownloadUrl: a.archive_download_url,
        createdAt: a.created_at,
      }));
      return { artifacts };
    } catch (err) {
      logger.error(MOD, 'Failed to list run artifacts', { error: (err as Error).message });
      return { artifacts: [], error: 'Failed to list run artifacts' };
    }
  }

  /**
   * Download a single artifact's zip bytes.
   *
   * GitHub's `archive_download_url` responds with a 302 redirect to a short-lived,
   * pre-signed blob-storage URL. Per the fetch spec, the `Authorization` header is
   * stripped on the cross-origin redirect hop — which is exactly what we want:
   * GitHub authorizes the redirect, and the signed blob URL needs no auth. So a
   * plain `fetch` that follows redirects (the default) returns the zip bytes.
   *
   * Returns the raw zip as a Buffer; the ingestion layer unzips and locates the
   * Playwright results within it.
   */
  async downloadArtifactZip(
    artifact: { id: number; archiveDownloadUrl?: string },
    owner: string,
    repo: string,
    companyId?: number,
    userId?: number,
  ): Promise<{ ok: boolean; buffer?: Buffer; error?: string }> {
    const token = await this.getToken(companyId, userId);
    if (!token) return { ok: false, error: 'GitHub not connected. Connect via Tools page.' };

    // Prefer the API zip endpoint (stable) over a possibly-stale archive URL.
    const url = artifact.archiveDownloadUrl
      || `${GITHUB_API}/repos/${owner}/${repo}/actions/artifacts/${artifact.id}/zip`;

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'LevelUp-AI-QA-Agent/2.0',
        },
        // Follow the redirect to blob storage (default); Authorization is dropped
        // cross-origin per spec, so the signed URL serves the bytes.
        redirect: 'follow',
      });
      if (!res.ok) {
        return { ok: false, error: `Artifact download failed: GitHub API returned ${res.status}` };
      }
      const arrayBuf = await res.arrayBuffer();
      return { ok: true, buffer: Buffer.from(arrayBuf) };
    } catch (err) {
      logger.error(MOD, 'Failed to download artifact zip', { error: (err as Error).message, artifactId: artifact.id });
      return { ok: false, error: 'Failed to download artifact zip' };
    }
  }
}

/* ------------------------------------------------------------------ */
/*  URL helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Parse a GitHub repository URL into { owner, repo }.
 * Accepts forms like:
 *   - https://github.com/Owner/Repo.git
 *   - github.com/Owner/Repo
 *   - git@github.com:Owner/Repo.git
 * Returns null if it cannot be parsed as a GitHub repo.
 */
export function parseGitHubRepoUrl(url: string): { owner: string; repo: string } | null {
  if (!url) return null;
  const cleaned = url.trim();
  // SSH form: git@github.com:Owner/Repo.git
  const sshMatch = cleaned.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  // HTTP(S) or bare host form
  const httpMatch = cleaned
    .replace(/^https?:\/\//i, '')
    .match(/^(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (httpMatch) return { owner: httpMatch[1], repo: httpMatch[2] };
  return null;
}
