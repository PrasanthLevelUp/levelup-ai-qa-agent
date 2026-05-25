/**
 * Code Patcher — Applies healing fixes to test source files.
 *
 * Handles selector replacement across Playwright, Cypress, and generic
 * test frameworks.  Preserves formatting and handles edge-cases like
 * multi-line selectors, template literals, and chained locators.
 */

import { logger } from '../utils/logger';

const MOD = 'code-patcher';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface HealingFix {
  testName: string;
  failedLocator: string;    // e.g. "#old-btn" or "page.locator('#old-btn')"
  healedLocator: string;    // e.g. "[data-testid='submit']" or "page.getByRole('button', { name: 'Submit' })"
  strategy: string;
  confidence: number;
  filePath?: string;         // optional — relative path in repo
}

export interface PatchResult {
  patched: boolean;
  originalCode: string;
  patchedCode: string;
  replacements: number;
  description: string;
}

/* -------------------------------------------------------------------------- */
/*  Code Patcher                                                              */
/* -------------------------------------------------------------------------- */

export class CodePatcher {

  /**
   * Apply a healing fix to test source code.
   * Tries multiple strategies to find and replace the broken selector.
   */
  applyHealingFix(originalCode: string, fix: HealingFix): PatchResult {
    let code = originalCode;
    let replacements = 0;
    const descriptions: string[] = [];

    // Strategy 1: Direct string replacement of the failed locator
    const directResult = this.directReplace(code, fix.failedLocator, fix.healedLocator);
    if (directResult.count > 0) {
      code = directResult.code;
      replacements += directResult.count;
      descriptions.push(`Replaced ${directResult.count} direct occurrence(s) of failed locator`);
    }

    // Strategy 2: Replace within Playwright locator calls
    if (replacements === 0) {
      const pwResult = this.playwrightLocatorReplace(code, fix.failedLocator, fix.healedLocator);
      if (pwResult.count > 0) {
        code = pwResult.code;
        replacements += pwResult.count;
        descriptions.push(`Replaced ${pwResult.count} Playwright locator call(s)`);
      }
    }

    // Strategy 3: Replace within CSS selector strings
    if (replacements === 0) {
      const cssResult = this.cssSelectorReplace(code, fix.failedLocator, fix.healedLocator);
      if (cssResult.count > 0) {
        code = cssResult.code;
        replacements += cssResult.count;
        descriptions.push(`Replaced ${cssResult.count} CSS selector reference(s)`);
      }
    }

    // Strategy 4: Fuzzy match — extract the core selector and replace
    if (replacements === 0) {
      const coreOld = this.extractCoreSelector(fix.failedLocator);
      const coreNew = this.extractCoreSelector(fix.healedLocator);
      if (coreOld && coreOld !== fix.failedLocator) {
        const fuzzyResult = this.directReplace(code, coreOld, coreNew || fix.healedLocator);
        if (fuzzyResult.count > 0) {
          code = fuzzyResult.code;
          replacements += fuzzyResult.count;
          descriptions.push(`Replaced ${fuzzyResult.count} fuzzy-matched selector(s)`);
        }
      }
    }

    // Add a comment about the healing
    if (replacements > 0) {
      const comment = `// 🤖 LevelUp AI Auto-Heal: ${fix.strategy} (${Math.round(fix.confidence * 100)}% confidence)`;
      // Add comment before the first occurrence of the healed locator
      const healedIdx = code.indexOf(fix.healedLocator);
      if (healedIdx > 0) {
        const lineStart = code.lastIndexOf('\n', healedIdx);
        if (lineStart >= 0) {
          const indent = code.substring(lineStart + 1, healedIdx).match(/^(\s*)/)?.[1] || '';
          code = code.substring(0, lineStart + 1) + indent + comment + '\n' + code.substring(lineStart + 1);
        }
      }
    }

    const patched = replacements > 0;

    logger.info(MOD, patched ? 'Fix applied successfully' : 'Could not apply fix', {
      testName: fix.testName,
      replacements,
      strategy: fix.strategy,
    });

    return {
      patched,
      originalCode,
      patchedCode: code,
      replacements,
      description: descriptions.length > 0
        ? descriptions.join('; ')
        : 'No matching selector found in source code — manual review needed',
    };
  }

