/**
 * Healing Environment Diagnostic
 * ------------------------------------------------------------------------
 * Runs the SAME steps the healing worker depends on — but in isolation and
 * with every result captured — so we can see EXACTLY where healing breaks in
 * the deployed container instead of inferring it from UI screenshots.
 *
 * Why this exists: the healing trail historically said "no parseable failure
 * artifact" whenever a rerun could not be confirmed. That hid the real cause —
 * most often an ENVIRONMENT failure where Playwright never ran at all (e.g.
 * `xvfb-run: xauth command not found`, a missing browser, an unclonable repo).
 * This endpoint surfaces the truth: it probes the toolchain, runs a real
 * `xvfb-run` smoke test, clones the repo, lists tests, and executes one spec —
 * reporting each stage's exit code, stderr, and timing.
 *
 * It is READ-ONLY with respect to customer state: it clones into a throwaway
 * temp dir and removes it afterwards. It never writes to the customer repo.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecutionEngine } from '../execution-engine';
import { logger } from '../../utils/logger';

const MOD = 'healing-env-diagnostic';

export interface DiagnosticStage {
  name: string;
  ok: boolean;
  skipped?: boolean;
  durationMs: number;
  /** Short human-readable summary of what happened. */
  summary: string;
  /** Structured details (command output, versions, paths, etc.). */
  details?: Record<string, unknown>;
  /** Populated when ok === false. */
  error?: string;
}

export interface DiagnosticReport {
  ok: boolean;
  repo: { owner: string; repo: string; branch: string };
  /** The single most likely root cause, derived from the stages. */
  verdict: string;
  /** Actionable next step for the operator. */
  recommendation: string;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  stages: DiagnosticStage[];
}

/** Run a shell command, capturing exit code + stdout + stderr without throwing. */
function probe(
  cmd: string,
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      timeout: opts.timeoutMs ?? 15_000,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: stdout ?? '', stderr: '' };
  } catch (err: any) {
    return {
      exitCode: typeof err?.status === 'number' ? err.status : 1,
      stdout: err?.stdout?.toString?.() ?? '',
      stderr: err?.stderr?.toString?.() ?? String(err?.message ?? ''),
    };
  }
}

function firstLine(s: string): string {
  return (s || '').trim().split('\n')[0] ?? '';
}

function tail(s: string, n = 400): string {
  const t = (s || '').trim();
  return t.length > n ? t.slice(-n) : t;
}

/**
 * Find the first Playwright spec in a cloned repo (tests/ then root).
 * Returns a path RELATIVE to the tests/ dir (matching what the worker passes to
 * ExecutionEngine), plus the absolute path for existence checks.
 */
function findFirstSpec(repoPath: string): { relToTests: string; abs: string } | null {
  const roots = [path.join(repoPath, 'tests'), repoPath];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    const found: string[] = [];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (/\.spec\.(ts|js)$/.test(e.name) || /\.test\.(ts|js)$/.test(e.name)) found.push(full);
      }
    }
    if (found.length) {
      found.sort();
      const abs = found[0];
      const testsDir = path.join(repoPath, 'tests');
      const relToTests = abs.startsWith(testsDir) ? path.relative(testsDir, abs) : path.relative(repoPath, abs);
      return { relToTests, abs };
    }
  }
  return null;
}

/**
 * Execute the full diagnostic. Each stage is best-effort; a failed prerequisite
 * marks downstream stages as skipped rather than throwing.
 */
