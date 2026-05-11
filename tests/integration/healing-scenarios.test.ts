/**
 * Integration Tests — Self-Healing Scenarios
 * Tests the Rule Engine, Validation Engine, Patch Engine, and Strategy Selector
 * against realistic failure scenarios.
 */

import { RuleEngine, type RuleSuggestion } from '../../src/engines/rule-engine';
import { ValidationEngine } from '../../src/engines/validation-engine';
import { PatchEngine } from '../../src/engines/patch-engine';
import { HealingStrategySelector } from '../../src/core/healing-strategy-selector';
import { PatternEngine } from '../../src/engines/pattern-engine';
import { FailureAnalyzer, type FailureDetails } from '../../src/core/failure-analyzer';
import * as fs from 'fs';
import * as path from 'path';

/* -------------------------------------------------------------------------- */
/*  Test Utilities                                                            */
/* -------------------------------------------------------------------------- */

function makeFailure(overrides: Partial<FailureDetails>): FailureDetails {
  return {
    testName: 'test_scenario',
    failureType: 'locator',
    failedLocator: '',
    errorMessage: 'Element not found',
    errorPattern: 'locator_not_found',
    filePath: '/tmp/test.spec.ts',
    lineNumber: 10,
    failedLineCode: '',
    surroundingCode: '',
    screenshotPath: null,
    url: 'https://example.com',
    timestamp: new Date().toISOString(),
    isTimingIssue: false,
    ...overrides,
  };
}

interface ScenarioResult {
  name: string;
  passed: boolean;
  suggestions: RuleSuggestion[];
  bestLocator: string;
  bestConfidence: number;
  validationPassed: boolean;
  durationMs: number;
  details: string;
}

/* -------------------------------------------------------------------------- */
/*  Test Runner                                                               */
/* -------------------------------------------------------------------------- */

