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
        return { success: false, error: `Failed to create blob for ${file.path}: ${blobRes.data.message || ''}` };
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
      return { success: false, error: `Failed to create git tree: ${treeRes.data.message || ''}` };
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
      return { success: false, error: `Failed to create commit: ${commitRes.data.message || ''}` };
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
        return { success: false, error: `Failed to create branch: ${refCreateRes.data.message || ''}` };
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
      return { success: false, error: `Failed to create PR: ${prRes.data.message || prRes.data.errors?.[0]?.message || ''}` };
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
}
