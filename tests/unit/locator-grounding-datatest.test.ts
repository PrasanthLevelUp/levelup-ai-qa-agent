/**
 * Locator grounding for `data-test`-based apps (SauceDemo et al.).
 *
 * Regression guard for the "REAL LOCATORS 0/N" defect: many real apps expose
 * their primary test hook as `data-test="..."` (NOT `data-testid`). The crawler
 * keeps `data-test` only in the raw `attributes` map, so the grounding matcher
 * must read it from there — otherwise titles, error banners and cart/inventory
 * nodes that have no `id` silently fall back and the grounding report collapses
 * to 0%. These tests assert such elements ground against a realistic crawl.
 *
 * Run: npx tsx tests/unit/locator-grounding-datatest.test.ts
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const el = (o: any) => ({ tag: 'input', textContent: '', attributes: {}, visible: true, required: false, disabled: false, ...o });

// Realistic SauceDemo crawl as the PageCrawler stores it: `data-test` lives in
// `attributes` (the crawler does NOT promote it to the dataTestId field).
const crawl: any = {
  url: 'https://www.saucedemo.com/', title: 'Swag Labs',
  elements: [
    el({ tag: 'input', type: 'text', id: 'user-name', name: 'user-name', placeholder: 'Username', attributes: { 'data-test': 'username', id: 'user-name' } }),
    el({ tag: 'input', type: 'password', id: 'password', name: 'password', placeholder: 'Password', attributes: { 'data-test': 'password', id: 'password' } }),
    el({ tag: 'input', type: 'submit', id: 'login-button', name: 'login-button', textContent: 'Login', attributes: { 'data-test': 'login-button', id: 'login-button' } }),
    el({ tag: 'span', textContent: 'Products', className: 'title', attributes: { 'data-test': 'title', class: 'title' } }),
    el({ tag: 'h3', textContent: '', className: 'error-message-container', attributes: { 'data-test': 'error' } }),
    el({ tag: 'a', textContent: '', className: 'shopping_cart_link', attributes: { 'data-test': 'shopping-cart-link', class: 'shopping_cart_link' } }),
    el({ tag: 'div', textContent: 'Sauce Labs Backpack', className: 'inventory_item', attributes: { 'data-test': 'inventory-item', class: 'inventory_item' } }),
  ],
};

const engine: any = new ScriptGenEngine();
const { tracked } = engine.buildGroundedSelectors(crawl);

console.log('\n=== Locator grounding (data-test) ===');

// Elements with an id still ground via id.
check('username grounds via id', tracked.username.grounded && tracked.username.source === 'id');
check('password grounds via id', tracked.password.grounded && tracked.password.source === 'id');
check('login grounds via id', tracked.login.grounded && tracked.login.source === 'id');

// Elements that expose ONLY data-test (no id) must ground via data-test.
check('title grounds via data-test', tracked.title.grounded && tracked.title.source === 'data-test', JSON.stringify(tracked.title));
check('error grounds via data-test', tracked.error.grounded && tracked.error.source === 'data-test', JSON.stringify(tracked.error));
check('cart grounds via data-test', tracked.cart.grounded && tracked.cart.source === 'data-test', JSON.stringify(tracked.cart));
check('inventoryItem grounds via data-test', tracked.inventoryItem.grounded && tracked.inventoryItem.source === 'data-test', JSON.stringify(tracked.inventoryItem));

// data-test selectors must be concrete attribute locators, never a fallback guess.
check('cart selector is a concrete data-test locator', tracked.cart.selector === `page.locator('[data-test="shopping-cart-link"]')`, tracked.cart.selector);
check('error selector is a concrete data-test locator', tracked.error.selector === `page.locator('[data-test="error"]')`, tracked.error.selector);

// Aggregate: the 7 login-flow elements should now ALL ground (was 4/7 before).
const loginFlow = ['username', 'password', 'login', 'title', 'error', 'cart', 'inventoryItem'];
const groundedLogin = loginFlow.filter((k) => tracked[k].grounded).length;
check(`all 7 login-flow locators ground (got ${groundedLogin}/7)`, groundedLogin === 7);

// Elements genuinely absent from the crawl (post-login chrome) must NOT be
// falsely reported as grounded — honesty in both directions.
check('absent menu stays ungrounded', !tracked.menu.grounded && tracked.menu.source === 'fallback');
check('absent logout stays ungrounded', !tracked.logout.grounded && tracked.logout.source === 'fallback');

// An empty crawl grounds nothing (reproduces the "0/7" cache bug at the engine level).
const { tracked: emptyTracked } = engine.buildGroundedSelectors({ url: 'x', elements: [] });
const anyGrounded = Object.values<any>(emptyTracked).some((v) => v.grounded);
check('empty crawl grounds nothing (0%)', !anyGrounded);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
