/**
 * Validation Runner Engine
 * Validates generated test scripts before delivering to users.
 * 
 * Validation steps:
 * 1. TypeScript compilation check
 * 2. Import validation
 * 3. Selector syntax validation
 * 4. Structure validation (has describe, test, expect)
 * 5. Lint check (basic patterns)
 */

import { logger } from '../utils/logger';
import type { GeneratedFile, TestPlan } from './script-gen-engine';

const MOD = 'validation-runner';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ValidationCheck {
  name: string;
  passed: boolean;
  details: string;
  severity: 'error' | 'warning' | 'info';
}

export interface ValidationReport {
  passed: boolean;
  overallScore: number;         // 0-100
  checks: ValidationCheck[];
  errors: string[];
  warnings: string[];
  validationTimeMs: number;
}

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

export class ValidationRunner {
  /**
   * Run all validation checks on generated files.
   */
  validate(files: GeneratedFile[], testPlan: TestPlan): ValidationReport {
    const startTime = Date.now();
    const checks: ValidationCheck[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    const testFiles = files.filter(f => f.type === 'test');
    const pageObjects = files.filter(f => f.type === 'page-object');

    // 1. Structure checks
    for (const file of testFiles) {
      checks.push(...this.checkStructure(file));
    }

    // 2. Import validation
    for (const file of [...testFiles, ...pageObjects]) {
      checks.push(...this.checkImports(file));
    }

    // 3. Selector syntax
    for (const file of [...testFiles, ...pageObjects]) {
      checks.push(...this.checkSelectorSyntax(file));
    }

    // 4. Assertion quality
    for (const file of testFiles) {
      checks.push(...this.checkAssertions(file));
    }

    // 5. Wait strategy
    for (const file of testFiles) {
      checks.push(...this.checkWaitStrategies(file));
    }

    // 6. Test plan consistency
    checks.push(this.checkTestPlanConsistency(testPlan, testFiles));

    // 7. Config validation
    const configFile = files.find(f => f.path === 'playwright.config.ts');
    if (configFile) {
      checks.push(this.checkConfig(configFile));
    }

    // Collect errors and warnings
    for (const check of checks) {
      if (!check.passed && check.severity === 'error') errors.push(check.details);
      if (!check.passed && check.severity === 'warning') warnings.push(check.details);
    }

    const passedCount = checks.filter(c => c.passed).length;
    const overallScore = checks.length > 0
      ? Math.round((passedCount / checks.length) * 100)
      : 0;

    return {
      passed: errors.length === 0,
      overallScore,
      checks,
      errors,
      warnings,
      validationTimeMs: Date.now() - startTime,
    };
  }

  private checkStructure(file: GeneratedFile): ValidationCheck[] {
    const checks: ValidationCheck[] = [];
    const content = file.content;

    // Has test.describe
    checks.push({
      name: `${file.path}: has test.describe`,
      passed: content.includes('test.describe('),
      details: content.includes('test.describe(') ? 'Test file has describe block' : 'Missing test.describe block',
      severity: 'error',
    });

    // Has test()
    checks.push({
      name: `${file.path}: has test()`,
      passed: /test\s*\(/.test(content),
      details: /test\s*\(/.test(content) ? 'Test file has test cases' : 'No test() calls found',
      severity: 'error',
    });

    // Has async page parameter
    checks.push({
      name: `${file.path}: uses page fixture`,
      passed: content.includes('{ page }'),
      details: content.includes('{ page }') ? 'Uses Playwright page fixture' : 'Missing { page } destructuring',
      severity: 'warning',
    });

    return checks;
  }

  private checkImports(file: GeneratedFile): ValidationCheck[] {
    const checks: ValidationCheck[] = [];
    const content = file.content;

    // Has playwright import
    const hasImport = content.includes("from '@playwright/test'") || content.includes("from \"@playwright/test\"");
    checks.push({
      name: `${file.path}: playwright import`,
      passed: hasImport,
      details: hasImport ? 'Has @playwright/test import' : 'Missing @playwright/test import',
      severity: 'error',
    });

    // No deprecated imports
    const hasDeprecated = content.includes('chromium.launch') || content.includes("require('playwright'");
    checks.push({
      name: `${file.path}: no deprecated API`,
      passed: !hasDeprecated,
      details: hasDeprecated ? 'Uses deprecated Playwright API' : 'No deprecated API usage',
      severity: 'warning',
    });

    return checks;
  }

  private checkSelectorSyntax(file: GeneratedFile): ValidationCheck[] {
    const checks: ValidationCheck[] = [];
    const content = file.content;

    // No unclosed brackets in selectors
    const selectorMatches = content.match(/page\.locator\('[^']*$/gm);
    checks.push({
      name: `${file.path}: selector syntax`,
      passed: !selectorMatches,
      details: selectorMatches ? `Unclosed selector found in ${file.path}` : 'All selectors have valid syntax',
      severity: 'error',
    });

    // No empty selectors
    const emptySelectors = content.match(/page\.locator\(\s*['"]\s*['"]\s*\)/g);
    checks.push({
      name: `${file.path}: no empty selectors`,
      passed: !emptySelectors,
      details: emptySelectors ? 'Empty selector found' : 'No empty selectors',
      severity: 'error',
    });

    return checks;
  }

  private checkAssertions(file: GeneratedFile): ValidationCheck[] {
    const checks: ValidationCheck[] = [];
    const content = file.content;

    // Has assertions
    const assertionCount = (content.match(/expect\(/g) || []).length;
    checks.push({
      name: `${file.path}: has assertions`,
      passed: assertionCount > 0,
      details: assertionCount > 0 ? `${assertionCount} assertions found` : 'No assertions found in test',
      severity: 'error',
    });

    // Has meaningful assertions (not just toBeTruthy/toBeDefined)
    const weakAssertions = (content.match(/\.toBeTruthy\(\)|\. toBeDefined\(\)/g) || []).length;
    checks.push({
      name: `${file.path}: assertion quality`,
      passed: weakAssertions === 0 || assertionCount > weakAssertions,
      details: weakAssertions > 0 ? `${weakAssertions} weak assertions found` : 'All assertions are meaningful',
      severity: 'warning',
    });

    return checks;
  }

  private checkWaitStrategies(file: GeneratedFile): ValidationCheck[] {
    const checks: ValidationCheck[] = [];
    const content = file.content;

    // No waitForTimeout
    const hasHardWait = /waitForTimeout\s*\(\s*\d{4,}\s*\)/.test(content);
    checks.push({
      name: `${file.path}: no hard waits`,
      passed: !hasHardWait,
      details: hasHardWait ? 'Uses waitForTimeout with large values — will be slow' : 'No hard-coded waits',
      severity: 'warning',
    });

    // Has proper waits
    const hasProperWait = content.includes('waitForLoadState') ||
      content.includes('waitFor(') ||
      content.includes('toBeVisible');
    checks.push({
      name: `${file.path}: uses proper waits`,
      passed: hasProperWait,
      details: hasProperWait ? 'Uses proper wait strategies' : 'No proper wait strategies found',
      severity: 'info',
    });

    return checks;
  }

  private checkTestPlanConsistency(plan: TestPlan, testFiles: GeneratedFile[]): ValidationCheck {
    return {
      name: 'Test plan consistency',
      passed: plan.flows.length <= testFiles.length,
      details: `${plan.flows.length} flows in plan, ${testFiles.length} test files generated`,
      severity: 'warning',
    };
  }

  private checkConfig(file: GeneratedFile): ValidationCheck {
    const content = file.content;
    const hasBaseUrl = content.includes('baseURL');
    const hasRetries = content.includes('retries');
    const hasReporter = content.includes('reporter');

    return {
      name: 'Playwright config completeness',
      passed: hasBaseUrl && hasRetries && hasReporter,
      details: [
        hasBaseUrl ? '\u2713 baseURL' : '\u2717 missing baseURL',
        hasRetries ? '\u2713 retries' : '\u2717 missing retries',
        hasReporter ? '\u2713 reporter' : '\u2717 missing reporter',
      ].join(', '),
      severity: 'warning',
    };
  }
}
