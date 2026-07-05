/**
 * Locator PROSE consistency for the generated spec's human-readable steps.
 *
 * Defect this guards: the Test Case Lab LLM frequently writes step prose such
 * as "Enter the username in [data-testid='username'] field" even when the real
 * app exposes its test hook as `data-test` (SauceDemo). The EXECUTABLE code was
 * already grounded correctly (`page.locator('[data-test="username"]')`), so the
 * generated spec's comments CONTRADICTED its own code — eroding user trust in
 * the locators. `ScriptGenEngine.detectTestHookAttr` + `normalizeStepSelectors`
 * rewrite the hallucinated attribute NAME in prose to the attribute actually
 * observed in the crawled DOM, without touching the value or surrounding text.
 *
 * Run: npx tsx tests/unit/locator-prose-normalizer.test.ts
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const el = (o: any) => ({ tag: 'input', textContent: '', attributes: {}, visible: true, required: false, disabled: false, ...o });

// Realistic SauceDemo crawl: the primary test hook is `data-test` (NOT
// `data-testid`), stored in the raw `attributes` map by the crawler.
const saucedemoCrawl: any = {
  url: 'https://www.saucedemo.com/', title: 'Swag Labs',
  elements: [
    el({ tag: 'input', id: 'user-name', attributes: { 'data-test': 'username', id: 'user-name' } }),
    el({ tag: 'input', id: 'password', attributes: { 'data-test': 'password', id: 'password' } }),
    el({ tag: 'input', id: 'login-button', attributes: { 'data-test': 'login-button', id: 'login-button' } }),
    el({ tag: 'h3', attributes: { 'data-test': 'error' } }),
  ],
};

const engine: any = new ScriptGenEngine();

console.log('\n=== Test-hook attribute detection ===');

// Detects the dominant test hook actually present in the crawl.
const detected = engine.detectTestHookAttr(saucedemoCrawl);
check('detects data-test on a SauceDemo-style crawl', detected === 'data-test', String(detected));

// No crawl / empty crawl / no test hooks → undefined (never guess).
check('undefined for empty crawl', engine.detectTestHookAttr({ url: 'x', elements: [] }) === undefined);
check('undefined for missing crawl', engine.detectTestHookAttr(undefined) === undefined);
check(
  'undefined when the DOM exposes no test hook',
  engine.detectTestHookAttr({ url: 'x', elements: [el({ attributes: { id: 'foo', class: 'bar' } })] }) === undefined,
);

// When both data-test and data-testid appear, the more frequent one wins.
const mixed: any = { url: 'x', elements: [
  el({ attributes: { 'data-test': 'a' } }),
  el({ attributes: { 'data-test': 'b' } }),
  el({ attributes: { 'data-testid': 'c' } }),
] };
check('dominant hook wins on a mixed crawl', engine.detectTestHookAttr(mixed) === 'data-test');

console.log('\n=== Prose selector normalization ===');

// The core fix: hallucinated data-testid in prose → real data-test.
check(
  "rewrites [data-testid='username'] → [data-test='username']",
  engine.normalizeStepSelectors("Enter the username in [data-testid='username'] field", 'data-test')
    === "Enter the username in [data-test='username'] field",
  engine.normalizeStepSelectors("Enter the username in [data-testid='username'] field", 'data-test'),
);

// Bare (unbracketed) attribute form with double quotes is handled too.
check(
  'rewrites bare data-testid="password" → data-test="password"',
  engine.normalizeStepSelectors('Type into data-testid="password"', 'data-test')
    === 'Type into data-test="password"',
  engine.normalizeStepSelectors('Type into data-testid="password"', 'data-test'),
);

// Other common synonyms normalize to the real hook.
check(
  "rewrites [data-cy='login'] → [data-test='login']",
  engine.normalizeStepSelectors("Click [data-cy='login']", 'data-test') === "Click [data-test='login']",
);
check(
  "rewrites [data-qa='submit'] → [data-test='submit']",
  engine.normalizeStepSelectors("Click [data-qa='submit']", 'data-test') === "Click [data-test='submit']",
);

// The attribute VALUE and all surrounding prose are preserved verbatim.
check(
  'preserves value + surrounding text',
  engine.normalizeStepSelectors("Then verify [data-testid='error'] shows the banner.", 'data-test')
    === "Then verify [data-test='error'] shows the banner.",
);

// Multiple occurrences in one step are all rewritten.
check(
  'rewrites every occurrence in a step',
  engine.normalizeStepSelectors("Fill [data-testid='username'] and [data-testid='password']", 'data-test')
    === "Fill [data-test='username'] and [data-test='password']",
);

console.log('\n=== Safety / no-op guards ===');

// No real attribute known → prose is left completely untouched.
check(
  'no-op when realAttr is undefined',
  engine.normalizeStepSelectors("Enter [data-testid='username']", undefined)
    === "Enter [data-testid='username']",
);

// Already-correct prose is unchanged (synonym === realAttr is skipped).
check(
  'no-op when prose already uses the real hook',
  engine.normalizeStepSelectors("Enter [data-test='username']", 'data-test')
    === "Enter [data-test='username']",
);

// Word-boundary safety: when the real hook is `data-testid`, a `data-test=`
// reference is upgraded, but an existing `data-testid=` is NOT partially
// clobbered into `data-testidid`.
check(
  'data-test → data-testid when that is the real hook',
  engine.normalizeStepSelectors("Enter [data-test='username']", 'data-testid')
    === "Enter [data-testid='username']",
  engine.normalizeStepSelectors("Enter [data-test='username']", 'data-testid'),
);
check(
  'never double-suffixes an existing data-testid',
  engine.normalizeStepSelectors("Enter [data-testid='username']", 'data-testid')
    === "Enter [data-testid='username']",
  engine.normalizeStepSelectors("Enter [data-testid='username']", 'data-testid'),
);

// Plain prose with no selector reference is untouched.
check(
  'plain prose without a selector is untouched',
  engine.normalizeStepSelectors('Assert the user lands on the inventory page', 'data-test')
    === 'Assert the user lands on the inventory page',
);

// A bare word "data-testid" NOT followed by `=` (not a selector) is left alone.
check(
  'does not rewrite a non-selector mention of the attribute name',
  engine.normalizeStepSelectors('The data-testid attribute is missing here', 'data-test')
    === 'The data-testid attribute is missing here',
);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
