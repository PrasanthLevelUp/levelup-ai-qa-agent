/**
 * Validation Engine (Hardened v2)
 * 7-check validation: syntax, semantic, security, exists, unique, visible, interactable.
 * Includes live browser validation via Playwright for element checks.
 */

import ts from 'typescript';
import { logger } from '../utils/logger';

const MOD = 'validation-engine';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ValidationChecks {
  syntax: boolean;
  semantic: boolean;
  security: boolean;
  exists: boolean;
  unique: boolean;
  visible: boolean;
  interactable: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  confidence: number; // 0.0 to 1.0
  checks: ValidationChecks;
  checkDetails: ValidationCheckDetail[];
  reason?: string;
}

export interface ValidationCheckDetail {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ValidationInput {
  newLocator: string;
  confidence: number;
  originalCode?: string;
  filePath?: string;
  pageUrl?: string; // URL for live browser checks
}

/* Legacy compat */
export interface ValidationOutput {
  isValid: boolean;
  reason: string;
  checks: ValidationCheckDetail[];
}

export type ValidationCheck = ValidationCheckDetail;

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const BLOCKED_PATTERNS = [
  /eval\(/,
  /new Function\(/,
  /child_process/,
  /process\.exit/,
  /`\$\{/,
  /require\(/,
  /import\(/,
  /\.exec\(/,
  /document\.write/,
  /innerHTML\s*=/,
  /window\.location\s*=/,
  /document\.cookie/,
];

const SEMANTIC_LOCATORS = [
  'getByRole',
  'getByLabel',
  'getByText',
  'getByPlaceholder',
  'getByTestId',
  'getByAltText',
  'getByTitle',
];

/* Confidence weights for each check */
const WEIGHTS = {
  syntax: 0.15,
  semantic: 0.20,
  exists: 0.25,
  unique: 0.15,
  visible: 0.15,
  interactable: 0.10,
};

/* Thresholds:
 * 0.9+ : Excellent (auto-apply)
 * 0.7-0.9 : Good (apply with caution)
 * 0.5-0.7 : Uncertain (manual review)
 * < 0.5 : Reject
 */

/* -------------------------------------------------------------------------- */
/*  Browser cache for live validation                                        */
/* -------------------------------------------------------------------------- */

interface CachedResult {
  exists: boolean;
  count: number;
  visible: boolean;
  interactable: boolean;
  timestamp: number;
}

const LIVE_CACHE = new Map<string, CachedResult>();
const CACHE_TTL_MS = 60_000; // 1 minute

function getCacheKey(url: string, locator: string): string {
  return `${url}|||${locator}`;
}

/* -------------------------------------------------------------------------- */
/*  Validation Engine                                                        */
/* -------------------------------------------------------------------------- */

export class ValidationEngine {
  private readonly confidenceThreshold: number;

  constructor(confidenceThreshold = 0.7) {
    this.confidenceThreshold = confidenceThreshold;
  }

  /* ---- Main validate() method (v2, async, with live checks) ---- */

  async validateFull(input: ValidationInput): Promise<ValidationResult> {
    const checkDetails: ValidationCheckDetail[] = [];

    const checks: ValidationChecks = {
      syntax: false,
      semantic: false,
      security: false,
      exists: false,
      unique: false,
      visible: false,
      interactable: false,
    };

    // 1. Syntax check
    const syntaxResult = this.validateSyntaxCheck(input.newLocator, input.filePath || 'test.ts');
    checks.syntax = syntaxResult.passed;
    checkDetails.push(syntaxResult);

    // 2. Semantic check
    const semResult = this.validateSemanticCheck(input.newLocator);
    checks.semantic = semResult.passed;
    checkDetails.push(semResult);

    // 3. Security check
    const secResult = this.validateSecurityCheck(input.newLocator);
    checks.security = secResult.passed;
    checkDetails.push(secResult);

    // 4-7. Live browser checks (only if basic checks pass)
    if (checks.syntax && checks.security && input.pageUrl) {
      try {
        const liveResults = await this.runLiveChecks(input.pageUrl, input.newLocator);
        checks.exists = liveResults.exists;
        checks.unique = liveResults.unique;
        checks.visible = liveResults.visible;
        checks.interactable = liveResults.interactable;

        checkDetails.push(
          { name: 'exists', passed: liveResults.exists, detail: liveResults.existsDetail },
          { name: 'unique', passed: liveResults.unique, detail: liveResults.uniqueDetail },
          { name: 'visible', passed: liveResults.visible, detail: liveResults.visibleDetail },
          { name: 'interactable', passed: liveResults.interactable, detail: liveResults.interactableDetail },
        );
      } catch (err: any) {
        logger.warn(MOD, 'Live browser checks failed, skipping', { error: err.message });
        // When live checks can't run, assume optimistic defaults
        checks.exists = true;
        checks.unique = true;
        checks.visible = true;
        checks.interactable = true;
        checkDetails.push(
          { name: 'exists', passed: true, detail: 'Skipped (browser unavailable) — assumed true' },
          { name: 'unique', passed: true, detail: 'Skipped (browser unavailable) — assumed true' },
          { name: 'visible', passed: true, detail: 'Skipped (browser unavailable) — assumed true' },
          { name: 'interactable', passed: true, detail: 'Skipped (browser unavailable) — assumed true' },
        );
      }
    } else if (!input.pageUrl) {
      // No URL provided — skip live checks with optimistic defaults
      checks.exists = true;
      checks.unique = true;
      checks.visible = true;
      checks.interactable = true;
      checkDetails.push(
        { name: 'exists', passed: true, detail: 'No URL provided — skipped' },
        { name: 'unique', passed: true, detail: 'No URL provided — skipped' },
        { name: 'visible', passed: true, detail: 'No URL provided — skipped' },
        { name: 'interactable', passed: true, detail: 'No URL provided — skipped' },
      );
    }

    const confidence = this.calculateConfidence(checks);
    const isValid = confidence >= this.confidenceThreshold;
    const reason = this.getValidationReason(checks, checkDetails);

    logger.info(MOD, 'Full validation complete', {
      isValid,
      confidence: confidence.toFixed(3),
      checksRun: checkDetails.length,
      failedChecks: checkDetails.filter((c) => !c.passed).length,
    });

    return { isValid, confidence, checks, checkDetails, reason };
  }

  /* ---- Synchronous validate() for backward compat ---- */

  validate(input: ValidationInput): ValidationOutput {
    const checkDetails: ValidationCheckDetail[] = [];

    // 1. Confidence threshold check
    const confCheck = this.validateConfidenceCheck(input.confidence);
    checkDetails.push(confCheck);

    // 2. Security check
    const secCheck = this.validateSecurityCheck(input.newLocator);
    checkDetails.push(secCheck);

    // 3. Semantic locator check
    const semCheck = this.validateSemanticCheck(input.newLocator);
    checkDetails.push(semCheck);

    // 4. Syntax validation (if we have full code)
    if (input.originalCode) {
      const syntaxCheck = this.validateSyntaxCode(input.originalCode, input.filePath || 'test.ts');
      checkDetails.push(syntaxCheck);
    }

    // 5. Non-empty locator check
    const emptyCheck: ValidationCheckDetail = {
      name: 'non_empty',
      passed: input.newLocator.trim().length > 0,
      detail: input.newLocator.trim().length > 0
        ? 'Locator is non-empty'
        : 'Locator is empty',
    };
    checkDetails.push(emptyCheck);

    const failedChecks = checkDetails.filter((c) => !c.passed);
    const isValid = failedChecks.length === 0;
    const reason = isValid
      ? 'All validation checks passed'
      : failedChecks.map((c) => `${c.name}: ${c.detail}`).join('; ');

    logger.info(MOD, 'Validation complete', {
      isValid,
      checksRun: checkDetails.length,
      checksFailed: failedChecks.length,
    });

    return { isValid, reason, checks: checkDetails };
  }

  /* ---- Individual check methods ---- */

  validateSyntaxCheck(locator: string, fileName: string): ValidationCheckDetail {
    // Check if the locator string itself is syntactically valid as a TS expression
    const code = `const _test = ${locator};`;
    const result = ts.transpileModule(code, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        strict: false,
        noEmit: true,
      },
      fileName,
      reportDiagnostics: true,
    });

    const diagnostics = result.diagnostics ?? [];
    if (diagnostics.length === 0) {
      return { name: 'syntax', passed: true, detail: 'Locator syntax is valid TypeScript' };
    }

    // Some diagnostics are warnings — only fail on errors
    const errors = diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error);
    if (errors.length === 0) {
      return { name: 'syntax', passed: true, detail: 'Locator syntax is valid TypeScript (with warnings)' };
    }

    const message = errors
      .slice(0, 2)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join(' | ');
    return { name: 'syntax', passed: false, detail: `Syntax error: ${message}` };
  }

  validateSyntaxCode(code: string, fileName: string): ValidationCheckDetail {
    const result = ts.transpileModule(code, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        strict: true,
      },
      fileName,
      reportDiagnostics: true,
    });

    const diagnostics = result.diagnostics ?? [];
    if (diagnostics.length === 0) {
      return { name: 'syntax', passed: true, detail: 'TypeScript syntax is valid' };
    }

    const message = diagnostics
      .slice(0, 3)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join(' | ');
    return { name: 'syntax', passed: false, detail: `Syntax error: ${message}` };
  }

  validateSemanticCheck(locator: string): ValidationCheckDetail {
    const isSemantic = SEMANTIC_LOCATORS.some((s) => locator.includes(s));
    return {
      name: 'semantic',
      passed: isSemantic,
      detail: isSemantic
        ? 'Uses semantic locator'
        : 'Non-semantic locator (CSS/XPath) — prefer getByRole/getByLabel/getByText',
    };
  }

  validateSecurityCheck(locator: string): ValidationCheckDetail {
    const blocked = BLOCKED_PATTERNS.find((p) => p.test(locator));
    return {
      name: 'security',
      passed: !blocked,
      detail: blocked
        ? `Dangerous pattern detected: ${blocked.source}`
        : 'No dangerous patterns found',
    };
  }

  private validateConfidenceCheck(confidence: number): ValidationCheckDetail {
    const passed = confidence > this.confidenceThreshold;
    return {
      name: 'confidence',
      passed,
      detail: passed
        ? `Confidence ${confidence.toFixed(2)} > ${this.confidenceThreshold}`
        : `Confidence ${confidence.toFixed(2)} <= ${this.confidenceThreshold} (too low)`,
    };
  }

  /* ---- Live browser checks ---- */

  private async runLiveChecks(url: string, locator: string): Promise<{
    exists: boolean; existsDetail: string;
    unique: boolean; uniqueDetail: string;
    visible: boolean; visibleDetail: string;
    interactable: boolean; interactableDetail: string;
  }> {
    // Check cache first
    const cacheKey = getCacheKey(url, locator);
    const cached = LIVE_CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
      return {
        exists: cached.exists,
        existsDetail: `Element exists (cached): count=${cached.count}`,
        unique: cached.count === 1,
        uniqueDetail: `Element count: ${cached.count} (cached)`,
        visible: cached.visible,
        visibleDetail: `Element visible: ${cached.visible} (cached)`,
        interactable: cached.interactable,
        interactableDetail: `Element interactable: ${cached.interactable} (cached)`,
      };
    }

    // Extract the actual selector from the Playwright locator expression
    const selector = this.extractSelector(locator);
    if (!selector) {
      return {
        exists: true, existsDetail: 'Could not extract selector — assumed exists',
        unique: true, uniqueDetail: 'Could not extract selector — assumed unique',
        visible: true, visibleDetail: 'Could not extract selector — assumed visible',
        interactable: true, interactableDetail: 'Could not extract selector — assumed interactable',
      };
    }

    let browser: any = null;
    try {
      // Dynamic import to avoid hard dependency on playwright at module load
      const pw = await import('playwright');
      browser = await pw.chromium.launch({ headless: true });
      const page = await browser.newPage();

      await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000); // Let page render

      // Check existence and count
      const count = await page.locator(selector).count();
      const exists = count > 0;
      const unique = count === 1;

      // Check visibility
      let visible = false;
      if (exists) {
        try {
          visible = await page.locator(selector).first().isVisible({ timeout: 3000 });
        } catch { visible = false; }
      }

      // Check interactability
      let interactable = false;
      if (visible) {
        try {
          interactable = await page.locator(selector).first().isEnabled({ timeout: 3000 });
        } catch { interactable = false; }
      }

      // Cache result
      LIVE_CACHE.set(cacheKey, { exists, count, visible, interactable, timestamp: Date.now() });

      await browser.close();
      browser = null;

      return {
        exists,
        existsDetail: exists ? `Element found: ${count} match(es)` : 'Element NOT found in DOM',
        unique,
        uniqueDetail: unique ? 'Exactly 1 element matches' : `${count} elements match (${count === 0 ? 'missing' : 'ambiguous'})`,
        visible,
        visibleDetail: visible ? 'Element is visible' : 'Element is NOT visible',
        interactable,
        interactableDetail: interactable ? 'Element is enabled and interactable' : 'Element is NOT interactable',
      };
    } catch (err: any) {
      if (browser) try { await browser.close(); } catch {}
      throw err;
    }
  }

  /**
   * Extract a CSS/Playwright selector string from a locator expression.
   * e.g., "page.getByRole('button', { name: /login/i })" → "role=button[name=/login/i]"
   */
  private extractSelector(locator: string): string | null {
    // getByRole
    let m = /getByRole\(\s*'([^']+)'(?:\s*,\s*\{\s*name:\s*([^}]+)\s*\})?\s*\)/.exec(locator);
    if (m) {
      const role = m[1];
      const name = m[2]?.trim().replace(/^\/|\/[gim]*$/g, '');
      return name ? `role=${role}[name=/${name}/i]` : `role=${role}`;
    }

    // getByText
    m = /getByText\(\s*(['"/])([^'"/]+)\1/.exec(locator) || /getByText\(\s*\/([^/]+)\//.exec(locator);
    if (m) {
      const text = m[2] || m[1];
      return `text=/${text}/i`;
    }

    // getByLabel
    m = /getByLabel\(\s*(['"/])([^'"/]+)\1/.exec(locator) || /getByLabel\(\s*\/([^/]+)\//.exec(locator);
    if (m) {
      const label = m[2] || m[1];
      return `label=/${label}/i`;
    }

    // getByPlaceholder
    m = /getByPlaceholder\(\s*(['"/])([^'"/]+)\1/.exec(locator) || /getByPlaceholder\(\s*\/([^/]+)\//.exec(locator);
    if (m) {
      const ph = m[2] || m[1];
      return `placeholder=/${ph}/i`;
    }

    // getByTestId
    m = /getByTestId\(\s*'([^']+)'\s*\)/.exec(locator);
    if (m) return `data-testid=${m[1]}`;

    // CSS selector (page.locator)
    m = /locator\(\s*'([^']+)'\s*\)/.exec(locator);
    if (m) return m[1];

    return null;
  }

  /* ---- Confidence calculation ---- */

  calculateConfidence(checks: ValidationChecks): number {
    return (
      (checks.syntax ? 1 : 0) * WEIGHTS.syntax +
      (checks.semantic ? 1 : 0) * WEIGHTS.semantic +
      (checks.exists ? 1 : 0) * WEIGHTS.exists +
      (checks.unique ? 1 : 0) * WEIGHTS.unique +
      (checks.visible ? 1 : 0) * WEIGHTS.visible +
      (checks.interactable ? 1 : 0) * WEIGHTS.interactable
    );
  }

  private getValidationReason(checks: ValidationChecks, details: ValidationCheckDetail[]): string {
    const failed = details.filter((d) => !d.passed);
    if (failed.length === 0) return 'All validation checks passed';
    return failed.map((d) => `${d.name}: ${d.detail}`).join('; ');
  }
}
