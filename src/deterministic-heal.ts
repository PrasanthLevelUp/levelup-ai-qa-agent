#!/usr/bin/env ts-node
/**
 * deterministic-heal — CLI for Deterministic (Grounded) Locator Healing
 * =====================================================================
 * Exercises the SAME strategy the healing worker runs as its first layer
 * (`resolveDeterministicLocator`), end-to-end against a real repo, using the
 * standalone `DeterministicLocatorHealingPipeline` runner.
 *
 * It is PROFILE-ONLY: it consumes an EXISTING Application Profile that you pass
 * with `--profile <crawl_data.json>`. It NEVER crawls during healing. If you
 * have not crawled the app yet, crawl it first (separate, explicit setup step)
 * and pass the saved profile here.
 *
 * Usage:
 *   ts-node src/deterministic-heal.ts \
 *     --repo    /abs/path/to/test-repo \
 *     --profile /abs/path/to/app-profile.json \
 *     [--spec   tests/some.spec.ts] \
 *     [--timeout 90000]
 *
 * Exit code: 0 when the test was deterministically healed and verified green;
 * 1 otherwise (including "no profile — crawl first").
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DeterministicLocatorHealingPipeline,
  groundFromProfileData,
  type AppProfileEvidence,
} from './core/deterministic-locator-healing';
import type { FailureDetails } from './core/failure-analyzer';

interface CliArgs {
  repo?: string;
  profile?: string;
  spec?: string;
  timeout?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--repo': args.repo = next(); break;
      case '--profile': args.profile = next(); break;
      case '--spec': args.spec = next(); break;
      case '--timeout': args.timeout = Number(next()); break;
      case '-h':
      case '--help': args.repo = undefined; return args;
    }
  }
  return args;
}

function usage(): void {
  console.log(
    [
      'Deterministic (Grounded) Locator Healing — CLI',
      '',
      'Required:',
      '  --repo <path>      Absolute path to the test repo to heal.',
      '  --profile <path>   Path to an EXISTING Application Profile JSON (saved crawl_data).',
      '                     Healing never crawls — crawl the app first, then pass it here.',
      '',
      'Optional:',
      '  --spec <relpath>   Single spec to run (default: whole suite).',
      '  --timeout <ms>     Per-run timeout in ms (default: 90000).',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.repo || !args.profile) {
    usage();
    process.exit(1);
  }

  const repoPath = path.resolve(args.repo);
  const profilePath = path.resolve(args.profile);

  if (!fs.existsSync(repoPath)) {
    console.error(`✗ repo not found: ${repoPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(profilePath)) {
    console.error(
      `✗ Application Profile not found: ${profilePath}\n` +
        '  Deterministic healing consumes an existing profile and never crawls.\n' +
        '  Crawl this application first, then pass the saved profile with --profile.',
    );
    process.exit(1);
  }

  // Load the STORED crawl once; ground each parsed failure against it.
  let crawlData: unknown;
  try {
    crawlData = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
  } catch (err: any) {
    console.error(`✗ could not parse profile JSON: ${err?.message}`);
    process.exit(1);
  }

  // Profile-only resolver — builds AppProfileEvidence from the saved crawl_data.
  // No network, no crawl: exactly what the worker does with its DB profile.
  const appProfile = async (failure: FailureDetails): Promise<AppProfileEvidence> =>
    groundFromProfileData(crawlData, failure);

  console.log('── Deterministic (Grounded) Locator Healing ──');
  console.log(`repo:    ${repoPath}`);
  console.log(`profile: ${profilePath}`);
  if (args.spec) console.log(`spec:    ${args.spec}`);
  console.log('');

  const pipeline = new DeterministicLocatorHealingPipeline();
  const result = await pipeline.run({
    repoPath,
    appProfile,
    testFile: args.spec,
    timeoutMs: args.timeout,
  });

  console.log('');
  for (const s of result.steps) {
    const icon = s.status === 'ok' ? '✓' : s.status === 'skipped' ? '∼' : '✗';
    console.log(`  ${icon} step ${s.step} [${s.name}] ${s.detail}`);
  }
  console.log('');
  console.log(result.summary);

  if (!result.healed && result.needsCrawl) {
    console.log(
      '\nNext step: crawl this application to build its Application Profile, then re-run this command.',
    );
  }

  process.exit(result.healed ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
