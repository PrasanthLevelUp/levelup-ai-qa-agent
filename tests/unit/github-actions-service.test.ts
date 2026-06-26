/**
 * Unit tests for GitHub Actions integration (Execution Mode 2).
 *
 * Runs without a database or network: `getToken` is stubbed on the instance and
 * `global.fetch` is replaced with a small URL/method router returning canned
 * GitHub API responses.
 *
 * Run: npx ts-node tests/unit/github-actions-service.test.ts
 */

import {
  GitHubService,
  parseGitHubRepoUrl,
  type GitHubWorkflow,
  type GitHubWorkflowRun,
  type GitHubArtifact,
} from '../../src/integrations/github-service';

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
}

/* ── Fetch mock ───────────────────────────────────────────────────── */

type MockResponse = { ok: boolean; status: number; body: any };
type Handler = (url: string, init: any) => MockResponse;

let handler: Handler = () => ({ ok: false, status: 500, body: {} });
let lastRequest: { url: string; init: any } | null = null;

(global as any).fetch = async (url: string, init: any = {}) => {
  lastRequest = { url, init };
  const r = handler(url, init);
  return {
    ok: r.ok,
    status: r.status,
    headers: new Map() as any, // ghFetch only reads headers via .get on real calls; not used here
    json: async () => r.body,
  };
};

function makeService(): GitHubService {
  const svc = new GitHubService();
  // Stub token resolution so no DB call happens.
  (svc as any).getToken = async () => 'fake-token';
  return svc;
}

