/**
 * Unit tests for the Scenario Intelligence layer in isolation:
 *   Test Case → ScenarioTransformer (self-matching) → (credentials, assertion, coverage)
 *
 * These exercise each transformer's own detection (`matches`) plus its credential,
 * assertion and coverage behaviour directly (no engine, no generation), proving
 * every scenario type is independently testable and self-describing, that the
 * registry resolves by precedence, and that the facade ties it together. Adding a
 * new scenario type should add a case here.
 */
import {
  ScenarioIntelligence,
  SCENARIO_TRANSFORMERS,
  classifyScenario,
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

// Direct handles to each transformer (by kind) for isolated assertions.
const T = {
  empty: getScenarioTransformer('empty'),
  whitespace: getScenarioTransformer('whitespace'),
  special: getScenarioTransformer('special'),
  maxlength: getScenarioTransformer('maxlength'),
  invalid: getScenarioTransformer('invalid'),
  normal: getScenarioTransformer('normal'),
};

// Registry-driven classification (first matching transformer wins).
const classify = (title: string, steps: string[] = []) =>
  classifyScenario({ title }, steps).classification;

function main() {
  console.log('=== Registry: precedence & kind detection (self-matching) ===');
  ok('empty is detected', classify('Login with empty username and password').kind === 'empty');
  ok('whitespace is detected', classify('Login with leading/trailing whitespace').kind === 'whitespace');
  ok('special chars is detected', classify('Login with special characters').kind === 'special');
  ok('max-length is detected', classify('Login with maximum length username').kind === 'maxlength');
  ok('invalid is detected', classify('Login with invalid credentials').kind === 'invalid');
  ok('normal is the fallback', classify('Login with valid credentials').kind === 'normal');
  ok('empty outranks invalid (precedence)', classify('Invalid login with empty fields').kind === 'empty');

  console.log('=== Registry: parameter extraction (mined by the owning transformer) ===');
  ok('special-char literal mined from step', classify('special characters', ["Enter '@locked_user' as username"]).literal === '@locked_user');
  ok('max-length picks the authored length', classify('maximum length 128 username').length === 128);
  ok('max-length defaults to 256', classify('maximum length username').length === 256);
  ok('selector brackets are not mined for the literal', classify('special characters', ["Enter '@x' in [data-test='username']"]).literal === '@x');

  console.log('=== Transformers own their detection (matches) ===');
  ok('empty.matches claims empty case', T.empty.matches({ title: 'empty fields' }, [])?.kind === 'empty');
  ok('empty.matches declines a valid case', T.empty.matches({ title: 'valid login' }, []) === null);
  ok('whitespace.matches claims whitespace case', T.whitespace.matches({ title: 'trailing spaces' }, [])?.kind === 'whitespace');
  ok('whitespace.matches declines otherwise', T.whitespace.matches({ title: 'valid login' }, []) === null);
  ok('special.matches mines its own literal', T.special.matches({ title: 'special characters' }, ["Enter '@x' as username"])?.literal === '@x');
  ok('special.matches declines otherwise', T.special.matches({ title: 'valid login' }, []) === null);
  ok('maxlength.matches mines its own length', T.maxlength.matches({ title: 'maximum length 99 username' }, [])?.length === 99);
  ok('maxlength.matches declines otherwise', T.maxlength.matches({ title: 'valid login' }, []) === null);
  ok('invalid.matches claims invalid case', T.invalid.matches({ title: 'incorrect password' }, [])?.kind === 'invalid');
  ok('invalid.matches declines otherwise', T.invalid.matches({ title: 'valid login' }, []) === null);
  ok('normal.matches is the unconditional catch-all', T.normal.matches({ title: 'anything at all' }, [])?.kind === 'normal');

  console.log('=== Registry shape & completeness ===');
  const kinds: ScenarioKind[] = ['empty', 'whitespace', 'special', 'maxlength', 'invalid', 'normal'];
  ok('registry is an ordered array', Array.isArray(SCENARIO_TRANSFORMERS) && SCENARIO_TRANSFORMERS.length === kinds.length);
  ok('registry order encodes precedence', SCENARIO_TRANSFORMERS.map((t) => t.kind).join('>') === 'empty>whitespace>special>maxlength>invalid>normal');
  ok('normal is last (guaranteed fallback)', SCENARIO_TRANSFORMERS[SCENARIO_TRANSFORMERS.length - 1]!.kind === 'normal');
  ok('every kind has a transformer', kinds.every((k) => !!getScenarioTransformer(k)));
  ok('each transformer reports its own kind', kinds.every((k) => getScenarioTransformer(k).kind === k));

  console.log('=== Transformers: credential building ===');
  ok('empty → both blank', (() => { const c = T.empty.transformCredentials({ kind: 'empty' }, resolver); return c.username === `''` && c.password === `''`; })());
  ok('whitespace → wraps base username, keeps base password', (() => { const c = T.whitespace.transformCredentials({ kind: 'whitespace' }, resolver); return c.username === '` ${user.username ?? \'\'} `' && c.password === `user.password ?? ''`; })());
  ok('special (literal) → uses authored literal', (() => { const c = T.special.transformCredentials({ kind: 'special', literal: '@locked_user' }, resolver); return c.username === `'@locked_user'`; })());
  ok('special (no literal) → prepends @ to base', (() => { const c = T.special.transformCredentials({ kind: 'special' }, resolver); return c.username === '`@${user.username ?? \'\'}`'; })());
  ok('maxlength → A.repeat(n)', (() => { const c = T.maxlength.transformCredentials({ kind: 'maxlength', length: 256 }, resolver); return c.username === `'A'.repeat(256)`; })());
  ok('invalid (no authored) → invalid_user/wrong_password', (() => { const c = T.invalid.transformCredentials({ kind: 'invalid' }, resolver); return c.username === `'invalid_user'` && c.password === `'wrong_password'`; })());
  ok('invalid (authored username) → literal + valid counterpart password', (() => { const c = T.invalid.transformCredentials({ kind: 'invalid' }, withAuthored({ authoredUsername: `'bad_user'` })); return c.username === `'bad_user'` && c.password === `validUser.password ?? ''`; })());
  ok('normal → binds the base record', (() => { const c = T.normal.transformCredentials({ kind: 'normal' }, resolver); return c.username === `user.username ?? ''` && c.password === `user.password ?? ''`; })());
  ok('normal (authored both empty) → both blank', (() => { const c = T.normal.transformCredentials({ kind: 'normal' }, withAuthored({ authoredBothEmpty: true })); return c.username === `''` && c.password === `''`; })());

  console.log('=== Transformers: assertion fragments (P3) ===');
  ok('empty → "is required"', T.empty.errorFragment() === 'is required');
  ok('invalid → "do not match"', T.invalid.errorFragment() === 'do not match');
  ok('whitespace → "" (surface only)', T.whitespace.errorFragment() === '');
  ok('special → "" (surface only)', T.special.errorFragment() === '');
  ok('maxlength → "" (surface only)', T.maxlength.errorFragment() === '');
  ok('normal → null (defer to Expected Result)', T.normal.errorFragment() === null);

  console.log('=== Transformers: coverage categories (P5) ===');
  ok('empty contributes Negative + Validation', T.empty.coverageCategories.join(',') === 'Negative,Validation');
  ok('whitespace contributes Negative + Boundary', T.whitespace.coverageCategories.join(',') === 'Negative,Boundary');
  ok('maxlength contributes Negative + Boundary', T.maxlength.coverageCategories.join(',') === 'Negative,Boundary');
  ok('invalid contributes Negative', T.invalid.coverageCategories.join(',') === 'Negative');
  ok('normal contributes nothing (defers to heuristics)', T.normal.coverageCategories.length === 0);

  console.log('=== Facade ===');
  const si = new ScenarioIntelligence();
  ok('facade.resolve() ties classify → transformer', (() => { const r = si.resolve({ title: 'empty fields login' }, []); return r.classification.kind === 'empty' && r.transformer.kind === 'empty'; })());
  ok('facade.classify() matches the registry', si.classify({ title: 'special characters' }, []).kind === 'special');
  ok('facade.transformer() resolves by kind', si.transformer({ kind: 'invalid' }).kind === 'invalid');

  console.log(`\n──────── ${passed} passed, ${failed} failed ────────`);
  if (failed > 0) process.exit(1);
}
main();
