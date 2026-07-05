/**
 * Element Intelligence — the single shared locator-ranking brain.
 *
 * These tests lock the CANONICAL ranking contract that BOTH Script Generation
 * (`resolveGroundedSelectorTracked`) and Healing (`buildGroundedCandidates`)
 * now consume, so the two engines can never again diverge on "what is the best
 * locator for this element". The design decision under test:
 *
 *   data-test (0.96) > data-testid > data-cy > data-qa > role+name (0.90)
 *   > stable id (0.85) > name > placeholder/label > text
 *
 * i.e. a dedicated automation contract (`data-test`) OUTRANKS a raw `id`, and
 * dynamic/framework ids are never offered as primary.
 *
 * Run: npx tsx tests/unit/element-intelligence.test.ts
 */
import {
  rankLocatorCandidates,
  buildElementIntelligence,
  resolveByIntent,
  deriveSemanticName,
  collectElements,
  isDynamicId,
  type ElementLike,
} from '../../src/intelligence/element-intelligence';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const el = (o: any): ElementLike => ({ tag: 'input', textContent: '', attributes: {}, ...o });

// Realistic SauceDemo login crawl (as the PageCrawler stores it): the primary
// automation hook lives in `attributes['data-test']`, alongside a real `id`.
const crawl: any = {
  url: 'https://www.saucedemo.com/',
  title: 'Swag Labs',
  elements: [
    el({ tag: 'input', type: 'text', id: 'user-name', name: 'user-name', placeholder: 'Username', attributes: { 'data-test': 'username', id: 'user-name' } }),
    el({ tag: 'input', type: 'password', id: 'password', name: 'password', placeholder: 'Password', attributes: { 'data-test': 'password', id: 'password' } }),
    el({ tag: 'input', type: 'submit', id: 'login-button', name: 'login-button', textContent: 'Login', attributes: { 'data-test': 'login-button', id: 'login-button' } }),
    el({ tag: 'span', textContent: 'Products', className: 'title', attributes: { 'data-test': 'title', class: 'title' } }),
    el({ tag: 'h3', textContent: '', className: 'error-message-container', attributes: { 'data-test': 'error' } }),
  ],
};

console.log('\n=== Element Intelligence: canonical ranking ===');

// --- rankLocatorCandidates: data-test outranks id -------------------------
const userCands = rankLocatorCandidates(crawl.elements[0]);
check('username produces ranked candidates', userCands.length > 0, JSON.stringify(userCands.map((c) => c.strategy)));
check('username PRIMARY is data-test (not id)', userCands[0].strategy === 'data-test', userCands[0]?.strategy);
check('username primary locator is concrete', userCands[0].locator === `page.locator('[data-test="username"]')`, userCands[0]?.locator);
check('username primary confidence is high (>=0.9)', userCands[0].confidence >= 0.9, String(userCands[0]?.confidence));
check('username primary carries reasoning', !!userCands[0].reasoning && userCands[0].reasoning.length > 0);
check('id appears LOWER than data-test in ranking', (() => {
  const dt = userCands.findIndex((c) => c.strategy === 'data-test');
  const id = userCands.findIndex((c) => c.strategy === 'id');
  return dt >= 0 && (id === -1 || dt < id);
})(), JSON.stringify(userCands.map((c) => c.strategy)));
check('candidates are sorted by descending confidence', (() => {
  for (let i = 1; i < userCands.length; i++) if (userCands[i].confidence > userCands[i - 1].confidence) return false;
  return true;
})());

// --- role+name outranks id for a labelled button --------------------------
const btnCands = rankLocatorCandidates(el({ tag: 'button', id: 'submit-btn', textContent: 'Log in', attributes: { id: 'submit-btn' } }));
check('labelled button offers a role candidate', btnCands.some((c) => c.strategy === 'role'), JSON.stringify(btnCands.map((c) => c.strategy)));
check('role ranks above id for labelled button', (() => {
  const r = btnCands.findIndex((c) => c.strategy === 'role');
  const id = btnCands.findIndex((c) => c.strategy === 'id');
  return r >= 0 && (id === -1 || r < id);
})(), JSON.stringify(btnCands.map((c) => c.strategy)));

// --- dynamic ids are never offered ----------------------------------------
check('isDynamicId flags framework hashes', isDynamicId('ember1234') && isDynamicId('css-1a2b3c') && isDynamicId(':r0:'));
check('isDynamicId accepts stable ids', !isDynamicId('user-name') && !isDynamicId('login-button'));
const dynCands = rankLocatorCandidates(el({ tag: 'input', id: 'input-9f8e7d6c5b4a', placeholder: 'Email', attributes: { id: 'input-9f8e7d6c5b4a' } }));
check('dynamic id is NOT used as a candidate', !dynCands.some((c) => c.strategy === 'id' && c.css.includes('9f8e7d6c5b4a')), JSON.stringify(dynCands.map((c) => c.css)));
check('element with only a dynamic id still resolves via placeholder', dynCands.some((c) => c.strategy === 'placeholder'), JSON.stringify(dynCands.map((c) => c.strategy)));

console.log('\n=== Element Intelligence: buildElementIntelligence ===');
const profile = buildElementIntelligence(crawl);
check('builds one record per addressable element', profile.length === 5, String(profile.length));
check('every record has a primary + candidates', profile.every((p) => p.primary && p.candidates.length > 0));
check('every record has a semanticName', profile.every((p) => !!p.semanticName));
check('records sorted by descending confidence', (() => {
  for (let i = 1; i < profile.length; i++) if (profile[i].confidence > profile[i - 1].confidence) return false;
  return true;
})());
const userRec = profile.find((p) => p.primary && p.primary.css.includes('username'));
check('username record primary is data-test', !!userRec && userRec.primary!.strategy === 'data-test');
check('username record classified as input', !!userRec && userRec.category === 'input', userRec?.category);

console.log('\n=== Element Intelligence: deriveSemanticName ===');
check('derives "Username" from data-test hook', /user/i.test(deriveSemanticName(crawl.elements[0])), deriveSemanticName(crawl.elements[0]));
check('derives a name for the login button', /log\s?in|login/i.test(deriveSemanticName(crawl.elements[2])), deriveSemanticName(crawl.elements[2]));

console.log('\n=== Element Intelligence: resolveByIntent ===');
const els = collectElements(crawl);
const uname = resolveByIntent(els, 'enter the username');
check('resolveByIntent("username") finds an element', !!uname);
check('resolveByIntent("username") returns data-test primary', !!uname && uname.candidates[0].strategy === 'data-test', uname?.candidates[0]?.strategy);
const loginBtn = resolveByIntent(els, 'click the login button');
check('resolveByIntent("login button") finds the button', !!loginBtn && loginBtn.candidates[0].css.includes('login-button'), loginBtn?.candidates[0]?.css);
check('resolveByIntent gibberish returns null', resolveByIntent(els, 'zzzqqq nonsense token') === null);

console.log('\n=== Element Intelligence: empty / edge inputs ===');
check('empty crawl yields no intelligence', buildElementIntelligence({ url: 'x', elements: [] }).length === 0);
check('collectElements tolerates undefined', collectElements(undefined).length === 0);
check('element with nothing addressable yields no candidates', rankLocatorCandidates(el({ tag: 'div', textContent: '', attributes: {} })).length === 0);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