async function runScenarios(): Promise<void> {
  const ruleEngine = new RuleEngine();
  const validationEngine = new ValidationEngine(0.7);
  const patchEngine = new PatchEngine('/tmp/healing_test_patches');

  const results: ScenarioResult[] = [];
  const startTotal = Date.now();

  /* ------------------------------------------------------------------ */
  /*  Scenario 1: ID Selector Broken → Semantic Button                  */
  /* ------------------------------------------------------------------ */
  {
    const start = Date.now();
    const failure = makeFailure({
      testName: 'User can login to OrangeHRM',
      failedLocator: '#loginButton',
      errorMessage: "Timeout: locator '#loginButton' not found",
      failedLineCode: "await page.click('#loginButton')",
      url: 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login',
    });

    const result = ruleEngine.generate(failure);
    const best = result.suggestions[0];
    const validation = validationEngine.validate({
      newLocator: best?.newLocator || '',
      confidence: best?.confidence || 0,
    });

    results.push({
      name: 'Scenario 1: ID selector → semantic button',
      passed: result.suggestions.length > 0 && validation.isValid,
      suggestions: result.suggestions,
      bestLocator: best?.newLocator || 'NONE',
      bestConfidence: best?.confidence || 0,
      validationPassed: validation.isValid,
      durationMs: Date.now() - start,
      details: `Expected: page.getByRole('button', { name: /login|sign in|submit/i })`,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Scenario 2: Class Selector Broken → Semantic                      */
  /* ------------------------------------------------------------------ */
  {
    const start = Date.now();
    const failure = makeFailure({
      testName: 'Submit form test',
      failedLocator: '.submit-btn',
      errorMessage: "Element '.submit-btn' not found",
      failedLineCode: "await page.click('.submit-btn')",
    });

    const result = ruleEngine.generate(failure);
    const best = result.suggestions[0];
    const validation = validationEngine.validate({
      newLocator: best?.newLocator || '',
      confidence: best?.confidence || 0,
    });

    results.push({
      name: 'Scenario 2: Class selector → semantic',
      passed: result.suggestions.length > 0 && validation.isValid,
      suggestions: result.suggestions,
      bestLocator: best?.newLocator || 'NONE',
      bestConfidence: best?.confidence || 0,
      validationPassed: validation.isValid,
      durationMs: Date.now() - start,
      details: `Expected: page.getByRole('button', { name: /submit btn/i })`,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Scenario 3: XPath to Semantic                                     */
  /* ------------------------------------------------------------------ */
  {
    const start = Date.now();
    const failure = makeFailure({
      testName: 'XPath submit test',
      failedLocator: '//button[contains(text(), "Submit")]',
      errorMessage: "Timeout waiting for XPath //button[contains(text(), 'Submit')]",
      failedLineCode: `await page.click('//button[contains(text(), "Submit")]')`,
    });

    const result = ruleEngine.generate(failure);
    const best = result.suggestions[0];
    const validation = validationEngine.validate({
      newLocator: best?.newLocator || '',
      confidence: best?.confidence || 0,
    });

    results.push({
      name: 'Scenario 3: XPath → semantic',
      passed: result.suggestions.length > 0 && validation.isValid,
      suggestions: result.suggestions,
      bestLocator: best?.newLocator || 'NONE',
      bestConfidence: best?.confidence || 0,
      validationPassed: validation.isValid,
      durationMs: Date.now() - start,
      details: `Expected: page.getByText('Submit') or page.getByRole('button', { name: /Submit/i })`,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Scenario 4: Timeout Error (keep locator, add wait)                */
  /* ------------------------------------------------------------------ */
  {
    const start = Date.now();
    const failure = makeFailure({
      testName: 'Slow element test',
      failedLocator: '#slow-element',
      errorMessage: 'Timeout 30000ms exceeded waiting for element "#slow-element"',
      failedLineCode: "await page.click('#slow-element')",
      isTimingIssue: true,
    });

    const result = ruleEngine.generate(failure);
    const best = result.suggestions[0];

    results.push({
      name: 'Scenario 4: Timeout → explicit wait',
      passed: result.addExplicitWait && result.suggestions.length > 0,
      suggestions: result.suggestions,
      bestLocator: best?.newLocator || 'NONE',
      bestConfidence: best?.confidence || 0,
      validationPassed: true,
      durationMs: Date.now() - start,
      details: `Expected: addExplicitWait=true. Got: ${result.addExplicitWait}`,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Scenario 5: Dynamic ID (user-123 → user-profile)                  */
  /* ------------------------------------------------------------------ */
  {
    const start = Date.now();
    const failure = makeFailure({
      testName: 'Dynamic ID test',
      failedLocator: '#user-123',
      errorMessage: "Element '#user-123' not found",
      failedLineCode: "await page.click('#user-123')",
    });

    const result = ruleEngine.generate(failure);
    const hasDynamicIdRule = result.suggestions.some(
      (s) => s.ruleId === 'R01' || s.reasoning.includes('Dynamic'),
    );

    results.push({
      name: 'Scenario 5: Dynamic ID → stable locator',
      passed: hasDynamicIdRule && result.suggestions.length > 0,
      suggestions: result.suggestions,
      bestLocator: result.suggestions[0]?.newLocator || 'NONE',
      bestConfidence: result.suggestions[0]?.confidence || 0,
      validationPassed: true,
      durationMs: Date.now() - start,
      details: `Expected: Dynamic ID detection and getByTestId suggestion`,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Scenario 6: Input by name attribute                               */
  /* ------------------------------------------------------------------ */
  {
    const start = Date.now();
    const failure = makeFailure({
      testName: 'Input name test',
      failedLocator: 'input[name="username"]',
      errorMessage: 'Element not found',
      failedLineCode: `await page.fill('input[name="username"]', 'Admin')`,
    });

    const result = ruleEngine.generate(failure);
    const best = result.suggestions[0];
    const validation = validationEngine.validate({
      newLocator: best?.newLocator || '',
      confidence: best?.confidence || 0,
    });

    results.push({
      name: 'Scenario 6: Input[name] → label locator',
      passed: result.suggestions.length > 0 && validation.isValid,
      suggestions: result.suggestions,
      bestLocator: best?.newLocator || 'NONE',
      bestConfidence: best?.confidence || 0,
      validationPassed: validation.isValid,
      durationMs: Date.now() - start,
      details: `Expected: page.getByLabel(/username/i)`,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Scenario 7: data-testid attribute                                 */
  /* ------------------------------------------------------------------ */
  {
    const start = Date.now();
    const failure = makeFailure({
      testName: 'data-testid test',
      failedLocator: '[data-testid="submit-form"]',
      errorMessage: 'Element not found',
      failedLineCode: `await page.click('[data-testid="submit-form"]')`,
    });

    const result = ruleEngine.generate(failure);
    const best = result.suggestions[0];
    const validation = validationEngine.validate({
      newLocator: best?.newLocator || '',
      confidence: best?.confidence || 0,
    });

    results.push({
      name: 'Scenario 7: data-testid → getByTestId',
      passed: result.suggestions.length > 0 && (best?.newLocator?.includes('getByTestId') ?? false),
      suggestions: result.suggestions,
      bestLocator: best?.newLocator || 'NONE',
      bestConfidence: best?.confidence || 0,
      validationPassed: validation.isValid,
      durationMs: Date.now() - start,
      details: `Expected: page.getByTestId('submit-form')`,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Scenario 8: aria-label attribute                                  */
  /* ------------------------------------------------------------------ */
  {
    const start = Date.now();
    const failure = makeFailure({
      testName: 'aria-label test',
      failedLocator: '[aria-label="Close dialog"]',
      errorMessage: 'Element not found',
      failedLineCode: `await page.click('[aria-label="Close dialog"]')`,
    });

    const result = ruleEngine.generate(failure);
    const best = result.suggestions[0];

    results.push({
      name: 'Scenario 8: aria-label → getByLabel',
      passed: result.suggestions.length > 0 && (best?.newLocator?.includes('getByLabel') ?? false),
      suggestions: result.suggestions,
      bestLocator: best?.newLocator || 'NONE',
      bestConfidence: best?.confidence || 0,
      validationPassed: true,
      durationMs: Date.now() - start,
      details: `Expected: page.getByLabel('Close dialog')`,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Scenario 9: Heading element                                       */
  /* ------------------------------------------------------------------ */
  {
    const start = Date.now();
    const failure = makeFailure({
      testName: 'Heading test',
      failedLocator: 'h6:has-text("Dashboard")',
      errorMessage: 'Element not visible',
      failedLineCode: `expect(page.locator('h6:has-text("Dashboard")')).toBeVisible()`,
    });

    const result = ruleEngine.generate(failure);
    const best = result.suggestions[0];

    results.push({
      name: 'Scenario 9: Heading → getByRole heading',
      passed: result.suggestions.length > 0 && (best?.newLocator?.includes('heading') ?? false),
      suggestions: result.suggestions,
      bestLocator: best?.newLocator || 'NONE',
      bestConfidence: best?.confidence || 0,
      validationPassed: true,
      durationMs: Date.now() - start,
      details: `Expected: page.getByRole('heading', { name: /Dashboard/i })`,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Scenario 10: Security validation (blocks dangerous code)          */
  /* ------------------------------------------------------------------ */
  {
    const start = Date.now();
    const dangerousLocator = `eval('document.querySelector("#btn")')`;
    const validation = validationEngine.validate({
      newLocator: dangerousLocator,
      confidence: 0.95,
    });

    results.push({
      name: 'Scenario 10: Security — block eval()',
      passed: !validation.isValid,
      suggestions: [],
      bestLocator: dangerousLocator,
      bestConfidence: 0.95,
      validationPassed: !validation.isValid, // Should NOT pass
      durationMs: Date.now() - start,
      details: `Expected: validation rejects dangerous eval() pattern`,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  AST Patch Engine Test                                              */
  /* ------------------------------------------------------------------ */
  {
    const start = Date.now();
    const testFile = '/tmp/healing_test_ast.spec.ts';
    const testCode = `import { test, expect } from '@playwright/test';

test('login test', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.click('#loginButton');
  await expect(page.locator('.dashboard')).toBeVisible();
});
`;
    fs.writeFileSync(testFile, testCode, 'utf-8');

    try {
      const patchResult = await patchEngine.applyLocatorChange(
        testFile,
        5,
        '#loginButton',
        `page.getByRole('button', { name: /login/i })`,
        'Test AST patch',
        'rule_based',
      );

      results.push({
        name: 'AST Patch: Locator replacement',
        passed: patchResult.success && patchResult.patchContent.length > 0,
        suggestions: [],
        bestLocator: 'N/A',
        bestConfidence: 0,
        validationPassed: true,
        durationMs: Date.now() - start,
        details: `Method: ${patchResult.metadata.method}, Formatting preserved: ${patchResult.preservedFormatting}`,
      });
    } catch (err: any) {
      results.push({
        name: 'AST Patch: Locator replacement',
        passed: false,
        suggestions: [],
        bestLocator: 'N/A',
        bestConfidence: 0,
        validationPassed: false,
        durationMs: Date.now() - start,
        details: `Error: ${err.message}`,
      });
    } finally {
      try { fs.unlinkSync(testFile); } catch {}
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Print Results                                                      */
  /* ------------------------------------------------------------------ */
  const totalDuration = Date.now() - startTotal;

  console.log('\n' + '='.repeat(80));
  console.log('  INTEGRATION TEST RESULTS — Self-Healing Scenarios');
  console.log('='.repeat(80));

  let passed = 0;
  let failed = 0;

  for (const r of results) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL';
    if (r.passed) passed++; else failed++;

    console.log(`\n${status} | ${r.name}`);
    console.log(`  Best Locator: ${r.bestLocator}`);
    console.log(`  Confidence: ${r.bestConfidence.toFixed(2)}`);
    console.log(`  Validation: ${r.validationPassed ? 'Passed' : 'Failed'}`);
    console.log(`  Duration: ${r.durationMs}ms`);
    console.log(`  Details: ${r.details}`);
    if (r.suggestions.length > 0) {
      console.log(`  All suggestions (${r.suggestions.length}):`);
      for (const s of r.suggestions.slice(0, 3)) {
        console.log(`    - [${s.confidence.toFixed(2)}] ${s.newLocator}`);
      }
    }
  }

  const successRate = ((passed / results.length) * 100).toFixed(1);

  console.log('\n' + '='.repeat(80));
  console.log('  SUMMARY');
  console.log('='.repeat(80));
  console.log(`  Total Scenarios: ${results.length}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Success Rate: ${successRate}%`);
  console.log(`  Total Duration: ${totalDuration}ms`);
  console.log(`  Avg per scenario: ${(totalDuration / results.length).toFixed(0)}ms`);
  console.log('='.repeat(80));

  // Performance benchmarks
  console.log('\n  PERFORMANCE BENCHMARKS:');
  console.log(`  Average scenario time: ${(totalDuration / results.length).toFixed(0)}ms (target: <10000ms)`);
  console.log(`  Total test time: ${totalDuration}ms (target: <15000ms)`);

  // Target: 90%+
  const targetMet = parseFloat(successRate) >= 90;
  console.log(`\n  🎯 Target (90%+ success rate): ${targetMet ? '✅ MET' : '❌ NOT MET'} (${successRate}%)`);

  // Write results to JSON for reporting
  const reportPath = '/tmp/healing_integration_results.json';
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    successRate: `${successRate}%`,
    totalDurationMs: totalDuration,
    scenarios: results.map((r) => ({
      name: r.name,
      passed: r.passed,
      bestLocator: r.bestLocator,
      bestConfidence: r.bestConfidence,
      durationMs: r.durationMs,
    })),
  }, null, 2));

  console.log(`\n  Results saved to: ${reportPath}`);

  if (!targetMet) {
    process.exit(1);
  }
}

// Run
runScenarios().catch((err) => {
  console.error('Integration tests failed:', err);
  process.exit(1);
});
