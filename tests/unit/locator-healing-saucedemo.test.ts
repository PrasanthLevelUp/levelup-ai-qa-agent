/**
 * End-to-end healing regression for the "Login" button defect.
 *
 * Reproduces the exact failure the user reported: an auto-generated test uses
 *   page.getByRole('button', { name: 'Log in' })
 * but the real element is
 *   <input type="submit" data-test="login-button" id="login-button" value="Login">
 * (accessible name is "Login", NOT "Log in"). Healing must:
 *   1. EXTRACT the failed locator from the modern Playwright "Locator:" error
 *      block AND from the failing code line (so failed_locator is never empty —
 *      empty starves all 3 healing layers + validation).
 *   2. PARSE the getByRole semantic locator (previously unsupported → empty value
 *      → DOM extraction produced nothing).
 *   3. GROUND on the live DOM and prefer the stable [data-test] / id hook over a
 *      fuzzy name guess.
 *
 * Run: npx tsx tests/unit/locator-healing-saucedemo.test.ts
 */
import { extractLocator } from '../../src/core/locator-extractor';
import { parseFailedLocator, DOMCandidateExtractor } from '../../src/engines/dom-candidate-extractor';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

console.log('\n=== 1. Locator extraction ===');

// Modern Playwright error format (the format that was silently unparsed).
const modernErr = [
  'Error: locator.click: Test timeout of 30000ms exceeded.',
  'Call log:',
  "  - waiting for getByRole('button', { name: 'Log in' })",
  '',
  "Locator: getByRole('button', { name: 'Log in' })",
].join('\n');
const fromErr = extractLocator(modernErr);
check('extracts getByRole from modern "Locator:" block',
  fromErr?.rawLocator === "page.getByRole('button', { name: 'Log in' })", JSON.stringify(fromErr));

// Locator: locator('#login-button') variant
const cssErr = "Locator: locator('#login-button')";
const fromCss = extractLocator(cssErr);
check('extracts CSS from "Locator: locator(...)"', fromCss?.rawLocator === '#login-button', JSON.stringify(fromCss));

// Code-line fallback: a bare error with no locator should yield null, but the
// code line always carries it.
const bareErr = 'Error: Timeout 30000ms exceeded.';
check('bare error yields no locator', extractLocator(bareErr) === null);
const fromCode = extractLocator("await page.getByRole('button', { name: 'Log in' }).click();");
check('code-line fallback extracts the locator',
  fromCode?.rawLocator === "page.getByRole('button', { name: 'Log in' })", JSON.stringify(fromCode));

console.log('\n=== 2. Semantic locator parsing ===');

const pRole = parseFailedLocator("page.getByRole('button', { name: 'Log in' })");
check('getByRole parses role + accessible name',
  pRole.attribute === 'role' && pRole.value === 'Log in', JSON.stringify(pRole));

const pTestId = parseFailedLocator("page.getByTestId('login-button')");
check('getByTestId parses to data-testid value',
  pTestId.attribute === 'data-testid' && pTestId.value === 'login-button', JSON.stringify(pTestId));

const pText = parseFailedLocator('page.getByText(/Log in/i)');
check('getByText parses text value', pText.attribute === 'text' && pText.value === 'Log in', JSON.stringify(pText));

const pPlaceholder = parseFailedLocator('page.getByPlaceholder(/Username/i)');
check('getByPlaceholder parses placeholder value',
  pPlaceholder.attribute === 'placeholder' && pPlaceholder.value === 'Username', JSON.stringify(pPlaceholder));

console.log('\n=== 3. DOM grounding → stable selector ===');

// Realistic serialized SauceDemo login DOM (void inputs written WITHOUT a slash,
// exactly as page.content() emits them).
const loginDom = `
<html><body>
<form class="login-box">
  <input type="text" data-test="username" id="user-name" name="user-name" placeholder="Username" class="input_error form_input">
  <input type="password" data-test="password" id="password" name="password" placeholder="Password" class="input_error form_input">
  <input type="submit" class="submit-button btn_action" data-test="login-button" id="login-button" name="login-button" value="Login">
</form>
</body></html>`;

const extractor = new DOMCandidateExtractor();
const res = extractor.extractFromHTML(
  loginDom,
  "page.getByRole('button', { name: 'Log in' })",
  "await page.getByRole('button', { name: 'Log in' }).click();",
);

const top = res.candidates[0];
check('DOM extraction finds candidates', res.candidates.length > 0, `count=${res.candidates.length}`);
check('top candidate is the stable data-test hook',
  !!top && top.selector === `page.locator('[data-test="login-button"]')`,
  top ? `${top.selector} (score ${top.score})` : 'none');
check('top candidate score is high', !!top && top.score >= 0.9, top ? String(top.score) : 'none');

// The username field (getByPlaceholder) should also ground to its stable hook.
const userRes = extractor.extractFromHTML(loginDom, 'page.getByPlaceholder(/Usernam/i)', '');
const userTop = userRes.candidates[0];
check('username placeholder grounds to a stable hook',
  !!userTop && (userTop.selector === `page.locator('[data-test="username"]')` || userTop.selector === '#user-name'),
  userTop ? userTop.selector : 'none');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
