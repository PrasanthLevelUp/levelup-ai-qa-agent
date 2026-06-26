import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecutionEngine } from '../../src/core/execution-engine';

/**
 * Regression guard for the "stale test-results.json" production trap.
 *
 * The healing loop reruns a spec and reads test-results.json to confirm a fix.
 * If a rerun ever exits BEFORE Playwright writes its report (launcher crash,
 * OOM, xvfb/xauth failure, etc.) any PREVIOUS report left on disk would be
 * parsed as if it were this run's result — falsely confirming or reverting a
 * heal ("Report only — rerun still failed"). ExecutionEngine must therefore
 * delete any pre-existing report BEFORE every run.
 *
 * We can't launch a real browser here, so we drive a no-op "test" via a fake
 * repo whose package wiring causes Playwright to fail fast; what we assert is
 * the invariant that a STALE report is never left in place to be misread.
 */
describe('ExecutionEngine clears stale test-results.json before a run', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir && fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('removes a pre-existing (stale) report so it cannot be misread as this run', async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-results-'));

    // Plant a STALE passing report from a previous run.
    const staleReport = {
      stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
      suites: [],
      errors: [],
      __marker: 'STALE_PREVIOUS_RUN',
    };
    const resultsFile = path.join(repoDir, 'test-results.json');
    fs.writeFileSync(resultsFile, JSON.stringify(staleReport), 'utf-8');
    expect(fs.existsSync(resultsFile)).toBe(true);

    // No package.json / node_modules → npx playwright fails fast and writes no
    // new report. The run must NOT leave the stale file in place.
    await ExecutionEngine.runAsync(repoDir, undefined, undefined, 15_000, 'fast', false, false);

    if (fs.existsSync(resultsFile)) {
      // If a file exists at all, it must NOT be the stale one (i.e. a real new
      // report was written, e.g. recovered from stdout). The stale marker must
      // never survive.
      const after = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
      expect(after.__marker).not.toBe('STALE_PREVIOUS_RUN');
    } else {
      // No file is the honest outcome: callers then hit their "no results"
      // path instead of parsing a previous run's result.
      expect(fs.existsSync(resultsFile)).toBe(false);
    }
  }, 30_000);
});
