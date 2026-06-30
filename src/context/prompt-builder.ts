/**
 * Prompt Builder — converts RepositoryProfile into compact AI prompt context.
 * Used by script-gen, healing, and RCA engines to inject repo intelligence.
 * 
 * Design principle: Keep it SHORT. LLM context is expensive.
 * Only include what the AI needs to generate code that fits the repo.
 */

import type { RepositoryProfile } from './types';
import { categorizeHelpers } from './reusable-helpers';

/**
 * Build a compact context string from a RepositoryProfile for AI prompt injection.
 * Typically 500-1500 tokens — small enough to prepend to any prompt.
 */
export function buildAIPromptContext(profile: RepositoryProfile): string {
  const lines: string[] = [];

  // Core identity
  lines.push(`Framework: ${profile.framework}`);
  lines.push(`Language: ${profile.language}`);
  lines.push(`Test Pattern: ${profile.testPattern}`);
  lines.push(`Locator Strategy: ${profile.locatorStrategy}`);

  // Coding style (critical for matching repo conventions)
  const s = profile.codingStyle;
  if (s) {
    const styleParts: string[] = [];
    if (s.namingConvention) styleParts.push(`naming=${s.namingConvention}`);
    if (s.testNaming) styleParts.push(`test-naming=${s.testNaming}`);
    if (s.stepStyle) styleParts.push(`step-style=${s.stepStyle}`);
    if (s.semicolons !== undefined) styleParts.push(`semicolons=${s.semicolons}`);
    if (s.quoteStyle) styleParts.push(`quotes=${s.quoteStyle}`);
    if (s.indentStyle) styleParts.push(`indent=${s.indentStyle}`);
    if (styleParts.length > 0) {
      lines.push(`Style: ${styleParts.join(', ')}`);
    }
  }

  // Preferred locators (top 3 by count)
  const locators = profile.preferredLocators || [];
  const topLocators = [...locators].sort((a, b) => b.count - a.count).slice(0, 3);
  if (topLocators.length > 0) {
    const locStr = topLocators.map(l => `${l.pattern}(${l.count})`).join(', ');
    lines.push(`Preferred Locators: ${locStr}`);
  }

  // ---------------------------------------------------------------------------
  // REUSE-FIRST CATALOG (the money — prevents the model from reinventing code).
  // Helpers are bucketed by purpose so the right existing project method is
  // obvious for each kind of step (assert / wait / log / data / generic), and
  // generation is instructed to prefer them over new raw Playwright code.
  // ---------------------------------------------------------------------------
  const buckets = categorizeHelpers(profile);
  const fmt = (hs: Array<{ name: string; params: string; filePath: string }>) =>
    hs.map((h) => `  - ${h.name}(${h.params}) from ${h.filePath}`);
  const anyReusable =
    profile.pageObjects.length > 0 || profile.fixtures.length > 0 ||
    buckets.assertion.length > 0 || buckets.wait.length > 0 || buckets.logger.length > 0 ||
    buckets.data.length > 0 || buckets.utility.length > 0;

  if (anyReusable) {
    lines.push('');
    lines.push('=== REUSE EXISTING PROJECT CODE (HIGHEST PRIORITY) ===');
    lines.push('ALWAYS prefer calling the existing methods/helpers below over writing new raw Playwright code. Only write new low-level code when NO existing method fits.');
  }

  // Page Objects
  if (profile.pageObjects.length > 0) {
    lines.push('');
    lines.push('PAGE OBJECTS (instantiate & call these classes/methods — do NOT inline raw locators/fills):');
    for (const po of profile.pageObjects.slice(0, 8)) {
      const methods = po.methods?.slice(0, 6).map((m: any) => typeof m === 'string' ? m : m.name).join(', ') || '';
      lines.push(`  - ${po.name} from ${po.filePath}${methods ? ` [${methods}]` : ''}`);
    }
  }

  // Assertion helpers
  if (buckets.assertion.length > 0) {
    lines.push('');
    lines.push('ASSERTION HELPERS (call these instead of hand-writing expect(...) chains):');
    lines.push(...fmt(buckets.assertion));
  }

  // Wait / synchronization helpers
  if (buckets.wait.length > 0) {
    lines.push('');
    lines.push('WAIT / SYNCHRONIZATION HELPERS (call these instead of new waits or hard sleeps):');
    lines.push(...fmt(buckets.wait));
  }

  // Logger implementation
  if (buckets.loggerImpl || buckets.logger.length > 0) {
    lines.push('');
    lines.push('LOGGER (use the repo logger for progress — do NOT use console.log):');
    if (buckets.loggerImpl) lines.push(`  - import ${buckets.loggerImpl.name} from ${buckets.loggerImpl.filePath} and call it (e.g. ${buckets.loggerImpl.name}.info(...) / ${buckets.loggerImpl.name}(...))`);
    for (const h of buckets.logger) if (!buckets.loggerImpl || h.name !== buckets.loggerImpl.name) lines.push(`  - ${h.name}(${h.params}) from ${h.filePath}`);
  }

  // Test-data access patterns
  if (buckets.data.length > 0) {
    lines.push('');
    lines.push('TEST DATA ACCESS (resolve dataset values through these — do NOT hardcode credentials/data):');
    lines.push(...fmt(buckets.data));
  }

  // Fixtures
  if (profile.fixtures.length > 0) {
    lines.push('');
    lines.push('FIXTURES (consume these via the test signature instead of manual setup):');
    for (const f of profile.fixtures.slice(0, 6)) {
      lines.push(`  - ${f.name} from ${f.filePath}`);
    }
  }

  // Generic utilities
  if (buckets.utility.length > 0) {
    lines.push('');
    lines.push('UTILITY HELPERS (reuse for common operations — do NOT re-implement):');
    lines.push(...fmt(buckets.utility));
  }

  // Custom commands (Cypress)
  if (profile.customCommands.length > 0) {
    lines.push('');
    lines.push('CUSTOM COMMANDS:');
    for (const c of profile.customCommands.slice(0, 8)) {
      lines.push(`  - ${c.name} from ${c.filePath}`);
    }
  }

  // Folder structure hints
  const fs = profile.folderStructure;
  if (fs) {
    const folders: string[] = [];
    if (fs.testFolder) folders.push(`tests=${fs.testFolder}`);
    if (fs.pageObjectFolder) folders.push(`pages=${fs.pageObjectFolder}`);
    if (fs.fixtureFolder) folders.push(`fixtures=${fs.fixtureFolder}`);
    if (fs.utilsFolder) folders.push(`utils=${fs.utilsFolder}`);
    if (folders.length > 0) {
      lines.push(`Folder Layout: ${folders.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build a healing-specific context: locator preferences + POM patterns.
 * Even more compact — just what the healing AI needs.
 */
export function buildHealingContext(profile: RepositoryProfile): string {
  const lines: string[] = [];

  lines.push(`Locator Strategy: ${profile.locatorStrategy}`);

  const locators = [...(profile.preferredLocators || [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  if (locators.length > 0) {
    lines.push('Locator Preferences (by frequency):');
    for (const loc of locators) {
      lines.push(`  ${loc.pattern}: ${loc.count} uses${loc.example ? ` e.g. ${loc.example}` : ''}`);
    }
  }

  if (profile.pageObjects.length > 0) {
    lines.push('Page Objects to check for existing locators:');
    for (const po of profile.pageObjects.slice(0, 5)) {
      lines.push(`  - ${po.name} (${po.filePath})`);
    }
  }

  return lines.join('\n');
}
