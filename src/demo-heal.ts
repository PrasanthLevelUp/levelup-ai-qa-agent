/**
 * CLI for the deterministic demo heal pipeline (shortest end-to-end happy path).
 *
 * Usage:
 *   npx ts-node src/demo-heal.ts --repo /path/to/LevelUpAI_SauceDemo \
 *       --spec tests/verify-successful-login-with-valid-credentials.spec.ts \
 *       --base-url https://www.saucedemo.com
 *
 * All flags are optional except --repo:
 *   --repo      Absolute path to the repo under test (required).
 *   --spec      Single spec file to run (repo-relative). Omit to run the whole suite.
 *   --base-url  App URL to crawl for grounded selectors. Defaults to BASE_URL env.
 *   --timeout   Per-run timeout in ms (default 90000).
 *
 * Exit code: 0 when healed + rerun green, 1 otherwise.
 */
import { runDemoHealPipeline } from './core/demo-heal-pipeline';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const repo = arg('repo');
  if (!repo) {
    console.error('ERROR: --repo <path> is required.');
    process.exit(2);
  }
  const result = await runDemoHealPipeline({
    repoPath: repo,
    testFile: arg('spec'),
    baseUrl: arg('base-url'),
    timeoutMs: arg('timeout') ? Number(arg('timeout')) : undefined,
  });

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(' DEMO HEAL — DETERMINISTIC HAPPY PATH');
  console.log('──────────────────────────────────────────────────────────────');
  for (const s of result.steps) {
    const icon = s.status === 'ok' ? '✓' : s.status === 'skipped' ? '–' : '✗';
    console.log(` ${icon} step ${s.step} ${s.name.padEnd(22)} ${s.detail}`);
  }
  console.log('──────────────────────────────────────────────────────────────');
  console.log(` ${result.summary}`);
  console.log('──────────────────────────────────────────────────────────────\n');

  process.exit(result.healed ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