export async function runHealingEnvironmentDiagnostic(params: {
  owner: string;
  repo: string;
  branch?: string;
  /** Authenticated clone token (x-access-token). Optional for public repos. */
  token?: string | null;
  /** Optional explicit spec (relative to tests/); auto-detected if omitted. */
  testFile?: string;
}): Promise<DiagnosticReport> {
  const branch = params.branch || 'main';
  const stages: DiagnosticStage[] = [];
  const start = Date.now();
  const startedAt = new Date().toISOString();

  const run = async (
    name: string,
    fn: () => Promise<Omit<DiagnosticStage, 'name' | 'durationMs'>>,
  ): Promise<DiagnosticStage> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      const stage = { name, durationMs: Date.now() - t0, ...r };
      stages.push(stage);
      return stage;
    } catch (err: any) {
      const stage: DiagnosticStage = {
        name,
        ok: false,
        durationMs: Date.now() - t0,
        summary: 'Stage threw an unexpected error',
        error: String(err?.message ?? err),
      };
      stages.push(stage);
      return stage;
    }
  };

  // ── Stage 1: toolchain probe ──────────────────────────────────────────────
  const envStage = await run('environment', async () => {
    const node = firstLine(probe('node --version').stdout);
    const npm = firstLine(probe('npm --version').stdout);
    const git = firstLine(probe('git --version').stdout);
    const pwVersion = firstLine(probe('npx --no-install playwright --version').stdout) ||
      firstLine(probe('playwright --version').stdout);
    const xvfbRun = probe('command -v xvfb-run');
    const xauth = probe('command -v xauth');
    const hasXvfbRun = xvfbRun.exitCode === 0 && !!xvfbRun.stdout.trim();
    const hasXauth = xauth.exitCode === 0 && !!xauth.stdout.trim();
    const details = {
      node,
      npm,
      git,
      playwrightVersion: pwVersion || 'NOT FOUND',
      xvfbRun: hasXvfbRun ? xvfbRun.stdout.trim() : 'MISSING',
      xauth: hasXauth ? xauth.stdout.trim() : 'MISSING',
      env: {
        BASE_URL: process.env['BASE_URL'] ? 'set' : 'unset',
        PLAYWRIGHT_BROWSERS_PATH: process.env['PLAYWRIGHT_BROWSERS_PATH'] || 'unset',
        WORKSPACE_DIR: process.env['WORKSPACE_DIR'] || 'unset (defaults /tmp/healing-repos)',
        OPENAI_API_KEY: process.env['OPENAI_API_KEY'] ? 'set' : 'unset',
        DATABASE_URL: process.env['DATABASE_URL'] ? 'set' : 'unset',
      },
    };
    // xvfb-run WITHOUT xauth is the known fatal combo: every wrapped run aborts
    // before any test executes.
    const xvfbBroken = hasXvfbRun && !hasXauth;
    return {
      ok: !!pwVersion && !xvfbBroken,
      summary: xvfbBroken
        ? 'xvfb-run is present but xauth is MISSING — xvfb-run will abort before any test runs'
        : `node ${node}, playwright ${details.playwrightVersion}, xvfb-run=${details.xvfbRun !== 'MISSING'}, xauth=${details.xauth !== 'MISSING'}`,
      details,
      error: xvfbBroken ? 'xauth not installed; xvfb-run cannot create its X authority cookie' : undefined,
    };
  });

  // ── Stage 2: xvfb-run smoke test (decisive for the xauth crash) ───────────
  await run('xvfb_smoke', async () => {
    const hasXvfbRun = firstLine(probe('command -v xvfb-run').stdout) !== '';
    if (!hasXvfbRun) {
      return {
        ok: true,
        skipped: true,
        summary: 'xvfb-run not installed — engine will run Playwright directly (fine for headless)',
      };
    }
    const r = probe('xvfb-run -a echo levelup-xvfb-ok', { timeoutMs: 20_000 });
    const ok = r.exitCode === 0 && r.stdout.includes('levelup-xvfb-ok');
    return {
      ok,
      summary: ok
        ? 'xvfb-run executed a command successfully'
        : `xvfb-run FAILED (exit ${r.exitCode}) — this breaks EVERY healing rerun`,
      details: { exitCode: r.exitCode, stderr: tail(r.stderr) },
      error: ok ? undefined : `xvfb-run could not launch: ${tail(r.stderr, 200)}`,
    };
  });

  // ── Stage 3: clone the repo ───────────────────────────────────────────────
  const tmpDir = path.join(os.tmpdir(), `levelup-diagnose-${params.repo}-${Date.now()}`);
  let cloneOk = false;
  await run('clone', async () => {
    const cloneUrl = params.token
      ? `https://x-access-token:${params.token}@github.com/${params.owner}/${params.repo}.git`
      : `https://github.com/${params.owner}/${params.repo}.git`;
    try {
      await ExecutionEngine.cloneRepository(cloneUrl, tmpDir, branch);
      cloneOk = fs.existsSync(path.join(tmpDir, '.git'));
      const sha = firstLine(probe('git rev-parse --short HEAD', { cwd: tmpDir }).stdout);
      const hasPkg = fs.existsSync(path.join(tmpDir, 'package.json'));
      return {
        ok: cloneOk,
        summary: cloneOk ? `Cloned ${params.owner}/${params.repo}@${branch} (HEAD ${sha})` : 'Clone produced no .git directory',
        details: { branch, headSha: sha, hasPackageJson: hasPkg, tokenUsed: !!params.token },
        error: cloneOk ? undefined : 'git clone did not create a working tree',
      };
    } catch (err: any) {
      // Never leak the token in error text.
      const msg = String(err?.message ?? err).replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
      return { ok: false, summary: 'git clone failed', error: msg };
    }
  });

  // ── Stage 4: install dependencies (bounded) ───────────────────────────────
  let installOk = false;
  await run('install', async () => {
    if (!cloneOk) return { ok: false, skipped: true, summary: 'Skipped — repo was not cloned' };
    const r = probe('npm install --include=dev --no-audit --no-fund', { cwd: tmpDir, timeoutMs: 180_000 });
    installOk = r.exitCode === 0 || fs.existsSync(path.join(tmpDir, 'node_modules'));
    return {
      ok: installOk,
      summary: installOk ? 'Dependencies installed' : `npm install failed (exit ${r.exitCode})`,
      details: { exitCode: r.exitCode, stderr: tail(r.stderr) },
      error: installOk ? undefined : tail(r.stderr, 300),
    };
  });

  // ── Stage 5: playwright --list (does Playwright even start?) ───────────────
  let spec = params.testFile ? { relToTests: params.testFile, abs: '' } : null;
  await run('list_tests', async () => {
    if (!cloneOk) return { ok: false, skipped: true, summary: 'Skipped — repo was not cloned' };
    const r = probe('npx playwright test --list', { cwd: tmpDir, timeoutMs: 60_000 });
    const ok = r.exitCode === 0;
    if (!spec) {
      const found = findFirstSpec(tmpDir);
      if (found) spec = found;
    }
    return {
      ok,
      summary: ok ? `Playwright listed tests; target spec: ${spec?.relToTests ?? 'none found'}` : `playwright --list failed (exit ${r.exitCode})`,
      details: { exitCode: r.exitCode, stdoutTail: tail(r.stdout, 300), stderr: tail(r.stderr), detectedSpec: spec?.relToTests },
      error: ok ? undefined : tail(r.stderr, 300),
    };
  });

  // ── Stage 6: run one spec via the REAL engine path ────────────────────────
  await run('run_spec', async () => {
    if (!cloneOk) return { ok: false, skipped: true, summary: 'Skipped — repo was not cloned' };
    if (!spec) return { ok: false, skipped: true, summary: 'Skipped — no spec found to run' };
    const result = await ExecutionEngine.runAsync(
      tmpDir,
      spec.relToTests,
      undefined,
      120_000,
      'standard',
      true,
      true, // isHealingRun — exercises the exact flags the heal loop uses
    );
    const resultsExists = !!result.resultsFile && fs.existsSync(result.resultsFile);
    let stats: Record<string, unknown> | undefined;
    if (resultsExists) {
      try {
        stats = JSON.parse(fs.readFileSync(result.resultsFile, 'utf-8')).stats;
      } catch { /* ignore */ }
    }
    // The point of the diagnostic is to confirm a TEST ACTUALLY RAN — not that
    // it passed. A produced results file with parseable stats means the engine
    // is healthy; the spec itself may pass or fail.
    const ranATest = resultsExists && !!stats;
    const crashedBeforeTests = !resultsExists && result.exitCode !== 0;
    return {
      ok: ranATest,
      summary: ranATest
        ? `Engine executed the spec (exit ${result.exitCode}, ${result.durationMs}ms) and produced a parseable report`
        : crashedBeforeTests
          ? `Engine CRASHED BEFORE ANY TEST RAN (exit ${result.exitCode}, ${result.durationMs}ms) — no results file. This is the healing failure.`
          : `Engine ran but produced no parseable report (exit ${result.exitCode})`,
      details: {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        resultsFile: resultsExists ? 'present' : 'MISSING',
        stats,
        stderrTail: tail(result.stderr, 400),
      },
      error: ranATest ? undefined : tail(result.stderr, 300) || 'no results file produced',
    };
  });

  // ── cleanup ───────────────────────────────────────────────────────────────
  try {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn(MOD, 'Failed to clean up diagnostic temp dir', { tmpDir, error: (err as Error).message });
  }

  // ── verdict synthesis ─────────────────────────────────────────────────────
  // GROUND TRUTH is the run_spec stage: if the engine executed a spec to
  // completion and produced a parseable report, the healing loop CAN confirm a
  // fix — regardless of whether xvfb-run is broken (the engine falls back to
  // running Playwright directly). So we judge primarily on run_spec, and treat
  // upstream issues as the blocker only when run_spec did NOT succeed.
  const stageByName = (n: string) => stages.find((s) => s.name === n);
  const runSpec = stageByName('run_spec');
  const xvfbDegraded = !!(stageByName('xvfb_smoke') && !stageByName('xvfb_smoke')!.ok && !stageByName('xvfb_smoke')!.skipped);

  let healthy: boolean;
  let verdict: string;
  let recommendation: string;

  if (runSpec && runSpec.ok) {
    // The engine can run tests end-to-end → healing works.
    healthy = true;
    if (xvfbDegraded) {
      verdict = 'WORKING (degraded): xvfb-run is broken (xauth missing) but the engine ran a spec to completion via the direct-run fallback, so healing CAN confirm fixes.';
      recommendation = 'Healing should work now. For full robustness (customer configs with headless:false), install xauth in the container and redeploy — PR #187 does this. If a specific heal still fails, it is candidate-specific; check that execution\'s decision trail.';
    } else {
      verdict = 'HEALTHY: the container clones, starts Playwright, and executes a spec end-to-end.';
      recommendation = 'Healing should work. If a specific heal still fails, it is candidate-specific, not environmental — check that execution\'s decision trail.';
    }
  } else {
    // run_spec failed/skipped — find the earliest real blocker.
    healthy = false;
    const blocker = stages.find((s) => !s.ok && !s.skipped);
    switch (blocker?.name) {
      case 'environment':
      case 'xvfb_smoke':
        verdict = 'BROKEN: the X virtual-framebuffer wrapper cannot launch (xvfb-run present, xauth missing) AND the engine could not run a spec — every healing rerun aborts before any test runs.';
        recommendation = 'Install xauth in the container (apt-get install -y xauth) alongside xvfb, then redeploy. PR #187 does this in the Dockerfile.';
        break;
      case 'clone':
        verdict = 'BROKEN: the container could not clone the repo. Healing can never start without the source.';
        recommendation = 'Verify the GitHub token has access to this repo and the branch name is correct.';
        break;
      case 'install':
        verdict = 'BROKEN: dependency install failed, so Playwright cannot run.';
        recommendation = 'Check the repo\'s package.json / lockfile and network egress from the container.';
        break;
      case 'list_tests':
        verdict = 'BROKEN: Playwright itself will not start (config or install problem).';
        recommendation = 'Inspect the playwright.config and ensure @playwright/test resolves in the container.';
        break;
      case 'run_spec':
        verdict = 'BROKEN: the engine could not execute a spec to completion — the heal loop can never confirm a fix.';
        recommendation = 'Read the run_spec stderr tail below; it states the exact failure (browser missing, timeout, xvfb/xauth without fallback, etc.).';
        break;
      default:
        verdict = `BROKEN at stage "${blocker?.name ?? 'unknown'}".`;
        recommendation = 'See the failing stage details below.';
    }
  }

  return {
    ok: healthy,
    repo: { owner: params.owner, repo: params.repo, branch },
    verdict,
    recommendation,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalDurationMs: Date.now() - start,
    stages,
  };
}
