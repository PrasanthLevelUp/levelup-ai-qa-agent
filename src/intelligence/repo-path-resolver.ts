/**
 * Repo Path Resolver (Repo Intelligence)
 * ======================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Failure artifacts carry file paths that almost never match the healing agent's
 * freshly-cloned repo verbatim. A CI runner reports
 * `/home/runner/work/Repo/Repo/pages/LoginPage.ts`; a GitLab job reports
 * `/builds/org/Repo/pages/LoginPage.ts`; a local dev run reports yet another
 * absolute prefix. The healing pipeline only has the clone on disk, so it must
 * map any of these "foreign" paths back onto a real repo-relative file.
 *
 * OWNERSHIP
 * ---------
 * Mapping a path onto the repository's actual layout is a *repository-structure*
 * question, so it belongs to Repo Intelligence — NOT to Healing. Healing (and
 * every other consumer) should simply ASK this resolver instead of hardcoding
 * folder names like `pages/`, `pom/`, `tests/`, `src/`. That keeps Healing
 * layout-agnostic: it works for `pages/`, `ui/pageObjects/`, `framework/pom/`,
 * `automation/specs/`, or anything else, with zero Healing changes.
 *
 * HOW IT WORKS (filesystem-grounded, convention-free)
 * ---------------------------------------------------
 * Rather than guessing at conventional directory names, the resolver checks the
 * *actual cloned files*:
 *   1. Verbatim — the path is already repo-relative and exists.
 *   2. Progressive suffix match — strip leading segments one at a time and test
 *      each suffix against the clone (this is what peels the CI prefix off
 *      `/home/runner/work/Repo/Repo/pages/LoginPage.ts` → `pages/LoginPage.ts`).
 *   3. Basename find — last resort, locate the file by name anywhere in the repo.
 *
 * Because every step is grounded in the real filesystem, it needs ZERO knowledge
 * of folder conventions and is correct for any layout by construction.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * An existence checker. Defaults to the real filesystem but can be injected for
 * deterministic unit testing of arbitrary repo layouts without touching disk.
 */
export type ExistsFn = (absPath: string) => boolean;

export interface RepoPathResolver {
  /**
   * Map a raw failure-stack path (absolute, CI-prefixed, or relative) onto a
   * path that actually exists inside the clone. Returns a repo-relative POSIX
   * path, or null when the file cannot be located.
   */
  toRepoRelative(rawPath: string): string | null;
  /**
   * Like {@link toRepoRelative} but returns an absolute path inside the clone.
   * Folder-free fallback (never invents conventional directories): when the file
   * cannot be located, returns the verbatim relative join, else a basename join,
   * so callers that require *some* path keep their existing contract.
   */
  toAbsolute(rawPath: string): string | null;
}

/**
 * Build a resolver bound to a specific clone root.
 *
 * @param repoRoot Absolute path to the freshly-cloned repository.
 * @param exists   Optional existence checker (defaults to `fs.existsSync`), for tests.
 */
export function createRepoPathResolver(repoRoot: string, exists: ExistsFn = fs.existsSync): RepoPathResolver {
  function toRepoRelative(rawPath: string): string | null {
    if (!rawPath) return null;
    const norm = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');

    // 1. Verbatim (already repo-relative).
    if (!path.isAbsolute(norm) && exists(path.join(repoRoot, norm))) {
      return norm;
    }

    // 2. Progressive suffix match — strip leading segments one at a time. This is
    //    what peels a foreign absolute prefix off the path and re-anchors the
    //    remaining suffix onto the clone, for ANY layout.
    const segments = norm.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      const candidate = segments.slice(i).join('/');
      if (candidate && exists(path.join(repoRoot, candidate))) {
        return candidate;
      }
    }

    // 3. Basename find anywhere in the repo (first match wins). Only attempted on
    //    the real filesystem (skipped when a custom existence checker is injected).
    if (exists === fs.existsSync) {
      try {
        const base = segments[segments.length - 1];
        if (base) {
          const found = execSync(
            `find . -type f -name "${base.replace(/"/g, '\\"')}" -not -path "*/node_modules/*" 2>/dev/null | head -1`,
            { cwd: repoRoot, encoding: 'utf-8', timeout: 10_000 },
          ).trim();
          if (found) return found.replace(/^\.\//, '');
        }
      } catch {
        /* ignore */
      }
    }

    return null;
  }

  function toAbsolute(rawPath: string): string | null {
    if (!rawPath) return null;
    const norm = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');

    // Absolute path that already exists locally (healing agent shares the FS) → use as-is.
    if (path.isAbsolute(norm) && exists(norm)) {
      return norm;
    }

    // Map onto the clone via the filesystem-grounded strategy.
    const rel = toRepoRelative(norm);
    if (rel) {
      return path.join(repoRoot, rel);
    }

    // Folder-free fallback (no conventional-directory guessing): preserve the old
    // contract of always returning *some* path under the repo root.
    if (!path.isAbsolute(norm)) {
      return path.join(repoRoot, norm);
    }
    return path.join(repoRoot, path.basename(norm));
  }

  return { toRepoRelative, toAbsolute };
}
