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

    // The text we actually insert (may differ from fix.healedLocator after
    // kind-normalisation below) — used later to anchor the heal comment.
    let insertedText = fix.healedLocator;

    // Strategy 1: Direct string replacement of the failed locator.
    //
    // CRITICAL kind-safety: the replacement MUST match the syntactic kind of
    // the text being matched. A *bare* selector ("#username") lives inside a
    // quote slot — e.g. this.page.locator('#username') — so it must be replaced
    // by another *bare* selector. If the healed locator is a full expression
    // (page.locator('...'), getByRole(...)), substituting it raw produces
    //   this.page.locator('page.locator('[data-test="username"]')')
    // i.e. nested calls + unbalanced quotes → invalid TS → spec_load_error.
    // (Strategies 2-4 already extract core selectors; only Strategy 1 was raw.)
    const failedIsExpr = this.isLocatorExpression(fix.failedLocator);
    const healedIsExpr = this.isLocatorExpression(fix.healedLocator);
    let directOld = fix.failedLocator;
    let directNew = fix.healedLocator;
    if (!failedIsExpr) {
      // Matched text is a bare selector → replacement must be a bare selector.
      directNew = this.extractCoreSelector(fix.healedLocator) || fix.healedLocator;
    } else if (failedIsExpr && !healedIsExpr) {
      // Matched text is a full expression but the heal is a bare selector;
      // a raw swap would drop the call wrapper. Skip the raw direct replace and
      // let the kind-aware Playwright/CSS strategies handle it correctly.
      directOld = '';
    }
    const directResult = this.directReplace(code, directOld, directNew);
    if (directResult.count > 0) {
      code = directResult.code;
      replacements += directResult.count;
      insertedText = directNew;
      descriptions.push(`Replaced ${directResult.count} direct occurrence(s) of failed locator`);
    }

    // Strategy 2: Replace within Playwright locator calls
    if (replacements === 0) {
      const pwResult = this.playwrightLocatorReplace(code, fix.failedLocator, fix.healedLocator);
      if (pwResult.count > 0) {
        code = pwResult.code;
        replacements += pwResult.count;
        insertedText = this.extractCoreSelector(fix.healedLocator) || fix.healedLocator;
        descriptions.push(`Replaced ${pwResult.count} Playwright locator call(s)`);
      }
    }

    // Strategy 3: Replace within CSS selector strings
    if (replacements === 0) {
      const cssResult = this.cssSelectorReplace(code, fix.failedLocator, fix.healedLocator);
      if (cssResult.count > 0) {
        code = cssResult.code;
        replacements += cssResult.count;
        insertedText = this.extractCoreSelector(fix.healedLocator) || fix.healedLocator;
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
          insertedText = coreNew || fix.healedLocator;
          descriptions.push(`Replaced ${fuzzyResult.count} fuzzy-matched selector(s)`);
        }
      }
    }

    // Safety net (defense-in-depth): never emit code where a locator EXPRESSION
    // got embedded inside a selector STRING (the double-wrap that caused the
    // production spec_load_error). If a patch would introduce this corruption
    // and the original didn't have it, reject the patch entirely rather than
    // commit invalid code that breaks every spec import.
    if (
      replacements > 0 &&
      this.hasEmbeddedExpressionCorruption(code) &&
      !this.hasEmbeddedExpressionCorruption(originalCode)
    ) {
      logger.warn(MOD, 'Rejected patch — would embed a locator expression inside a selector string', {
        testName: fix.testName,
        failedLocator: fix.failedLocator,
        healedLocator: fix.healedLocator,
      });
      return {
        patched: false,
        originalCode,
        patchedCode: originalCode,
        replacements: 0,
        description:
          'Patch rejected: applying the healed locator would produce invalid code ' +
          '(a locator expression embedded inside a selector string). Manual review needed.',
      };
    }

    // Add a comment about the healing
    if (replacements > 0) {
      const comment = `// 🤖 LevelUp AI Auto-Heal: ${fix.strategy} (${Math.round(fix.confidence * 100)}% confidence)`;
      // Anchor the comment to the text we ACTUALLY inserted (kind-normalised),
      // not fix.healedLocator which may differ after normalisation.
      const healedIdx = code.indexOf(insertedText);
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

  /**
   * Is this a full locator EXPRESSION (e.g. page.locator('#x'),
   * frame.getByRole(...)) as opposed to a bare selector string ("#x")?
   * A bare selector lives inside a quote slot; an expression does not.
   */
  private isLocatorExpression(expr: string): boolean {
    if (!expr) return false;
    // A method call like .locator( / .getByRole( / .click( means it's an
    // expression. A bare selector ("#username", "[data-test=x]", ".foo") has
    // no such call.
    return /\.\s*\w+\s*\(/.test(expr);
  }

  /**
   * Detect the specific corruption that broke production: a locator EXPRESSION
   * embedded inside a selector STRING argument, e.g.
   *   this.page.locator('page.locator('[data-test="username"]')')
   *   page.locator("getByRole('button')")
   * A selector string must never contain page./frame./locator./this. + a call,
   * nor a getBy* call. This is dependency-free (no TypeScript at runtime).
   */
  private hasEmbeddedExpressionCorruption(code: string): boolean {
    // .<method>( '<...>  page|frame|locator|this . <method> (
    const nestedCall =
      /\.\s*\w+\s*\(\s*['"`][^'"`]*\b(?:page|frame|locator|this)\s*\.\s*\w+\s*\(/;
    // .<method>( '<...> getByRole( / getByTestId( ...
    const nestedGetBy = /\.\s*\w+\s*\(\s*['"`][^'"`]*\bgetBy\w*\s*\(/;
    return nestedCall.test(code) || nestedGetBy.test(code);
  }
}
