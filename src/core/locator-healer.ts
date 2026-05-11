/**
 * Locator Healer — 3-tier self-healing engine.
 *
 * Level 1: Rule-based locator alternatives (0 AI tokens)
 * Level 2: Database pattern matching (0 AI tokens)
 * Level 3: OpenAI reasoning (minimal tokens — handled externally)
 *
 * CLI: ts-node src/core/locator-healer.ts rule <failure-context.json>
 *      ts-node src/core/locator-healer.ts db-lookup <failure-context.json>
 *      ts-node src/core/locator-healer.ts apply <fix-spec.json> <test-file>
 */

import * as fs from 'fs';
import { logger } from '../utils/logger';
import { lookupPattern, storePattern, incrementPatternFailure } from '../db/postgres';
import type { FailureContext } from './failure-analyzer';

const MOD = 'locator-healer';

// ─── Types ─────────────────────────────────────────────────────

export interface HealSuggestion {
  newLocator: string;
  strategy: 'rule_based' | 'database_pattern' | 'ai_reasoning';
  confidence: number;
  aiTokensUsed: number;
  reasoning?: string;
}

export interface RuleHealResult {
  failedLocator: string;
  alternatives: HealSuggestion[];
  isTimingIssue: boolean;
  addWait: boolean;
}

// ─── Rule-Based Healing (Level 1) ──────────────────────────────

const SEMANTIC_RULES: Array<{
  match: RegExp;
  alternatives: Array<{ locator: string; confidence: number }>;
}> = [
  {
    match: /button.*submit|submit.*button|#login|\.login-btn|#loginBtn/i,
    alternatives: [
      { locator: `page.getByRole('button', { name: /login|sign in|submit/i })`, confidence: 0.9 },
      { locator: `page.locator('button[type="submit"]')`, confidence: 0.85 },
      { locator: `page.locator('.oxd-button--main')`, confidence: 0.7 },
      { locator: `page.locator('button.oxd-button')`, confidence: 0.65 },
    ],
  },
  {
    match: /input.*username|username.*input|#username|name="username"/i,
    alternatives: [
      { locator: `page.getByPlaceholder('Username')`, confidence: 0.9 },
      { locator: `page.locator('input[name="username"]')`, confidence: 0.85 },
      { locator: `page.getByLabel('Username')`, confidence: 0.8 },
    ],
  },
  {
    match: /input.*password|password.*input|#password|name="password"|type="password"/i,
    alternatives: [
      { locator: `page.getByPlaceholder('Password')`, confidence: 0.9 },
      { locator: `page.locator('input[type="password"]')`, confidence: 0.85 },
      { locator: `page.getByLabel('Password')`, confidence: 0.8 },
    ],
  },
  {
    match: /dashboard|h6.*dashboard|\.breadcrumb/i,
    alternatives: [
      { locator: `page.getByRole('heading', { name: 'Dashboard' })`, confidence: 0.9 },
      { locator: `page.getByText('Dashboard')`, confidence: 0.8 },
      { locator: `page.locator('.oxd-topbar-header-breadcrumb')`, confidence: 0.7 },
    ],
  },
  {
    match: /\.oxd-input|input\[class/i,
    alternatives: [
      { locator: `page.getByRole('textbox')`, confidence: 0.6 },
    ],
  },
];

export function ruleBasedHeal(failure: FailureContext): RuleHealResult {
  const failedLocator = failure.failedLocator ?? '';
  const errorMsg = failure.errorMessage;
  const searchText = `${failedLocator} ${errorMsg}`;

  const alternatives: HealSuggestion[] = [];

  for (const rule of SEMANTIC_RULES) {
    if (rule.match.test(searchText)) {
      for (const alt of rule.alternatives) {
        // Skip if it's identical to the failed locator
        if (alt.locator.includes(failedLocator)) continue;
        alternatives.push({
          newLocator: alt.locator,
          strategy: 'rule_based',
          confidence: alt.confidence,
          aiTokensUsed: 0,
        });
      }
    }
  }

  // Generic: convert CSS ID selector to getByTestId
  if (/^#[\w-]+$/.test(failedLocator)) {
    const id = failedLocator.slice(1);
    alternatives.push({
      newLocator: `page.getByTestId('${id}')`,
      strategy: 'rule_based',
      confidence: 0.5,
      aiTokensUsed: 0,
    });
  }

  // Sort by confidence descending
  alternatives.sort((a, b) => b.confidence - a.confidence);

  const addWait = failure.isTimingIssue;

  logger.info(MOD, `Rule-based: ${alternatives.length} alternatives for "${failedLocator}"`, {
    isTimingIssue: failure.isTimingIssue,
  });

  return {
    failedLocator,
    alternatives: alternatives.slice(0, 6),
    isTimingIssue: failure.isTimingIssue,
    addWait,
  };
}

// ─── Database Pattern Matching (Level 2) ───────────────────────

export async function dbPatternHeal(failure: FailureContext): Promise<HealSuggestion | null> {
  const failedLocator = failure.failedLocator ?? '';
  if (!failedLocator) return null;

  const pattern = await lookupPattern(failedLocator, failure.errorMessage.slice(0, 200));
  if (!pattern) return null;

  logger.info(MOD, `DB pattern match: "${failedLocator}" → "${pattern.healed_locator}" (${pattern.success_count}x)`);

  return {
    newLocator: pattern.healed_locator,
    strategy: 'database_pattern',
    confidence: pattern.confidence,
    aiTokensUsed: 0,
    reasoning: `Previously successful ${pattern.success_count} time(s)`,
  };
}

// ─── Apply Fix ─────────────────────────────────────────────────

export function applyFix(
  testFilePath: string,
  oldLocator: string,
  newLocator: string,
  addWait: boolean = false
): boolean {
  if (!fs.existsSync(testFilePath)) {
    logger.error(MOD, `Test file not found: ${testFilePath}`);
    return false;
  }

  let content = fs.readFileSync(testFilePath, 'utf-8');

  if (!content.includes(oldLocator)) {
    logger.warn(MOD, `Old locator not found in file: "${oldLocator}"`);
    return false;
  }

  content = content.replace(oldLocator, newLocator);

  // Add networkidle wait after goto if timing issue
  if (addWait && !content.includes("waitForLoadState('networkidle')")) {
    content = content.replace(
      /(await page\.goto\([^)]+\);)/,
      `$1\n  await page.waitForLoadState('networkidle');`
    );
  }

  fs.writeFileSync(testFilePath, content, 'utf-8');
  logger.info(MOD, `Applied fix: "${oldLocator}" → "${newLocator}" in ${testFilePath}`);
  return true;
}

