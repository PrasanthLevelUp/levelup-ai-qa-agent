/**
 * Canonical Test Case normalizer — Unit Tests
 * ===========================================
 * Proves that the SINGLE canonical contract (`canonical-test-case.ts`) absorbs
 * every legacy/AI `steps` payload shape and produces a clean `string[]`,
 * including the two shapes that used to silently yield 0 steps (the root cause
 * of `DeterministicGenerationEmptyError(11, [])`):
 *
 *   A  string[]                          → ✅ parsed (was ✅)
 *   B  [{action, expected}]              → ✅ parsed (was ✅)
 *   C  [{stepNumber, description}]       → ✅ parsed (was ✅)
 *   D  [{instruction, expectedResult}]   → ✅ parsed (WAS ❌ — root cause)
 *   E  { "1": "…", "2": "…" } object     → ✅ parsed (WAS ❌ — root cause)
 *
 * Also proves the diagnostics carry a usable Stage-1 reason (shape + keys) so
 * the pipeline can surface `caseErrors` instead of `[]`.
 *
 * Run with:  npx tsx tests/unit/canonical-test-case.test.ts
 */

import {
  normalizeSteps,
  normalizeTestCase,
  describeStageOneFailure,
} from '../../src/script-gen/canonical-test-case';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function main() {
  console.log('\n── Shape-variant matrix (all must now parse) ──');

  /* Shape A — string[] */
  {
    const { steps, diagnostics } = normalizeSteps([
      'Navigate to https://automationexercise.com/login',
      'Enter email into login-email',
      'Enter password into login-password',
      'Click login-button',
    ]);
    assert(steps.length === 4, 'A string[]: 4 steps parsed');
    assert(diagnostics.sourceShape === 'string-array', 'A string[]: shape detected');
  }

  /* Shape B — [{action, expected}] */
  {
    const { steps, diagnostics } = normalizeSteps([
      { action: 'Navigate to /login', expected: 'login page shown' },
      { action: 'Enter email', expected: 'email accepted' },
      { action: 'Click login-button', expected: 'logged in' },
    ]);
    assert(steps.length === 3, 'B action/expected: 3 steps parsed');
    assert(steps[0] === 'Navigate to /login', 'B action/expected: text from `action` key');
    assert(diagnostics.sourceShape === 'object-array', 'B action/expected: shape detected');
  }

  /* Shape C — [{stepNumber, description}] */
  {
    const { steps } = normalizeSteps([
      { stepNumber: 1, description: 'Open the login page' },
      { stepNumber: 2, description: 'Fill credentials' },
      { stepNumber: 3, description: 'Submit' },
    ]);
    assert(steps.length === 3, 'C stepNumber/description: 3 steps parsed');
    assert(steps[0] === 'Open the login page', 'C stepNumber/description: text from `description`');
  }

  /* Shape D — [{instruction, expectedResult}] (THE ROOT CAUSE) */
  {
    const { steps, diagnostics } = normalizeSteps([
      { instruction: 'Navigate to the login page', expectedResult: 'page loads' },
      { instruction: 'Enter valid email', expectedResult: 'email accepted' },
      { instruction: 'Enter valid password', expectedResult: 'password accepted' },
      { instruction: 'Click the Login button', expectedResult: 'user logged in' },
    ]);
    assert(steps.length === 4, 'D instruction/expectedResult: 4 steps parsed (was 0 — root cause fixed)');
    assert(steps[0] === 'Navigate to the login page', 'D instruction/expectedResult: text from `instruction`');
    assert(diagnostics.observedKeys?.includes('instruction') === true, 'D: diagnostics record observed keys');
  }

  /* Shape E — keyed object { "1": "…", "2": "…" } (THE ROOT CAUSE) */
  {
    const { steps, diagnostics } = normalizeSteps({
      '1': 'Navigate to /login',
      '2': 'Enter email',
      '3': 'Enter password',
      '10': 'Click login',
    });
    assert(steps.length === 4, 'E keyed-object: 4 steps parsed (was 0 — root cause fixed)');
    assert(steps[0] === 'Navigate to /login' && steps[3] === 'Click login', 'E keyed-object: NUMERIC order preserved (10 last, not after 1)');
    assert(diagnostics.sourceShape === 'keyed-object', 'E keyed-object: shape detected');
  }

  console.log('\n── JSON-string encodings ──');
  {
    const { steps, diagnostics } = normalizeSteps(JSON.stringify(['Go to /login', 'Click submit']));
    assert(steps.length === 2, 'JSON string[]: decoded + parsed');
    assert(diagnostics.sourceShape === 'json-string', 'JSON string[]: shape=json-string');
  }
  {
    const { steps } = normalizeSteps(JSON.stringify([{ instruction: 'Open page' }, { instruction: 'Click' }]));
    assert(steps.length === 2, 'JSON object[] (instruction): decoded + parsed');
  }

  console.log('\n── Newline prose + ordinal stripping ──');
  {
    const { steps, diagnostics } = normalizeSteps('1. Navigate to /login\n2) Enter email\n3. Click login');
    assert(steps.length === 3, 'newline prose: 3 steps');
    assert(steps[0] === 'Navigate to /login', 'newline prose: ordinal prefix stripped');
    assert(diagnostics.sourceShape === 'newline-string', 'newline prose: shape detected');
  }
  {
    const { steps } = normalizeSteps(['1. Navigate', '2) Enter email']);
    assert(steps[0] === 'Navigate' && steps[1] === 'Enter email', 'array ordinal prefixes stripped');
  }

  console.log('\n── Empty / unknown payloads → 0 steps WITH diagnostics ──');
  {
    const { steps, diagnostics } = normalizeSteps('');
    assert(steps.length === 0 && diagnostics.sourceShape === 'empty', 'empty string → 0 steps, shape=empty');
    assert(diagnostics.warnings.length > 0, 'empty: carries a warning');
  }
  {
    const { steps, diagnostics } = normalizeSteps([{ foo: 123, bar: true }]);
    // No string values at all → genuinely unextractable.
    assert(steps.length === 0, 'object with no string values → 0 steps');
    assert(diagnostics.observedKeys?.includes('foo') === true, 'unknown-schema: observed keys recorded (foo)');
  }
  {
    const { steps } = normalizeSteps([{ customField: 'Do the thing' }]);
    // Falls back to the first non-empty string value → stays automatable.
    assert(steps.length === 1 && steps[0] === 'Do the thing', 'foreign single-string-value object → recovered');
  }

  console.log('\n── normalizeTestCase full-row mapping ──');
  {
    const { canonical, diagnostics } = normalizeTestCase({
      id: 102,
      title: 'Login with valid credentials',
      steps: [{ instruction: 'Navigate to /login' }, { instruction: 'Click login' }],
      expected_result: 'User is logged in',
      test_data: 'username: standard_user, password: secret',
      requirement_id: 'c45af114',
    });
    assert(canonical.id === 102, 'row: id carried');
    assert(canonical.steps.length === 2, 'row: steps normalized (instruction shape)');
    assert(canonical.expectedResult === 'User is logged in', 'row: expected_result mapped');
    assert(canonical.testData === 'username: standard_user, password: secret', 'row: test_data mapped');
    assert(canonical.requirementId === 'c45af114', 'row: requirement_id mapped');
    assert(diagnostics.stepCount === 2, 'row: diagnostics stepCount matches');
  }
  {
    const { canonical } = normalizeTestCase(null);
    assert(canonical.steps.length === 0, 'null row → empty canonical steps');
  }

  console.log('\n── describeStageOneFailure output ──');
  {
    const { diagnostics } = normalizeSteps([{ foo: 1 }]);
    const line = describeStageOneFailure('Test case 102', diagnostics);
    assert(line.includes('STAGE 1'), 'diag line: names STAGE 1');
    assert(line.includes('shape=object-array'), 'diag line: includes shape');
    assert(line.includes('keys=[foo]'), 'diag line: includes observed keys');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
