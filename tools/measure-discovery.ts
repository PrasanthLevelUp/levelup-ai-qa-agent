/* eslint-disable no-console */
/**
 * DISCOVERY MEASUREMENT — "Is Candidate Discovery finding real reusable assets?"
 * =============================================================================
 * NOT a unit test. Drives the SAME production modules the engine uses:
 *   RepositoryContextEngine.scan → buildReuseCatalogue → discoverCandidates →
 *   rankReport, against the REAL SauceDemo repo, over the REAL business steps
 *   taken from its spec files.
 *
 * It answers the one question to ask before building Selection (PR 2C):
 *   • Did discovery find reusable assets, or is everything a DOM locator?
 *   • For how many steps is the rank-#1 candidate a reuse candidate?
 *
 * Prints a per-step table + an overall distribution. SauceDemo only (the one
 * benchmark app cloned locally) — reported honestly, not extrapolated.
 *
 * Run:  npx ts-node tools/measure-discovery.ts
 */
import * as path from 'path';
import { RepositoryContextEngine } from '../src/context/repository-context-engine';
import { buildReuseCatalogue } from '../src/intelligence/project-convention-profile';
import { discoverCandidates, rankReport, type DiscoveryContext } from '../src/script-gen/candidate-discovery';

const REPO = process.env.SAUCEDEMO_REPO || '/home/ubuntu/github_repos/LevelUpAI_SauceDemo';

// Real business steps, lifted from the SauceDemo spec files (login + checkout
// journeys). These are the kind of steps the engine actually receives.
const STEPS: string[] = [
  'Navigate to the login page',
  'Login with valid standard user credentials',
  'Verify the inventory page is loaded',
  'Add a product to the cart',
  'Open the shopping cart',
  'Click checkout',
  'Enter checkout details',
  'Complete the order',
  'Verify the order success message',
  'Verify login fails with an invalid username',
  'Verify the cart icon is visible after login',
  'Navigate to the inventory page after successful login',
];

function main(): void {
  console.log('DISCOVERY MEASUREMENT — SauceDemo\n' + '='.repeat(60));

  const { profile, durationMs } = new RepositoryContextEngine().scan(REPO);
  const cat = buildReuseCatalogue(profile);
  console.log(
    `Repo scanned in ${durationMs}ms — ` +
      `pageObjects:${cat.pageObjects.length} helpers:${cat.helpers.length} ` +
      `fixtures:${cat.fixtures.length} components:${cat.components.length}`,
  );

  const ctx: DiscoveryContext = {
    pageObjects: cat.pageObjects.map((p) => ({ name: p.name, methods: p.methods, path: p.path })),
    helpers: cat.helpers.map((h) => ({ name: h.name, functions: h.functions, path: h.path })),
    fixtures: cat.fixtures.map((f) => ({ name: f.name, path: f.path })),
    components: cat.components.map((c) => ({ name: c.name, path: c.path })),
  };

  const report = rankReport(discoverCandidates(STEPS, ctx));

  const typeCounts: Record<string, number> = {};
  let stepsWithReuse = 0;
  let rank1Reuse = 0;
  let stepsWithAnyCandidate = 0;

  console.log('\nPER-STEP TOP CANDIDATE');
  console.log('-'.repeat(60));
  for (const s of report.steps) {
    const top = s.candidates[0];
    if (s.candidates.length) stepsWithAnyCandidate++;
    if (s.candidates.some((c) => c.reuse)) stepsWithReuse++;
    if (top?.reuse) rank1Reuse++;
    for (const c of s.candidates) typeCounts[c.type] = (typeCounts[c.type] ?? 0) + 1;

    const label = top ? `${top.type} (${top.confidence}) → ${top.source}` : '— none —';
    console.log(`• ${s.step}\n    #1: ${label}`);
  }

  console.log('\nCANDIDATE-TYPE DISTRIBUTION (all candidates)');
  console.log('-'.repeat(60));
  const total = report.totalCandidates || 1;
  for (const [type, n] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    const pct = ((n / total) * 100).toFixed(0);
    console.log(`  ${type.padEnd(24)} ${String(n).padStart(3)}  ${pct}%`);
  }

  const nSteps = report.steps.length || 1;
  console.log('\nHEADLINE');
  console.log('-'.repeat(60));
  console.log(`  Steps with ANY candidate:      ${stepsWithAnyCandidate}/${report.steps.length}`);
  console.log(`  Steps with a REUSE candidate:  ${stepsWithReuse}/${report.steps.length}`);
  console.log(
    `  Steps whose #1 is REUSE:       ${rank1Reuse}/${report.steps.length} ` +
      `(${((rank1Reuse / nSteps) * 100).toFixed(0)}%)`,
  );
  console.log(`  Total candidates discovered:   ${report.totalCandidates}`);
  console.log(
    '\nReading: high reuse-at-#1 = Ranking is choosing from good candidates → Selection (2C) is safe.\n' +
      'Low reuse-at-#1 (mostly DOM locators) = Discovery needs work before Selection matters.',
  );
}

main();
