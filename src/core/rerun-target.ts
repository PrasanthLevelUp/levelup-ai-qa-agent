/**
 * rerun-target — resolve a SAFE Playwright rerun target when confirming a heal.
 *
 * Background (the real production "Report only" cause once the container was
 * healthy): Playwright's positional file argument runs ONLY the tests in that
 * file. For a page-object locator heal, `failure.filePath` points at the Page
 * Object (e.g. `pages/LoginPage.ts`), which contains NO tests. If the rerun
 * targets it, Playwright matches ZERO tests and exits 1 with an EMPTY report —
 * so the heal loop sees "rerun failed / no parseable artifact" and silently
 * reverts a perfectly good fix. `specFilePath` (the real spec) is supposed to
 * prevent this, but it can be missing from a CI-uploaded results JSON, so the
 * old code fell back to the Page Object.
 *
 * These helpers guarantee a rerun never targets a non-spec file.
 */
import * as fs from 'fs';
import * as path from 'path';

/** A real Playwright spec/test file (where tests are DEFINED). */
export function isSpecFile(p?: string | null): boolean {
  return !!p && /\.(spec|test)\.[tj]sx?$/.test(p);
}

/**
 * Resolve a SAFE rerun target (path relative to repo root, usable as a
 * Playwright positional) ONLY when we can prove it is a real, existing spec
 * file. Otherwise returns `undefined` so the caller reruns by
 * `--grep "<test name>"` alone — Playwright then finds and runs the test across
 * the whole suite, which always works regardless of where the broken locator
 * lives or whether `specFilePath` was populated.
 */
export function resolveRerunRelFile(
  failure: { specFilePath?: string; filePath?: string },
  testRepoPath: string,
): string | undefined {
  const candidate =
    (isSpecFile(failure.specFilePath) && fs.existsSync(failure.specFilePath!) && failure.specFilePath!) ||
    (isSpecFile(failure.filePath) && fs.existsSync(failure.filePath!) && failure.filePath!) ||
    null;
  if (!candidate) return undefined; // grep-only: run by test name across the suite
  const rel = path.relative(testRepoPath, candidate);
  // A path escaping the repo root can't be a valid positional — fall back to grep-only.
  return rel && !rel.startsWith('..') ? rel : undefined;
}
