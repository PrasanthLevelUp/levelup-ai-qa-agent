/**
 * RepoScanService — shared repository scan + persist logic (Phase 2)
 * ------------------------------------------------------------------
 * Extracted from the POST /api/repo-intelligence/scan route so the SAME logic
 * can run either synchronously (the existing HTTP path) or asynchronously
 * inside a BullMQ background worker. Keeping a single implementation guarantees
 * the worker and the route stay behaviourally identical.
 *
 * Responsibilities:
 *   1. Resolve a repo source (local path or remote URL → shallow clone to temp)
 *   2. Run the RepositoryContextEngine scan
 *   3. Persist the profile (repository_contexts) and code chunks (code_chunks)
 *   4. Optionally generate embeddings for the chunks (Phase 2 RAG), gated
 *   5. Always clean up any temp clone
 *
 * Nothing here changes default behaviour: embeddings only run when the
 * VECTOR_SEARCH flag + pgvector + an embedding key are all present.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { RepositoryContextEngine } from '../context/repository-context-engine';
import { saveRepositoryContext, saveCodeChunks } from '../db/postgres';
import { createCodeChunkEmbedder, type EmbedProgress } from './code-chunk-embedder';
import { FEATURE_FLAGS } from '../config/features';
import { logger } from '../utils/logger';

const MOD = 'repo-scan-service';

/** Check if a string looks like a remote URL (GitHub, GitLab, etc.) */
export function isRemoteUrl(str: string): boolean {
  return /^https?:\/\//.test(str) || /^git@/.test(str);
}

/**
 * Clone a remote repository to a temporary directory (shallow, single branch).
 * Returns the path to the cloned directory. Supports GitHub auth via
 * GITHUB_TOKEN / GH_TOKEN env vars for private repos.
 */
export function cloneToTemp(repoUrl: string, branch: string = 'main'): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `repo_scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });

  let cloneUrl = repoUrl;
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (ghToken && repoUrl.includes('github.com') && repoUrl.startsWith('https://')) {
    cloneUrl = repoUrl.replace('https://github.com', `https://${ghToken}@github.com`);
  }
  if (!cloneUrl.endsWith('.git')) cloneUrl += '.git';

  logger.info(MOD, `Cloning ${repoUrl} (branch: ${branch}) to temp dir...`);
  try {
    execSync(`git clone --depth 1 --branch "${branch}" "${cloneUrl}" "${tmpDir}"`, {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: 'pipe',
    });
  } catch (err: any) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const msg = err.stderr || err.message || String(err);
    if (msg.includes('Authentication') || msg.includes('could not read Username')) {
      throw new Error(
        `GitHub authentication failed for ${repoUrl}. ` +
          `To scan private repos, set GITHUB_TOKEN environment variable.`,
      );
    }
    if (msg.includes('not found') || msg.includes('does not exist')) {
      throw new Error(`Repository not found: ${repoUrl}. Check the URL and branch name.`);
    }
    if (msg.includes('Remote branch') && msg.includes('not found')) {
      throw new Error(`Branch "${branch}" not found in ${repoUrl}.`);
    }
    throw new Error(`Failed to clone repository: ${msg.slice(0, 500)}`);
  }

  logger.info(MOD, `Clone complete → ${tmpDir}`);
  return tmpDir;
}

/** Safely remove a temp directory (only under the OS temp dir). */
export function cleanupTemp(dirPath: string): void {
  try {
    if (dirPath.startsWith(os.tmpdir()) && fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      logger.info(MOD, `Cleaned up temp dir: ${dirPath}`);
    }
  } catch (err: any) {
    logger.warn(MOD, `Failed to clean up temp dir ${dirPath}: ${err.message}`);
  }
}

export interface ScanAndPersistInput {
  repoId: string;
  repoPath: string;
  branch?: string;
  projectId?: number;
  companyId?: number;
  /**
   * If true (and the RAG infra is enabled), generate embeddings for the freshly
   * stored chunks as part of the scan. Defaults to the VECTOR_SEARCH flag.
   */
  embed?: boolean;
  /** Optional progress reporter for background jobs. */
  onProgress?: (stage: string, detail?: Record<string, any>) => void | Promise<void>;
}

export interface ScanAndPersistResult {
  contextId: number;
  profile: ReturnType<RepositoryContextEngine['scan']>['profile'];
  chunksInserted: number;
  scanDurationMs: number;
  embed?: EmbedProgress;
}

/**
 * Core scan→persist→(optionally embed) pipeline. Throws on scan/clone errors
 * (including UnsupportedLanguageError, which callers may special-case).
 */
export async function scanAndPersistRepo(input: ScanAndPersistInput): Promise<ScanAndPersistResult> {
  const startTime = Date.now();
  const branch = input.branch || 'main';
  let tempCloneDir: string | null = null;

  try {
    let scanPath: string;
    if (isRemoteUrl(input.repoPath)) {
      await input.onProgress?.('cloning', { repoPath: input.repoPath, branch });
      tempCloneDir = cloneToTemp(input.repoPath, branch);
      scanPath = tempCloneDir;
    } else {
      if (!fs.existsSync(input.repoPath)) {
        throw new Error(`Repository path does not exist: ${input.repoPath}`);
      }
      scanPath = input.repoPath;
    }

    await input.onProgress?.('scanning', { scanPath });
    const engine = new RepositoryContextEngine();
    const { profile, chunks } = engine.scan(scanPath);

    const scanDurationMs = Date.now() - startTime;

    await input.onProgress?.('persisting', { totalChunks: chunks.length });
    const contextId = await saveRepositoryContext(
      input.repoId,
      profile,
      scanDurationMs,
      input.companyId,
      input.projectId,
    );
    const chunksInserted = await saveCodeChunks(contextId, chunks);

    logger.info(
      MOD,
      `Scan complete for ${input.repoId}: ${profile.totalFiles} files, ` +
        `${profile.helperFunctions.length} helpers, ${chunks.length} chunks in ${scanDurationMs}ms`,
    );

    const result: ScanAndPersistResult = { contextId, profile, chunksInserted, scanDurationMs };

    // Optional embedding pass (Phase 2 RAG). Fully gated inside the embedder.
    const shouldEmbed = input.embed ?? FEATURE_FLAGS.REPO_INTELLIGENCE.VECTOR_SEARCH;
    if (shouldEmbed && chunksInserted > 0) {
      await input.onProgress?.('embedding', { contextId, chunks: chunksInserted });
      const embedder = createCodeChunkEmbedder();
      result.embed = await embedder.embedRepositoryContext(contextId, async (p) => {
        await input.onProgress?.('embedding', { processed: p.processed, total: p.total });
      });
    }

    await input.onProgress?.('done', { contextId, chunksInserted });
    return result;
  } finally {
    if (tempCloneDir) cleanupTemp(tempCloneDir);
  }
}
