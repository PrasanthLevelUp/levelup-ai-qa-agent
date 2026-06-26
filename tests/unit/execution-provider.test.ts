/**
 * Unit tests for the Execution Provider architecture.
 *
 * Covers:
 *   1. artifact-ingestion — build an in-memory zip containing a Playwright
 *      test-results.json + evidence, ingest it, assert the results file is
 *      located and other files are classified.
 *   2. createExecutionProvider factory — returns the right provider per mode and
 *      DEFAULTS TO LOCAL for unknown/unset modes (the zero-regression guarantee).
 *   3. GitHubActionsExecutionProvider.execute — happy path with a fully mocked
 *      GitHubService + stubbed ExecutionEngine, asserting the canonical
 *      ExecutionResult shape (records, artifacts, repoPath, exitCode, metadata,
 *      providerInfo) and exitCode derivation.
 *   4. LocalExecutionProvider — execute() returns a canonical ExecutionResult
 *      (records/artifacts split), interface parity + no-op download/collect, and
 *      setup failures surface as ExecutionSetupError.
 *
 * Style matches the repo's plain-assertion convention (run via ts-node), so
 * there is no test-runner dependency.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';

import {
  createExecutionProvider,
  modeToSource,
  LocalExecutionProvider,
  GitHubActionsExecutionProvider,
  ingestRunArtifacts,
  classifyExtracted,
  type RemoteArtifact,
} from '../../src/core/execution/providers';
import { ExecutionEngine } from '../../src/core/execution-engine';
import type { ExecutionContext } from '../../src/core/execution/execution-provider';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

/** Minimal but realistic Playwright JSON-reporter document. */
function playwrightResultsJson(): string {
  return JSON.stringify({
    config: { rootDir: '/repo/tests', version: '1.40.0' },
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [
      {
        title: 'login.spec.ts',
        specs: [
          {
            title: 'logs in',
            ok: false,
            tests: [{ results: [{ status: 'failed', error: { message: 'locator not found' } }] }],
          },
        ],
      },
    ],
  });
}

/** A Playwright document with ONE failing + ONE passing test (mixed run). */
function mixedResultsJson(): string {
  return JSON.stringify({
    config: { rootDir: '/repo/tests', version: '1.40.0' },
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [
      {
        title: 'login.spec.ts',
        specs: [
          {
            title: 'logs in',
            ok: false,
            tests: [{ results: [{ status: 'failed', error: { message: 'locator not found' } }] }],
          },
          {
            title: 'shows home',
            ok: true,
            tests: [{ results: [{ status: 'passed' }] }],
          },
        ],
      },
    ],
  });
}

