/**
 * Multi-page cached profile grounding.
 *
 * Regression guard for the "REAL LOCATORS 0/N with a non-empty profile" defect.
 * Deep/multi-page profiles (saveDeepCrawlResult) store the DOM under
 * `pages[].elements` with NO flat top-level `elements` array, while single-page
 * profiles store a flat `elements`. The engine's fast path read only the flat
 * array, so a 6-page / 82-element profile arrived at the matcher as 0 elements →
 * every locator (even id-based) fell back → 0% grounded. The fast path now
 * flattens per-page arrays; this test proves a multi-page blob grounds.
 *
 * Run: npx tsx tests/unit/multipage-cache-grounding.test.ts
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const el = (o: any) => ({ tag: 'input', textContent: '', attributes: {}, visible: true, required: false, disabled: false, ...o });

// Multi-page profile blob exactly as saveDeepCrawlResult persists it: elements
// live under pages[].elements; there is NO top-level `elements`.
const cachedCrawlData: any = {
  multiPage: true, entryUrl: 'https://www.saucedemo.com/', pageCount: 2,
  pages: [
    { url: 'https://www.saucedemo.com/', title: 'Swag Labs', pageType: 'login', elements: [
      el({ tag: 'input', type: 'text', id: 'user-name', name: 'user-name', attributes: { 'data-test': 'username', id: 'user-name' } }),
      el({ tag: 'input', type: 'password', id: 'password', name: 'password', attributes: { 'data-test': 'password', id: 'password' } }),
      el({ tag: 'input', type: 'submit', id: 'login-button', textContent: 'Login', attributes: { 'data-test': 'login-button', id: 'login-button' } }),
    ]},
    { url: 'https://www.saucedemo.com/inventory.html', title: 'Products', pageType: 'inventory', elements: [
      el({ tag: 'span', textContent: 'Products', className: 'title', attributes: { 'data-test': 'title', class: 'title' } }),
      el({ tag: 'a', textContent: '', className: 'shopping_cart_link', attributes: { 'data-test': 'shopping-cart-link', class: 'shopping_cart_link' } }),
    ]},
  ],
};

const engine: any = new ScriptGenEngine();
const config: any = {
  url: 'https://www.saucedemo.com/', framework: 'playwright', language: 'typescript', cachedCrawlData,
  testCase: {
    id: 1216, title: 'Valid login', test_data: 'standard_user from valid_users',
    expected_result: 'redirected to the Inventory page',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter valid username from valid_users: standard_user', 'Enter password <password>', 'Click the login button'],
  },
};

(async () => {
  console.log('\n=== Multi-page cache grounding ===');
  const result = await engine.generate(config);
  const g = result.locatorGrounding;

  check('grounding report is present', !!g, JSON.stringify(g));
  check('elements were flattened from pages (grounded > 0)', !!g && g.groundedCount > 0,
    g ? `${g.groundedCount}/${g.total}` : 'none');
  check('id-based locators ground (not fallback)', !!g && g.entries.some((e: any) => e.name === 'username' && e.grounded && e.source === 'id'));
  check('data-test locator from a SECOND page grounds', !!g && g.entries.some((e: any) => e.name === 'title' && e.grounded && e.source === 'data-test'));
  check('grounded percentage is 100% for this flow', !!g && g.groundedPct === 100, g ? `${g.groundedPct}%` : 'none');

  // Guard: a multi-page blob with empty page element arrays still grounds nothing
  // (honest 0%) rather than throwing.
  const emptyResult = await engine.generate({
    ...config,
    cachedCrawlData: { multiPage: true, pageCount: 1, pages: [{ url: 'x', elements: [] }] },
  });
  check('empty multi-page blob grounds nothing (honest 0%)',
    !emptyResult.locatorGrounding || emptyResult.locatorGrounding.groundedCount === 0);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
