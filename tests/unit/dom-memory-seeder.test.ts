/**
 * Unit tests — DOM Memory Seeder (Phase 2: DOM Snapshot Persistence)
 * ==================================================================
 * Proves the moat is no longer cold: a crawl now produces linked
 * `selector_history` rows, so DOM Memory has alternatives to offer on day one
 * — before any failure has ever occurred. All assertions are DB-free (they
 * exercise the pure `buildSeedRows` + `deriveElementIdentifier`).
 *
 * Run: npx tsx tests/unit/dom-memory-seeder.test.ts
 */

import assert from 'node:assert';
import {
  buildSeedRows,
  deriveElementIdentifier,
} from '../../src/services/dom-memory-seeder';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: any) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

/* A realistic SauceDemo-style crawl: a few interactive elements. */
const sauceCrawl = {
  interactiveElements: [
    { tag: 'input', type: 'text', id: 'user-name', name: 'user-name', placeholder: 'Username',
      attributes: { 'data-test': 'username', id: 'user-name', name: 'user-name', placeholder: 'Username' } },
    { tag: 'input', type: 'password', id: 'password', name: 'password', placeholder: 'Password',
      attributes: { 'data-test': 'password', id: 'password', name: 'password' } },
    { tag: 'input', type: 'submit', id: 'login-button', name: 'login-button', value: 'Login',
      textContent: 'Login',
      attributes: { 'data-test': 'login-button', id: 'login-button', type: 'submit', value: 'Login' } },
  ],
};

/* ---- 1. deriveElementIdentifier ---- */
console.log('deriveElementIdentifier:');
check('data-test wins as identifier',
  deriveElementIdentifier({ tag: 'input', attributes: { 'data-test': 'login-button' } } as any) === 'data-test:login-button');
check('stable id used when no data-* attr',
  deriveElementIdentifier({ tag: 'input', id: 'email', attributes: {} } as any) === 'id:email');
check('dynamic id rejected → falls back',
  deriveElementIdentifier({ tag: 'button', id: 'mui-12345', textContent: 'Save', attributes: {} } as any) === 'button:save');
check('returns null when nothing stable',
  deriveElementIdentifier({ tag: 'div', attributes: {} } as any) === null);

/* ---- 2. buildSeedRows produces grounded, linked rows ---- */
console.log('\nbuildSeedRows:');
const { rows, elementsScanned, elementsKept } = buildSeedRows({
  crawlData: sauceCrawl,
  pageUrl: 'https://www.saucedemo.com',
  projectId: 7,
  companyId: 3,
});

check('scanned all 3 elements', elementsScanned === 3, elementsScanned);
check('kept all 3 elements', elementsKept === 3, elementsKept);
check('produced multiple selector rows', rows.length >= 6, rows.length);
check('every row is source=crawl', rows.every((r) => r.source === 'crawl'));
check('every row carries tenant scope', rows.every((r) => r.projectId === 7 && r.companyId === 3));
check('every row carries an elementIdentifier', rows.every((r) => !!r.elementIdentifier));

/* The login button must be seeded with its data-test selector AND a role/name
   alternative, both sharing ONE identifier — that linkage is what lets DOM
   Memory return alternatives when any one of them fails. */
const loginRows = rows.filter((r) => r.elementIdentifier === 'data-test:login-button');
check('login button seeded under one shared identifier', loginRows.length >= 2, loginRows.length);
check('login button data-test selector present',
  loginRows.some((r) => r.selector === `page.locator('[data-test="login-button"]')`),
  loginRows.map((r) => r.selector));
check('login button has >1 distinct selector (real alternatives)',
  new Set(loginRows.map((r) => r.selector)).size >= 2);

/* ---- 3. de-duplication ---- */
console.log('\nde-duplication:');
const dupCrawl = { interactiveElements: [sauceCrawl.interactiveElements[2], sauceCrawl.interactiveElements[2]] };
const dup = buildSeedRows({ crawlData: dupCrawl, pageUrl: 'u', projectId: 1, companyId: 1 });
const loginDup = dup.rows.filter((r) => r.elementIdentifier === 'data-test:login-button');
check('duplicate element does not double-insert identical selectors',
  loginDup.length === new Set(loginDup.map((r) => r.selector)).size, loginDup.map((r) => r.selector));

/* ---- 4. empty / junk input is safe ---- */
console.log('\nedge cases:');
check('empty crawl → no rows', buildSeedRows({ crawlData: {}, pageUrl: 'u' }).rows.length === 0);
check('null crawl → no rows', buildSeedRows({ crawlData: null, pageUrl: 'u' }).rows.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
