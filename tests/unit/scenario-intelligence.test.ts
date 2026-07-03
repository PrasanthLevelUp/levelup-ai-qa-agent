/**
 * Unit tests for the Scenario Intelligence layer in isolation:
 *   Test Case → ScenarioClassifier → ScenarioTransformer → (credentials, assertion, coverage)
 *
 * These exercise the classifier + each transformer directly (no engine, no
 * generation), proving every scenario type is independently testable and that
 * the registry is complete. Adding a new scenario type should add a case here.
 */
import {
  ScenarioClassifier,
  ScenarioIntelligence,
  SCENARIO_TRANSFORMERS,
  getScenarioTransformer,
  type CredentialResolver,
  type ScenarioKind,
} from '../../src/script-gen/scenario-intelligence';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

// A fake resolver that returns recognisable expressions so we can assert exactly
// which credential source each transformer chose.
const resolver: CredentialResolver = {
  base: () => ({ username: `user.username ?? ''`, password: `user.password ?? ''` }),
  validCounterpart: () => ({ username: `validUser.username ?? ''`, password: `validUser.password ?? ''` }),
  envUsername: () => `process.env.TEST_USERNAME ?? ''`,
  envPassword: () => `process.env.TEST_PASSWORD ?? ''`,
  authoredUsername: null,
  authoredPassword: null,
  authoredBothEmpty: false,
  escape: (s) => s.replace(/'/g, "\\'"),
};
const withAuthored = (over: Partial<CredentialResolver>): CredentialResolver => ({ ...resolver, ...over });

const classifier = new ScenarioClassifier();
const classify = (title: string, steps: string[] = []) =>
  classifier.classify({ title }, steps);

function main() {
  console.log('=== Classifier: precedence & kind detection ===');
  ok('empty is detected', classify('Login with empty username and password').kind === 'empty');
  ok('whitespace is detected', classify('Login with leading/trailing whitespace').kind === 'whitespace');
  ok('special chars is detected', classify('Login with special characters').kind === 'special');
  ok('max-length is detected', classify('Login with maximum length username').kind === 'maxlength');
  ok('invalid is detected', classify('Login with invalid credentials').kind === 'invalid');
  ok('normal is the fallback', classify('Login with valid credentials').kind === 'normal');
  ok('empty outranks invalid (precedence)', classify('Invalid login with empty fields').kind === 'empty');

  console.log('=== Classifier: parameter extraction ===');
  ok('special-char literal mined from step', classify('special characters', ["Enter '@locked_user' as username"]).literal === '@locked_user');
  ok('max-length picks the authored length', classify('maximum length 128 username').length === 128);
  ok('max-length defaults to 256', classify('maximum length username').length === 256);
  ok('selector brackets are not mined for the literal', classify('special characters', ["Enter '@x' in [data-test='username']"]).literal === '@x');

  console.log('=== Registry completeness ===');
  const kinds: ScenarioKind[] = ['empty', 'whitespace', 'special', 'maxlength', 'invalid', 'normal'];
  ok('every kind has a transformer', kinds.every((k) => !!SCENARIO_TRANSFORMERS[k]));
  ok('each transformer reports its own kind', kinds.every((k) => getScenarioTransformer(k).kind === k));

  console.log('=== Transformers: credential building ===');
  ok('empty → both blank', (() => { const c = SCENARIO_TRANSFORMERS.empty.transformCredentials({ kind: 'empty' }, resolver); return c.username === `''` && c.password === `''`; })());
  ok('whitespace → wraps base username, keeps base password', (() => { const c = SCENARIO_TRANSFORMERS.whitespace.transformCredentials({ kind: 'whitespace' }, resolver); return c.username === '` ${user.username ?? \'\'} `' && c.password === `user.password ?? ''`; })());
  ok('special (literal) → uses authored literal', (() => { const c = SCENARIO_TRANSFORMERS.special.transformCredentials({ kind: 'special', literal: '@locked_user' }, resolver); return c.username === `'@locked_user'`; })());
  ok('special (no literal) → prepends @ to base', (() => { const c = SCENARIO_TRANSFORMERS.special.transformCredentials({ kind: 'special' }, resolver); return c.username === '`@${user.username ?? \'\'}`'; })());
  ok('maxlength → A.repeat(n)', (() => { const c = SCENARIO_TRANSFORMERS.maxlength.transformCredentials({ kind: 'maxlength', length: 256 }, resolver); return c.username === `'A'.repeat(256)`; })());
  ok('invalid (no authored) → invalid_user/wrong_password', (() => { const c = SCENARIO_TRANSFORMERS.invalid.transformCredentials({ kind: 'invalid' }, resolver); return c.username === `'invalid_user'` && c.password === `'wrong_password'`; })());
  ok('invalid (authored username) → literal + valid counterpart password', (() => { const c = SCENARIO_TRANSFORMERS.invalid.transformCredentials({ kind: 'invalid' }, withAuthored({ authoredUsername: `'bad_user'` })); return c.username === `'bad_user'` && c.password === `validUser.password ?? ''`; })());
  ok('normal → binds the base record', (() => { const c = SCENARIO_TRANSFORMERS.normal.transformCredentials({ kind: 'normal' }, resolver); return c.username === `user.username ?? ''` && c.password === `user.password ?? ''`; })());
  ok('normal (authored both empty) → both blank', (() => { const c = SCENARIO_TRANSFORMERS.normal.transformCredentials({ kind: 'normal' }, withAuthored({ authoredBothEmpty: true })); return c.username === `''` && c.password === `''`; })());

  console.log('=== Transformers: assertion fragments (P3) ===');
  ok('empty → "is required"', SCENARIO_TRANSFORMERS.empty.errorFragment() === 'is required');
  ok('invalid → "do not match"', SCENARIO_TRANSFORMERS.invalid.errorFragment() === 'do not match');
  ok('whitespace → "" (surface only)', SCENARIO_TRANSFORMERS.whitespace.errorFragment() === '');
  ok('special → "" (surface only)', SCENARIO_TRANSFORMERS.special.errorFragment() === '');
  ok('maxlength → "" (surface only)', SCENARIO_TRANSFORMERS.maxlength.errorFragment() === '');
  ok('normal → null (defer to Expected Result)', SCENARIO_TRANSFORMERS.normal.errorFragment() === null);

  console.log('=== Transformers: coverage categories (P5) ===');
  ok('empty contributes Negative + Validation', SCENARIO_TRANSFORMERS.empty.coverageCategories.join(',') === 'Negative,Validation');
  ok('whitespace contributes Negative + Boundary', SCENARIO_TRANSFORMERS.whitespace.coverageCategories.join(',') === 'Negative,Boundary');
  ok('maxlength contributes Negative + Boundary', SCENARIO_TRANSFORMERS.maxlength.coverageCategories.join(',') === 'Negative,Boundary');
  ok('invalid contributes Negative', SCENARIO_TRANSFORMERS.invalid.coverageCategories.join(',') === 'Negative');
  ok('normal contributes nothing (defers to heuristics)', SCENARIO_TRANSFORMERS.normal.coverageCategories.length === 0);

  console.log('=== Facade ===');
  const si = new ScenarioIntelligence();
  ok('facade.resolve() ties classify → transformer', (() => { const r = si.resolve({ title: 'empty fields login' }, []); return r.classification.kind === 'empty' && r.transformer.kind === 'empty'; })());

  console.log(`\n──────── ${passed} passed, ${failed} failed ────────`);
  if (failed > 0) process.exit(1);
}
main();
