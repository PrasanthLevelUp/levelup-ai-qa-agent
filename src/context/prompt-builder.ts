/**
 * Prompt Builder — converts RepositoryProfile into compact AI prompt context.
 * Used by script-gen, healing, and RCA engines to inject repo intelligence.
 * 
 * Design principle: Keep it SHORT. LLM context is expensive.
 * Only include what the AI needs to generate code that fits the repo.
 */

import type { RepositoryProfile } from './types';

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

  // Reusable helpers (the money — prevents AI from reinventing)
  if (profile.helperFunctions.length > 0) {
    lines.push('');
    lines.push('REUSABLE HELPERS (import these, do NOT rewrite):');
    for (const h of profile.helperFunctions.slice(0, 12)) {
      const params = h.parameters?.join(', ') || '';
      lines.push(`  - ${h.name}(${params}) from ${h.filePath}`);
    }
  }

  // Page Objects
  if (profile.pageObjects.length > 0) {
    lines.push('');
    lines.push('PAGE OBJECTS (use these classes):');
    for (const po of profile.pageObjects.slice(0, 8)) {
      const methods = po.methods?.slice(0, 5).join(', ') || '';
      lines.push(`  - ${po.name} from ${po.filePath}${methods ? ` [${methods}]` : ''}`);
    }
  }

  // Fixtures
  if (profile.fixtures.length > 0) {
    lines.push('');
    lines.push('FIXTURES:');
    for (const f of profile.fixtures.slice(0, 6)) {
      lines.push(`  - ${f.name} from ${f.filePath}`);
    }
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
