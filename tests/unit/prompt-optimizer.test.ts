/**
 * Unit tests for the Prompt Optimizer Engine.
 *
 * The optimizer is PURE + synchronous (zero LLM tokens), so the whole suite
 * runs offline with no API key or engine construction.
 *
 * Run with: npx jest tests/unit/prompt-optimizer.test.ts
 */

import {
  estimateTokens,
  buildPromptBreakdown,
  estimateCostUsd,
  optimizeKnowledgeForCategory,
} from '../../src/engines/prompt-optimizer';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function bigProfileKnowledge() {
  return {
    applicationProfile: {
      name: 'Shop',
      pages: [
        { url: '/login', title: 'Login', pageType: 'auth', elementCount: 5, formCount: 1 },
        { url: '/register', title: 'Sign Up', pageType: 'auth', elementCount: 8, formCount: 1 },
        { url: '/products', title: 'Products', pageType: 'catalog', elementCount: 40, formCount: 0 },
        { url: '/cart', title: 'Cart', pageType: 'cart', elementCount: 20, formCount: 1 },
        { url: '/checkout', title: 'Checkout', pageType: 'checkout', elementCount: 30, formCount: 2 },
        { url: '/contact', title: 'Contact Us', pageType: 'info', elementCount: 6, formCount: 1 },
        { url: '/subscribe', title: 'Subscription', pageType: 'marketing', elementCount: 4, formCount: 1 },
      ],
      forms: [
        { page: '/login', action: '/auth', method: 'POST', fields: [{ name: 'email', type: 'email' }, { name: 'password', type: 'password' }] },
        { page: '/products', action: '/search', method: 'GET', fields: [{ name: 'q', type: 'text' }] },
        { page: '/checkout', action: '/order', method: 'POST', fields: [{ name: 'address', type: 'text' }] },
        { page: '/contact', action: '/msg', method: 'POST', fields: [{ name: 'message', type: 'text' }] },
      ],
      keyElements: [
        { label: 'Email', tag: 'input', selector: '#email' },
        { label: 'Password', tag: 'input', selector: '#password' },
        { label: 'Login button', tag: 'button', selector: '#login-btn' },
        { label: 'Add to cart', tag: 'button', selector: '#add-cart' },
        { label: 'Search', tag: 'input', selector: '#search' },
        { label: 'Checkout', tag: 'button', selector: '#checkout' },
        { label: 'Newsletter', tag: 'input', selector: '#news' },
      ],
    },
    testData: [
      { name: 'valid_users', environment: 'qa', recordCount: 10, sampleKeys: ['email', 'password', 'role'] },
      { name: 'products_catalog', environment: 'qa', recordCount: 200, sampleKeys: ['sku', 'price'] },
      { name: 'checkout_orders', environment: 'qa', recordCount: 15, sampleKeys: ['orderId', 'total'] },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  estimateTokens                                                     */
/* ------------------------------------------------------------------ */

describe('estimateTokens', () => {
  it('approximates ~4 chars/token', () => {
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-5)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  buildPromptBreakdown                                               */
/* ------------------------------------------------------------------ */

describe('buildPromptBreakdown', () => {
  it('sums chars, estimates tokens, and computes percentages', () => {
    const bd = buildPromptBreakdown([
      { key: 'a', label: 'A', text: 'x'.repeat(300) },
      { key: 'b', label: 'B', text: 'x'.repeat(100) },
    ]);
    expect(bd.totalChars).toBe(400);
    expect(bd.totalEstimatedTokens).toBe(100);
    const a = bd.sections.find(s => s.key === 'a')!;
    expect(a.pctOfPrompt).toBe(75);
    expect(a.estimatedTokens).toBe(75);
  });

  it('reports empty sections as 0 (never divides by zero)', () => {
    const bd = buildPromptBreakdown([{ key: 'a', label: 'A', text: '' }]);
    expect(bd.totalChars).toBe(0);
    expect(bd.sections[0].pctOfPrompt).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  estimateCostUsd                                                    */
/* ------------------------------------------------------------------ */

describe('estimateCostUsd', () => {
  it('uses explicit rates and rounds to 6 decimals', () => {
    const cost = estimateCostUsd(1000, 1000, { inputPer1k: 0.003, outputPer1k: 0.015 });
    expect(cost).toBeCloseTo(0.018, 6);
  });
  it('never returns negative', () => {
    expect(estimateCostUsd(-100, -100)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  optimizeKnowledgeForCategory                                       */
/* ------------------------------------------------------------------ */

describe('optimizeKnowledgeForCategory', () => {
  it('trims a big profile down to authentication-relevant context', () => {
    const k = bigProfileKnowledge();
    const before = k.applicationProfile.pages.length;
    const res = optimizeKnowledgeForCategory(k, 'User logs in with email and password', {
      category: 'authentication',
      confidence: 1,
    });
    expect(res.stats.applied).toBe(true);
    expect(res.stats.category).toBe('authentication');
    // Must have dropped irrelevant pages (products, subscription, contact...)
    expect(res.knowledge!.applicationProfile!.pages!.length).toBeLessThan(before);
    // Must keep the login + register pages.
    const urls = res.knowledge!.applicationProfile!.pages!.map((p: any) => p.url);
    expect(urls).toContain('/login');
    expect(urls).toContain('/register');
    // Must keep the credential test-data set, drop the catalog.
    const dsNames = res.knowledge!.testData!.map((d: any) => d.name);
    expect(dsNames).toContain('valid_users');
  });

  it('does NOT mutate the original knowledge object', () => {
    const k = bigProfileKnowledge();
    const originalPageCount = k.applicationProfile.pages.length;
    optimizeKnowledgeForCategory(k, 'login', { category: 'authentication', confidence: 1 });
    expect(k.applicationProfile.pages.length).toBe(originalPageCount);
  });

  it('passes through unchanged for generic category (fail-open)', () => {
    const k = bigProfileKnowledge();
    const res = optimizeKnowledgeForCategory(k, 'something vague', { category: 'generic', confidence: 0 });
    expect(res.stats.applied).toBe(false);
    expect(res.knowledge).toBe(k); // same reference — no trimming
  });

  it('passes through unchanged when confidence is below threshold', () => {
    const k = bigProfileKnowledge();
    const res = optimizeKnowledgeForCategory(k, 'login', {
      category: 'authentication', confidence: 0.2, minConfidence: 0.5,
    });
    expect(res.stats.applied).toBe(false);
    expect(res.knowledge).toBe(k);
  });

  it('keeps a safe floor — never empties a populated section', () => {
    const k = {
      applicationProfile: {
        pages: [
          { url: '/a', title: 'A', pageType: 'x' },
          { url: '/b', title: 'B', pageType: 'y' },
          { url: '/c', title: 'C', pageType: 'z' },
          { url: '/d', title: 'D', pageType: 'w' },
          { url: '/e', title: 'E', pageType: 'v' },
        ],
      },
      testData: [],
    };
    // Category vocab that matches none of the generic page names → floor kept.
    const res = optimizeKnowledgeForCategory(k, 'payment card billing', {
      category: 'payment', confidence: 1,
    });
    const pages = res.knowledge!.applicationProfile!.pages!;
    expect(pages.length).toBeGreaterThanOrEqual(3); // KEEP_MIN.pages floor
    expect(pages.length).toBeLessThan(5);
  });

  it('is deterministic — same input yields identical output', () => {
    const a = optimizeKnowledgeForCategory(bigProfileKnowledge(), 'login email password', { category: 'authentication', confidence: 1 });
    const b = optimizeKnowledgeForCategory(bigProfileKnowledge(), 'login email password', { category: 'authentication', confidence: 1 });
    expect(JSON.stringify(a.knowledge)).toBe(JSON.stringify(b.knowledge));
    expect(JSON.stringify(a.stats)).toBe(JSON.stringify(b.stats));
  });

  it('returns no-knowledge stats when knowledge is undefined', () => {
    const res = optimizeKnowledgeForCategory(undefined, 'login', { category: 'authentication', confidence: 1 });
    expect(res.knowledge).toBeUndefined();
    expect(res.stats.applied).toBe(false);
  });

  it('trims checkout requirements to cart/checkout/product context', () => {
    const k = bigProfileKnowledge();
    const res = optimizeKnowledgeForCategory(k, 'User reviews cart and places an order at checkout', {
      category: 'checkout',
      confidence: 1,
    });
    expect(res.stats.applied).toBe(true);
    const urls = res.knowledge!.applicationProfile!.pages!.map((p: any) => p.url);
    expect(urls).toContain('/checkout');
    expect(urls).toContain('/cart');
  });
});
