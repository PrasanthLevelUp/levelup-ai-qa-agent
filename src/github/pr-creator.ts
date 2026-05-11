/**
 * PR Creator — Git commit/push + GitHub Pull Request creation.
 */

import { execSync } from 'child_process';
import axios from 'axios';
import { logger } from '../utils/logger';

const MOD = 'pr-creator';

export interface CommitSpec {
  files: string[];
  message: string;
}

function git(repoPath: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repoPath, encoding: 'utf-8' }).trim();
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

export function pushBranch(repoPath: string, branch: string): void {
  git(repoPath, `push -u origin ${branch}`);
  logger.info(MOD, 'Branch pushed', { branch });
}

export async function createPR(params: {
  githubToken: string;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
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
      {
        headers: {
          Authorization: `Bearer ${params.githubToken}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );

    return { url: res.data.html_url as string, number: res.data.number as number };
  } catch (error) {
    logger.error(MOD, 'Failed to create PR', {
      error: (error as Error).message,
    });
    return null;
  }
}
