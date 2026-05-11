/**
 * Validation Engine — validates proposed fixes before application.
 * Checks syntax, semantics, security, and confidence thresholds.
 */

import ts from 'typescript';
import { logger } from '../utils/logger';

const MOD = 'validation-engine';

export interface ValidationInput {
  newLocator: string;
  confidence: number;
  originalCode: string;
  filePath: string;
}

export interface ValidationOutput {
  isValid: boolean;
  reason: string;
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

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

export class ValidationEngine {
  private readonly confidenceThreshold: number;

  constructor(confidenceThreshold = 0.8) {
    this.confidenceThreshold = confidenceThreshold;
  }

  /**
   * Main validation method — runs all checks.
   */
  validate(input: ValidationInput): ValidationOutput {
    const checks: ValidationCheck[] = [];

    // 1. Confidence threshold check
    const confCheck = this.validateConfidence(input.confidence);
    checks.push(confCheck);

    // 2. Security check
    const secCheck = this.validateSecurity(input.newLocator);
    checks.push(secCheck);

    // 3. Semantic locator check
    const semCheck = this.validateSemantic(input.newLocator);
    checks.push(semCheck);

    // 4. Syntax validation (if we have full code)
    if (input.originalCode) {
      const syntaxCheck = this.validateSyntax(input.originalCode, input.filePath);
      checks.push(syntaxCheck);
    }

    // 5. Non-empty locator check
    const emptyCheck: ValidationCheck = {
      name: 'non_empty',
      passed: input.newLocator.trim().length > 0,
      detail: input.newLocator.trim().length > 0
        ? 'Locator is non-empty'
        : 'Locator is empty',
    };
    checks.push(emptyCheck);

    const failedChecks = checks.filter((c) => !c.passed);
    const isValid = failedChecks.length === 0;
    const reason = isValid
      ? 'All validation checks passed'
      : failedChecks.map((c) => `${c.name}: ${c.detail}`).join('; ');

    logger.info(MOD, 'Validation complete', {
      isValid,
      checksRun: checks.length,
      checksFailed: failedChecks.length,
    });

    return { isValid, reason, checks };
  }

  /**
   * Validate TypeScript syntax of code.
   */
  validateSyntax(code: string, fileName: string): ValidationCheck {
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

  /**
   * Validate that the locator uses semantic Playwright locators.
   */
  validateSemantic(locator: string): ValidationCheck {
    const isSemantic = SEMANTIC_LOCATORS.some((s) => locator.includes(s));
    return {
      name: 'semantic',
      passed: isSemantic,
      detail: isSemantic
        ? 'Uses semantic locator'
        : 'Non-semantic locator (CSS/XPath) — prefer getByRole/getByLabel/getByText',
    };
  }

  /**
   * Security check — no eval, dangerous patterns.
   */
  validateSecurity(locator: string): ValidationCheck {
    const blocked = BLOCKED_PATTERNS.find((p) => p.test(locator));
    return {
      name: 'security',
      passed: !blocked,
      detail: blocked
        ? `Dangerous pattern detected: ${blocked.source}`
        : 'No dangerous patterns found',
    };
  }

  /**
   * Confidence threshold check.
   */
  private validateConfidence(confidence: number): ValidationCheck {
    const passed = confidence > this.confidenceThreshold;
    return {
      name: 'confidence',
      passed,
      detail: passed
        ? `Confidence ${confidence.toFixed(2)} > ${this.confidenceThreshold}`
        : `Confidence ${confidence.toFixed(2)} <= ${this.confidenceThreshold} (too low)`,
    };
  }
}