async function main() {
  console.log('\n==================================================');
  console.log('Execution Provider Tests');
  console.log('==================================================\n');

  // ─── 1. Artifact ingestion ───────────────────────────────────────
  console.log('=== artifact-ingestion ===');
  {
    // Build an in-memory zip that mimics a Playwright artifact upload:
    // test-results.json + a trace zip + a screenshot + an HTML report index.
    const inner = new JSZip();
    inner.file('test-results.json', playwrightResultsJson());
    inner.folder('trace')!.file('trace.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04])); // fake zip bytes
    inner.folder('screenshots')!.file('failure.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    inner.folder('playwright-report')!.file('index.html', '<html>report</html>');
    const zipBuffer = await inner.generateAsync({ type: 'nodebuffer' });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'levelup-ingest-'));
    const artifacts: RemoteArtifact[] = [{ id: 1, name: 'playwright-results', archiveDownloadUrl: 'https://x/y' }];
    const downloader = async (_a: RemoteArtifact) => ({ ok: true, buffer: zipBuffer });

    const result = await ingestRunArtifacts(artifacts, downloader, tmp);

    assert('ingest located the Playwright test-results.json', !!result.resultsFile);
    assert(
      'ingest results file parses as Playwright reporter output',
      !!result.resultsFile && JSON.parse(fs.readFileSync(result.resultsFile, 'utf-8')).suites?.length === 1,
    );
    assert('ingest classified the screenshot', result.screenshots.some(s => s.endsWith('failure.png')));
    assert('ingest classified the trace zip', result.traces.some(t => t.endsWith('trace.zip')));
    assert('ingest located the HTML report index', !!result.htmlReport && result.htmlReport.endsWith('index.html'));
    assert('ingest recorded the extracted artifact name', result.extractedArtifacts.includes('playwright-results'));
    assert('ingest produced no warnings on a clean upload', result.warnings.length === 0);

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Expired artifacts are skipped with a warning; missing results file warns.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'levelup-ingest2-'));
    const artifacts: RemoteArtifact[] = [{ id: 2, name: 'expired-one', expired: true }];
    const downloader = async () => ({ ok: false, error: 'should not be called' });
    const result = await ingestRunArtifacts(artifacts, downloader, tmp);
    assert('expired artifact is skipped (no results file)', result.resultsFile === null);
    assert('expired artifact produces a warning', result.warnings.some(w => /expired/i.test(w)));
    assert('missing results produces a guidance warning', result.warnings.some(w => /test-results\.json/i.test(w)));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // classifyExtracted ignores non-Playwright JSON.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'levelup-classify-'));
    const decoy = path.join(tmp, 'package.json');
    fs.writeFileSync(decoy, JSON.stringify({ name: 'not-playwright', version: '1.0.0' }));
    const real = path.join(tmp, 'test-results.json');
    fs.writeFileSync(real, playwrightResultsJson());
    const classified = classifyExtracted([decoy, real]);
    assert('classify ignores non-Playwright JSON and picks the real results file', classified.resultsFile === real);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ─── 2. Provider factory ─────────────────────────────────────────
  console.log('\n=== createExecutionProvider factory ===');
  {
    const local = createExecutionProvider('local');
    const gha = createExecutionProvider('github_actions');
    const unset = createExecutionProvider();
    const unknown = createExecutionProvider('jenkins' as any);

    assert('factory returns LocalExecutionProvider for "local"', local instanceof LocalExecutionProvider);
    assert('factory returns GitHubActionsExecutionProvider for "github_actions"', gha instanceof GitHubActionsExecutionProvider);
    assert('factory DEFAULTS to local for unset mode (zero regression)', unset instanceof LocalExecutionProvider);
    assert('factory DEFAULTS to local for unknown mode (zero regression)', unknown instanceof LocalExecutionProvider);
    assert('local provider reports source=local', local.source === 'local');
    assert('gha provider reports source=github_actions', gha.source === 'github_actions');
    assert('modeToSource maps github_actions', modeToSource('github_actions') === 'github_actions');
    assert('modeToSource maps unset to local', modeToSource() === 'local');
  }

  // ─── 3. GitHubActionsExecutionProvider.execute (happy path) ──────
  console.log('\n=== GitHubActionsExecutionProvider.execute ===');
  {
    // Build a real artifact zip to be returned by the mocked downloader.
    const inner = new JSZip();
    inner.file('test-results.json', playwrightResultsJson());
    const zipBuffer = await inner.generateAsync({ type: 'nodebuffer' });

    // Fully mocked GitHubService — records calls and returns canned data.
    const calls: string[] = [];
    const fakeGithub: any = {
      async dispatchWorkflow() { calls.push('dispatch'); return { success: true }; },
      async findRunForDispatch() {
        calls.push('find');
        return { run: { id: 4242, htmlUrl: 'https://github.com/o/r/actions/runs/4242' } };
      },
      async getWorkflowRun() {
        calls.push('get');
        return { run: { id: 4242, status: 'completed', conclusion: 'failure', htmlUrl: 'https://github.com/o/r/actions/runs/4242' } };
      },
      async listRunArtifacts() {
        calls.push('listArtifacts');
        return { artifacts: [{ id: 9, name: 'playwright-results', archiveDownloadUrl: 'https://x/y', expired: false }] };
      },
      async downloadArtifactZip() { calls.push('download'); return { ok: true, buffer: zipBuffer }; },
    };

    // Stub ExecutionEngine clone/install so the test never touches the network.
    const origClone = (ExecutionEngine as any).cloneRepository;
    const origInstall = (ExecutionEngine as any).installDependencies;
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'levelup-gha-repo-'));
    (ExecutionEngine as any).cloneRepository = async () => { fs.mkdirSync(repoPath, { recursive: true }); };
    (ExecutionEngine as any).installDependencies = async () => {};

    try {
      const provider = new GitHubActionsExecutionProvider(fakeGithub, new LocalExecutionProvider());
      const ctx: ExecutionContext = {
        repoUrl: 'https://github.com/o/r',
        branch: 'main',
        repoPath,
        profile: 'standard' as any,
        collectHealingArtifacts: false,
        budgetMs: 60000,
        companyId: 1,
        providerConfig: { workflowId: 'ci.yml' },
      };
      const result = await provider.execute(ctx);

      assert('execute dispatched the workflow', calls.includes('dispatch'));
      assert('execute correlated + polled the run', calls.includes('find') && calls.includes('get'));
      assert('execute downloaded artifacts', calls.includes('download'));
      // ── Canonical ExecutionResult shape (the inverted contract) ──
      assert('execute returns providerInfo.source=github_actions', result.providerInfo.source === 'github_actions');
      assert('execute exitCode=1 for a failed run (failures to heal)', result.exitCode === 1);
      assert('execute returns repoPath = the local clone', result.repoPath === repoPath);
      assert('execute resultsFile sits in the local repo path', result.resultsFile === path.join(repoPath, 'test-results.json'));
      assert('execute actually wrote the canonical results file', fs.existsSync(result.resultsFile));
      assert('execute results file is the ingested Playwright JSON', JSON.parse(fs.readFileSync(result.resultsFile, 'utf-8')).suites?.length === 1);
      // The provider OWNS parsing: artifacts for the 1 failing test, 0 non-failure records.
      assert('execute parsed failure artifacts (1 failing test)', Array.isArray(result.artifacts) && result.artifacts.length === 1);
      assert('execute built records (no non-failing tests ⇒ 0 records)', Array.isArray(result.records) && result.records.length === 0);
      // providerInfo carries the CI deep-link references.
      assert('execute providerInfo carries the CI run id', result.providerInfo.runId === 4242);
      assert('execute providerInfo carries the run url', !!result.providerInfo.runUrl);
      assert('execute providerInfo carries the conclusion', result.providerInfo.conclusion === 'failure');
      assert('execute providerInfo carries the artifact dir', !!result.providerInfo.artifactDir);
      // metadata carries timing/process info.
      assert('execute metadata reports a positive durationMs', typeof result.metadata.durationMs === 'number' && result.metadata.durationMs >= 0);
      assert('execute metadata.exitCode matches the result exitCode', result.metadata.exitCode === result.exitCode);
      assert('execute metadata carries start/end timestamps', !!result.metadata.startTime && !!result.metadata.endTime);

      // Missing workflowId must throw an ExecutionSetupError.
      let threw = false;
      try {
        await provider.execute({ ...ctx, providerConfig: {} });
      } catch (e) { threw = (e as Error).name === 'ExecutionSetupError'; }
      assert('execute throws ExecutionSetupError when providerConfig.workflowId is missing', threw);
    } finally {
      (ExecutionEngine as any).cloneRepository = origClone;
      (ExecutionEngine as any).installDependencies = origInstall;
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }

  // Success conclusion ⇒ exitCode 0.
  {
    const inner = new JSZip();
    inner.file('test-results.json', playwrightResultsJson());
    const zipBuffer = await inner.generateAsync({ type: 'nodebuffer' });
    const fakeGithub: any = {
      async dispatchWorkflow() { return { success: true }; },
      async findRunForDispatch() { return { run: { id: 1, htmlUrl: 'u' } }; },
      async getWorkflowRun() { return { run: { id: 1, status: 'completed', conclusion: 'success', htmlUrl: 'u' } }; },
      async listRunArtifacts() { return { artifacts: [{ id: 1, name: 'r', archiveDownloadUrl: 'x', expired: false }] }; },
      async downloadArtifactZip() { return { ok: true, buffer: zipBuffer }; },
    };
    const origClone = (ExecutionEngine as any).cloneRepository;
    const origInstall = (ExecutionEngine as any).installDependencies;
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'levelup-gha-ok-'));
    (ExecutionEngine as any).cloneRepository = async () => { fs.mkdirSync(repoPath, { recursive: true }); };
    (ExecutionEngine as any).installDependencies = async () => {};
    try {
      const provider = new GitHubActionsExecutionProvider(fakeGithub, new LocalExecutionProvider());
      const result = await provider.execute({
        repoUrl: 'https://github.com/o/r', branch: 'main', repoPath,
        profile: 'standard' as any, collectHealingArtifacts: false, budgetMs: 60000,
        providerConfig: { workflowId: 'ci.yml' },
      });
      assert('execute exitCode=0 for a successful run', result.exitCode === 0);
      assert('execute providerInfo.conclusion=success', result.providerInfo.conclusion === 'success');
    } finally {
      (ExecutionEngine as any).cloneRepository = origClone;
      (ExecutionEngine as any).installDependencies = origInstall;
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }

  // ─── runId reuse: heal an EXISTING run WITHOUT dispatching ──────
  // This is the "Heal Failures" path — the user already ran their suite; we must
  // NOT trigger a new run, just ingest the given run's artifacts.
  {
    const inner = new JSZip();
    inner.file('test-results.json', playwrightResultsJson());
    const zipBuffer = await inner.generateAsync({ type: 'nodebuffer' });
    const calls: string[] = [];
    const fakeGithub: any = {
      async dispatchWorkflow() { calls.push('dispatch'); return { success: true }; },
      async findRunForDispatch() { calls.push('find'); return { run: { id: 999, htmlUrl: 'u' } }; },
      async getWorkflowRun() {
        calls.push('get');
        return { run: { id: 7777, status: 'completed', conclusion: 'failure', htmlUrl: 'https://github.com/o/r/actions/runs/7777' } };
      },
      async listRunArtifacts() { calls.push('listArtifacts'); return { artifacts: [{ id: 3, name: 'r', archiveDownloadUrl: 'x', expired: false }] }; },
      async downloadArtifactZip() { calls.push('download'); return { ok: true, buffer: zipBuffer }; },
    };
    const origClone = (ExecutionEngine as any).cloneRepository;
    const origInstall = (ExecutionEngine as any).installDependencies;
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'levelup-gha-reuse-'));
    (ExecutionEngine as any).cloneRepository = async () => { fs.mkdirSync(repoPath, { recursive: true }); };
    (ExecutionEngine as any).installDependencies = async () => {};
    try {
      const provider = new GitHubActionsExecutionProvider(fakeGithub, new LocalExecutionProvider());
      const result = await provider.execute({
        repoUrl: 'https://github.com/o/r', branch: 'main', repoPath,
        profile: 'standard' as any, collectHealingArtifacts: false, budgetMs: 60000,
        providerConfig: { workflowId: 'ci.yml', runId: 7777 },
      });
      assert('reuse path does NOT dispatch a new workflow', !calls.includes('dispatch'));
      assert('reuse path does NOT correlate a dispatch', !calls.includes('find'));
      assert('reuse path polls the GIVEN run', calls.includes('get'));
      assert('reuse path ingests the given run artifacts', calls.includes('download'));
      assert('reuse path keeps the given runId in providerInfo', result.providerInfo.runId === 7777);
      assert('reuse path exitCode=1 for a failed run', result.exitCode === 1);

      // An invalid runId must throw before any GitHub call.
      let threw = false;
      try {
        await provider.execute({
          repoUrl: 'https://github.com/o/r', branch: 'main', repoPath,
          profile: 'standard' as any, collectHealingArtifacts: false, budgetMs: 1000,
          providerConfig: { workflowId: 'ci.yml', runId: 'not-a-number' as any },
        });
      } catch (e) { threw = (e as Error).name === 'ExecutionSetupError'; }
      assert('reuse path throws ExecutionSetupError for a non-numeric runId', threw);
    } finally {
      (ExecutionEngine as any).cloneRepository = origClone;
      (ExecutionEngine as any).installDependencies = origInstall;
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }

  // Dispatch failure must surface as a thrown error.
  {
    const fakeGithub: any = {
      async dispatchWorkflow() { return { success: false, error: 'no workflow_dispatch trigger' }; },
    };
    const provider = new GitHubActionsExecutionProvider(fakeGithub, new LocalExecutionProvider());
    let threw = false;
    try {
      await provider.execute({
        repoUrl: 'https://github.com/o/r', branch: 'main', repoPath: '/tmp/none',
        profile: 'standard' as any, collectHealingArtifacts: false, budgetMs: 1000,
        providerConfig: { workflowId: 'ci.yml' },
      });
    } catch (e) { threw = /dispatch/i.test((e as Error).message); }
    assert('execute throws a descriptive error when dispatch fails', threw);
  }

  // Non-GitHub repo URL must throw.
  {
    const provider = new GitHubActionsExecutionProvider({} as any, new LocalExecutionProvider());
    let threw = false;
    try {
      await provider.execute({
        repoUrl: 'https://gitlab.com/o/r', branch: 'main', repoPath: '/tmp/none',
        profile: 'standard' as any, collectHealingArtifacts: false, budgetMs: 1000,
        providerConfig: { workflowId: 'ci.yml' },
      });
    } catch (e) { threw = /github/i.test((e as Error).message); }
    assert('execute throws for a non-GitHub repo URL', threw);
  }

  // ─── 4. LocalExecutionProvider.execute returns a canonical ExecutionResult ──
  console.log('\n=== LocalExecutionProvider.execute ===');
  {
    const origClone = (ExecutionEngine as any).cloneRepository;
    const origInstall = (ExecutionEngine as any).installDependencies;
    const origRun = (ExecutionEngine as any).runAsync;
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'levelup-local-exec-'));
    const resultsFile = path.join(repoPath, 'test-results.json');
    (ExecutionEngine as any).cloneRepository = async () => { fs.mkdirSync(repoPath, { recursive: true }); };
    (ExecutionEngine as any).installDependencies = async () => {};
    (ExecutionEngine as any).runAsync = async () => {
      fs.writeFileSync(resultsFile, mixedResultsJson());
      return {
        exitCode: 1, stdout: 'ran', stderr: '', resultsFile,
        startTime: new Date().toISOString(), endTime: new Date().toISOString(), durationMs: 12,
      };
    };
    try {
      const local = new LocalExecutionProvider();
      const result = await local.execute({
        repoUrl: 'https://github.com/o/r', branch: 'main', repoPath,
        profile: 'standard' as any, collectHealingArtifacts: false, budgetMs: 60000,
        jobId: 'job-123',
      });
      assert('local execute returns providerInfo.source=local', result.providerInfo.source === 'local');
      assert('local execute passes through exitCode', result.exitCode === 1);
      assert('local execute returns the repoPath', result.repoPath === repoPath);
      assert('local execute returns the resultsFile', result.resultsFile === resultsFile);
      // The provider OWNS parsing: 1 failing artifact + 1 non-failure (pass) record.
      assert('local execute parsed the failing test into artifacts', result.artifacts.length === 1 && result.artifacts[0].test_name === 'logs in');
      assert('local execute built a finalized record for the passing test', result.records.length === 1 && result.records[0].testName === 'shows home');
      assert('local execute record is keyed by jobId (synthetic id)', result.records[0].executionId.startsWith('job-123:'));
      assert('local execute metadata carries durationMs', result.metadata.durationMs === 12);
      assert('local execute metadata.exitCode matches', result.metadata.exitCode === 1);
    } finally {
      (ExecutionEngine as any).cloneRepository = origClone;
      (ExecutionEngine as any).installDependencies = origInstall;
      (ExecutionEngine as any).runAsync = origRun;
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }

  // Setup failure (clone fails AND no existing package.json) ⇒ ExecutionSetupError.
  {
    const origClone = (ExecutionEngine as any).cloneRepository;
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'levelup-local-fail-'));
    (ExecutionEngine as any).cloneRepository = async () => { throw new Error('repo not found'); };
    try {
      const local = new LocalExecutionProvider();
      let err: any = null;
      try {
        await local.execute({
          repoUrl: 'https://github.com/o/r', branch: 'main', repoPath,
          profile: 'standard' as any, collectHealingArtifacts: false, budgetMs: 1000,
        });
      } catch (e) { err = e; }
      assert('local execute throws ExecutionSetupError when clone fails with no fallback', err?.name === 'ExecutionSetupError');
      assert('local execute setup error carries stage=clone', err?.stage === 'clone');
      assert('local execute setup error carries exitCode=128', err?.exitCode === 128);
    } finally {
      (ExecutionEngine as any).cloneRepository = origClone;
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }

  // ─── 4b. LocalExecutionProvider interface parity ─────────────────
  console.log('\n=== LocalExecutionProvider interface ===');
  {
    const local = new LocalExecutionProvider();
    assert('local exposes execute()', typeof local.execute === 'function');
    assert('local exposes validate()', typeof local.validate === 'function');
    assert('local exposes downloadArtifacts()', typeof local.downloadArtifacts === 'function');
    assert('local exposes collectResults()', typeof local.collectResults === 'function');
    const dl = await local.downloadArtifacts({} as any, '/tmp', {} as any);
    assert('local downloadArtifacts is a no-op (returns null)', dl === null);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'levelup-local-'));
    fs.writeFileSync(path.join(tmp, 'test-results.json'), playwrightResultsJson());
    const found = await local.collectResults(tmp);
    assert('local collectResults finds the on-disk results file', found === path.join(tmp, 'test-results.json'));
    const missing = await local.collectResults(os.tmpdir() + '/levelup-does-not-exist-xyz');
    assert('local collectResults returns null when no results file exists', missing === null);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ─── Summary ─────────────────────────────────────────────────────
  console.log('\n==================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('All tests passed! ✅');
  else {
    console.log('Some tests FAILED ❌');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