  /**
   * Generate a diff-like summary of changes for PR description.
   */
  generateDiffSummary(fix: HealingFix, result: PatchResult): string {
    if (!result.patched) {
      return '⚠️ Could not automatically apply this fix. Manual review needed.';
    }

    return [
      `### Selector Change`,
      '```diff',
      `- ${fix.failedLocator}`,
      `+ ${fix.healedLocator}`,
      '```',
      '',
      `**Strategy:** ${fix.strategy}`,
      `**Confidence:** ${Math.round(fix.confidence * 100)}%`,
      `**Replacements:** ${result.replacements}`,
      `**Details:** ${result.description}`,
    ].join('\n');
  }

  /* ── Private helpers ─────────────────────────────────────── */

  private directReplace(code: string, oldStr: string, newStr: string): { code: string; count: number } {
    if (!oldStr || !code.includes(oldStr)) {
      return { code, count: 0 };
    }
    const count = code.split(oldStr).length - 1;
    return { code: code.split(oldStr).join(newStr), count };
  }

  /**
   * Replace selectors within Playwright-style locator calls:
   *   page.locator('old') → page.locator('new')
   *   page.click('old')   → page.click('new')
   *   page.$('old')       → page.$('new')
   */
  private playwrightLocatorReplace(
    code: string,
    oldSelector: string,
    newSelector: string,
  ): { code: string; count: number } {
    // Extract bare selector from things like page.locator('#foo')
    const bareOld = this.extractCoreSelector(oldSelector) || oldSelector;
    const bareNew = this.extractCoreSelector(newSelector) || newSelector;

    // Pattern: page.locator('...'), page.click('...'), page.$('...')
    const patterns = [
      // Single-quoted
      new RegExp(`((?:page|frame|locator)\\.[a-zA-Z$]+\\(')${this.escapeRegex(bareOld)}('\\))`, 'g'),
      // Double-quoted
      new RegExp(`((?:page|frame|locator)\\.[a-zA-Z$]+\\(")${this.escapeRegex(bareOld)}("\\))`, 'g'),
      // Template literal
      new RegExp(`((?:page|frame|locator)\\.[a-zA-Z$]+\\(\`)${this.escapeRegex(bareOld)}(\`\\))`, 'g'),
    ];

    let count = 0;
    let result = code;

    for (const pattern of patterns) {
      const matches = result.match(pattern);
      if (matches) {
        count += matches.length;
        result = result.replace(pattern, `$1${bareNew}$2`);
      }
    }

    return { code: result, count };
  }

  /**
   * Replace CSS selectors that appear as string values:
   *   '#old-selector'  → '[data-testid="new"]'
   *   ".old-class"     → "[data-testid='new']"
   */
  private cssSelectorReplace(
    code: string,
    oldSelector: string,
    newSelector: string,
  ): { code: string; count: number } {
    const bareOld = this.extractCoreSelector(oldSelector) || oldSelector;
    const bareNew = this.extractCoreSelector(newSelector) || newSelector;

    // Only try this if it looks like a CSS selector
    if (!bareOld.match(/^[#.\[]/)) {
      return { code, count: 0 };
    }

    let count = 0;
    let result = code;

    // Replace within quotes
    for (const q of ["'", '"', '`']) {
      const escaped = this.escapeRegex(bareOld);
      const pattern = new RegExp(`${q}${escaped}${q}`, 'g');
      const matches = result.match(pattern);
      if (matches) {
        count += matches.length;
        result = result.replace(pattern, `${q}${bareNew}${q}`);
      }
    }

    return { code: result, count };
  }

  /**
   * Extract the core CSS/selector string from a Playwright expression.
   * e.g. "page.locator('#submit-btn')" → "#submit-btn"
   * e.g. "#submit-btn" → "#submit-btn" (unchanged)
   */
  private extractCoreSelector(expr: string): string | null {
    if (!expr) return null;

    // Already a bare selector?
    if (expr.match(/^[#.\[]/)) return expr;

    // page.locator('...'), page.click('...'), etc.
    const match = expr.match(/\.\w+\(\s*['"`](.+?)['"`]\s*\)/);
    if (match) return match[1];

    // page.getByRole('button', { name: 'Submit' }) — keep as-is
    if (expr.includes('getBy')) return null;

    return null;
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