async function run() {
  console.log('\n==================================================');
  console.log('GitHub Actions Service Tests');
  console.log('==================================================\n');

  /* ── parseGitHubRepoUrl ─────────────────────────────────────────── */
  console.log('=== parseGitHubRepoUrl ===');
  const cases: Array<[string, { owner: string; repo: string } | null]> = [
    ['https://github.com/PrasanthLevelUp/LevelUpAI_SauceDemo.git', { owner: 'PrasanthLevelUp', repo: 'LevelUpAI_SauceDemo' }],
    ['github.com/Owner/Repo', { owner: 'Owner', repo: 'Repo' }],
    ['git@github.com:Owner/Repo.git', { owner: 'Owner', repo: 'Repo' }],
    ['https://gitlab.com/Owner/Repo.git', null],
    ['not a url', null],
  ];
  for (const [input, expected] of cases) {
    const got = parseGitHubRepoUrl(input);
    assert(`parse "${input}"`, JSON.stringify(got) === JSON.stringify(expected));
  }

  const svc = makeService();

  /* ── listWorkflows ──────────────────────────────────────────────── */
  console.log('\n=== listWorkflows ===');
  handler = (url) => {
    if (url.includes('/actions/workflows') && !url.includes('/runs')) {
      return {
        ok: true, status: 200, body: {
          total_count: 1,
          workflows: [
            { id: 161335, name: 'Playwright Tests', path: '.github/workflows/playwright.yml', state: 'active', html_url: 'https://github.com/o/r/actions/workflows/playwright.yml' },
          ],
        },
      };
    }
    return { ok: false, status: 404, body: { message: 'nope' } };
  };
  const wfRes = await svc.listWorkflows('o', 'r');
  assert('listWorkflows returns no error', !wfRes.error);
  assert('listWorkflows returns 1 workflow', wfRes.workflows.length === 1);
  const wf: GitHubWorkflow = wfRes.workflows[0];
  assert('workflow path mapped', wf.path === '.github/workflows/playwright.yml');
  assert('workflow id mapped', wf.id === 161335);

  // 404 → friendly error
  handler = () => ({ ok: false, status: 404, body: { message: 'Not Found' } });
  const wf404 = await svc.listWorkflows('o', 'missing');
  assert('listWorkflows 404 surfaces error', !!wf404.error && wf404.workflows.length === 0);

  /* ── dispatchWorkflow ───────────────────────────────────────────── */
  console.log('\n=== dispatchWorkflow ===');
  handler = (url, init) => {
    if (url.includes('/dispatches') && init.method === 'POST') {
      return { ok: true, status: 204, body: {} };
    }
    return { ok: false, status: 500, body: {} };
  };
  const disp = await svc.dispatchWorkflow('o', 'r', 'playwright.yml', 'main', { suite: 'smoke' });
  assert('dispatch succeeds on 204', disp.success === true);
  assert('dispatch sends ref + inputs in body', (() => {
    const b = JSON.parse(lastRequest!.init.body);
    return b.ref === 'main' && b.inputs?.suite === 'smoke';
  })());

  // empty ref rejected before any call
  const dispNoRef = await svc.dispatchWorkflow('o', 'r', 'playwright.yml', '   ');
  assert('dispatch rejects empty ref', dispNoRef.success === false && !!dispNoRef.error);

  // 422 → actionable error
  handler = () => ({ ok: false, status: 422, body: { message: "Workflow does not have 'workflow_dispatch' trigger." } });
  const disp422 = await svc.dispatchWorkflow('o', 'r', 'no-dispatch.yml', 'main');
  assert('dispatch 422 returns error', disp422.success === false && /workflow_dispatch/i.test(disp422.error || ''));

  /* ── getWorkflowRun ─────────────────────────────────────────────── */
  console.log('\n=== getWorkflowRun ===');
  handler = (url) => {
    if (/\/actions\/runs\/\d+($|\?)/.test(url)) {
      return {
        ok: true, status: 200, body: {
          id: 999, name: 'Playwright Tests', display_title: 'Run smoke', status: 'completed',
          conclusion: 'failure', event: 'workflow_dispatch', head_branch: 'main', head_sha: 'deadbeef',
          html_url: 'https://github.com/o/r/actions/runs/999', run_number: 12, workflow_id: 161335,
          created_at: '2026-06-26T12:00:00Z', updated_at: '2026-06-26T12:05:00Z', run_started_at: '2026-06-26T12:00:30Z',
        },
      };
    }
    return { ok: false, status: 404, body: { message: 'no' } };
  };
  const runRes = await svc.getWorkflowRun('o', 'r', 999);
  assert('getWorkflowRun returns run', !!runRes.run && !runRes.error);
  const run: GitHubWorkflowRun = runRes.run!;
  assert('run conclusion mapped', run.conclusion === 'failure');
  assert('run status mapped', run.status === 'completed');
  assert('run displayTitle mapped', run.displayTitle === 'Run smoke');

  /* ── findRunForDispatch ─────────────────────────────────────────── */
  console.log('\n=== findRunForDispatch ===');
  handler = (url) => {
    if (url.includes('/runs')) {
      return {
        ok: true, status: 200, body: {
          workflow_runs: [
            { id: 1001, name: 'PW', display_title: 'dispatch', status: 'queued', conclusion: null, event: 'workflow_dispatch', head_branch: 'main', head_sha: 'aa', html_url: 'u', run_number: 1, workflow_id: 1, created_at: 'x', updated_at: 'y', run_started_at: null },
          ],
        },
      };
    }
    return { ok: false, status: 404, body: {} };
  };
  const found = await svc.findRunForDispatch('o', 'r', 'playwright.yml', 'main', '2026-06-26T11:59:00Z', undefined, undefined, { attempts: 2, intervalMs: 1 });
  assert('findRunForDispatch finds the run', found.run?.id === 1001);

  // no runs → graceful error (use 1 attempt to keep it fast)
  handler = () => ({ ok: true, status: 200, body: { workflow_runs: [] } });
  const notFound = await svc.findRunForDispatch('o', 'r', 'playwright.yml', 'main', '2026-06-26T11:59:00Z', undefined, undefined, { attempts: 1, intervalMs: 1 });
  assert('findRunForDispatch returns error when none appear', !notFound.run && !!notFound.error);

  /* ── listRunArtifacts ───────────────────────────────────────────── */
  console.log('\n=== listRunArtifacts ===');
  handler = (url) => {
    if (url.includes('/artifacts')) {
      return {
        ok: true, status: 200, body: {
          total_count: 1,
          artifacts: [
            { id: 55, name: 'playwright-report', size_in_bytes: 2048, expired: false, archive_download_url: 'https://api.github.com/.../zip', created_at: '2026-06-26T12:06:00Z' },
          ],
        },
      };
    }
    return { ok: false, status: 404, body: {} };
  };
  const artRes = await svc.listRunArtifacts('o', 'r', 999);
  assert('listRunArtifacts returns artifacts', artRes.artifacts.length === 1 && !artRes.error);
  const art: GitHubArtifact = artRes.artifacts[0];
  assert('artifact name + size mapped', art.name === 'playwright-report' && art.sizeInBytes === 2048);

  /* ── Token-missing path ─────────────────────────────────────────── */
  console.log('\n=== Token missing ===');
  const noTokenSvc = new GitHubService();
  (noTokenSvc as any).getToken = async () => null;
  const wfNoTok = await noTokenSvc.listWorkflows('o', 'r');
  assert('listWorkflows without token returns error', !!wfNoTok.error && wfNoTok.workflows.length === 0);

  /* ── Summary ────────────────────────────────────────────────────── */
  console.log('\n==================================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('All tests passed! ✅');
  else { console.log('Some tests FAILED ❌'); process.exit(1); }
}

run().catch((e) => { console.error(e); process.exit(1); });
