/**
 * Regression tests for the Test Data Resolution fix.
 *
 * Bug (highest-impact per review): generated scripts emitted bogus credential
 * literals scraped from the step prose / selector fragments — e.g.
 *     await loginPage.login('username', 'in');
 * for a case whose step read "Enter the username in [data-testid='username']
 * field" and "Enter the password in [data-testid='password'] field", bound to
 * the dataset reference `locked_user`.
 *
 * The fixes verified here:
 *   1. looksLikeCredential() rejects selector/field keywords AND prepositions
 *      (in/for/of/…) so stop-words never become fill values.
 *   2. stripSelectorNoise() removes [attr='x'] / #id / .class fragments before
 *      any prose mining.
 *   3. resolveCaseData() tolerantly binds a free-text reference like
 *      "locked_user" to the real dataset ("locked_users") and selects the
 *      intent-matching record ("locked_out_user").
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const engine: any = new ScriptGenEngine();

console.log('=== looksLikeCredential rejects noise / prepositions ===');
assert(engine.looksLikeCredential('in') === false, "'in' is not a credential");
assert(engine.looksLikeCredential('for') === false, "'for' is not a credential");
assert(engine.looksLikeCredential('username') === false, "'username' keyword is not a value");
assert(engine.looksLikeCredential('password') === false, "'password' keyword is not a value");
assert(engine.looksLikeCredential('locked_out_user') === true, "'locked_out_user' is a credential");
assert(engine.looksLikeCredential('standard_user') === true, "'standard_user' is a credential");

console.log('\n=== stripSelectorNoise removes locator fragments ===');
const stripped = engine.stripSelectorNoise("Enter the username in [data-testid='username'] field");
assert(!/\[/.test(stripped) && !/data-testid/.test(stripped), 'bracketed selector removed');
assert(!/'username'/.test(stripped), "attribute value 'username' no longer present as a quoted token");

console.log('\n=== resolveCaseData binds free-text ref to real dataset + record ===');
// Dataset is plural "locked_users"; the case references singular "locked_user".
const index1 = new Map<string, Map<string, any>>([
  ['locked_users', new Map<string, any>([
    ['locked_out_user', { username: 'locked_out_user', password: 'secret_sauce' }],
  ])],
]);
const tc1: any = { id: 1392, title: 'Locked user login attempt with valid credentials', test_data: 'locked_user' };
const res1 = engine.resolveCaseData(tc1, [
  "Enter the username for the locked account in [data-testid='username'] field.",
  "Enter the password in [data-testid='password'] field.",
], index1);
assert(!!res1, 'a binding was resolved (singular ref → plural dataset)');
assert(res1?.datasetName === 'locked_users', 'bound to dataset "locked_users"');
assert(res1?.value?.username === 'locked_out_user', 'record value carries username "locked_out_user"');

console.log('\n=== resolveCaseData picks the INTENT-matching record, not the first ===');
// A generic dataset with multiple records: a "locked" case must not grab the
// generic first row (standard_user) just because it contains the word "user".
const index2 = new Map<string, Map<string, any>>([
  ['users', new Map<string, any>([
    ['standard_user', { username: 'standard_user', password: 'secret_sauce' }],
    ['locked_out_user', { username: 'locked_out_user', password: 'secret_sauce' }],
  ])],
]);
const tc2: any = { id: 1, title: 'Locked user cannot log in', test_data: 'locked_user' };
const res2 = engine.resolveCaseData(tc2, ['Attempt to log in as the locked user'], index2);
assert(res2?.value?.username === 'locked_out_user', 'locked intent → locked_out_user (not standard_user)');

const tc3: any = { id: 2, title: 'Valid user can log in', test_data: 'valid_user' };
const res3 = engine.resolveCaseData(tc3, ['Log in with valid credentials'], index2);
assert(res3?.value?.username === 'standard_user', 'valid intent → standard_user (first/representative)');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