// ─── Store Successful Pattern ──────────────────────────────────

export async function storeSuccessfulPattern(
  failedLocator: string,
  healedLocator: string,
  strategy: string,
  errorPattern: string,
  siteUrl: string,
  tokensSaved: number = 0
): Promise<void> {
  await storePattern({
    error_pattern: errorPattern.slice(0, 200),
    site_url: siteUrl,
    failed_locator: failedLocator,
    healed_locator: healedLocator,
    solution_strategy: strategy,
    avg_tokens_saved: tokensSaved,
  });
}

export async function markPatternFailed(failedLocator: string, siteUrl: string): Promise<void> {
  await incrementPatternFailure(failedLocator, siteUrl);
}

// ─── CLI ───────────────────────────────────────────────────────

if (require.main === module) {
  const cmd = process.argv[2];

  (async () => {
    try {
      if (cmd === 'rule' && process.argv[3]) {
        const ctx: FailureContext = JSON.parse(fs.readFileSync(process.argv[3], 'utf-8'));
        const result = ruleBasedHeal(ctx);
        const outPath = '/tmp/rule_heal_result.json';
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));

      } else if (cmd === 'db-lookup' && process.argv[3]) {
        const ctx: FailureContext = JSON.parse(fs.readFileSync(process.argv[3], 'utf-8'));
        const result = await dbPatternHeal(ctx);
        const outPath = '/tmp/db_heal_result.json';
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));

      } else if (cmd === 'apply' && process.argv[3] && process.argv[4]) {
        const spec = JSON.parse(fs.readFileSync(process.argv[3], 'utf-8'));
        const ok = applyFix(process.argv[4], spec.oldLocator, spec.newLocator, spec.addWait ?? false);
        console.log(JSON.stringify({ success: ok }));

      } else {
        console.log('Usage:');
        console.log('  locator-healer.ts rule <failure-context.json>');
        console.log('  locator-healer.ts db-lookup <failure-context.json>');
        console.log('  locator-healer.ts apply <fix-spec.json> <test-file>');
      }
    } catch (e) {
      console.error(e);
      process.exit(1);
    } finally {
      const { closePool } = await import('../db/postgres');
      await closePool();
    }
  })();
}
