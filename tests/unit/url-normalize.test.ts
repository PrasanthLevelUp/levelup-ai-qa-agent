/**
 * Regression tests for canonical base-URL normalization (src/utils/url-normalize.ts).
 *
 * BUG BEING GUARDED
 * -----------------
 * Application profiles are upserted with an ON CONFLICT key derived from
 * base_url. The manual-create path used to store the raw URL the user typed,
 * while the crawl-completion path stored a normalized URL. When these differed
 * the conflict missed → a DUPLICATE profile row was inserted (status 'fresh')
 * and the ORIGINAL row stayed stuck in 'crawling' forever.
 *
 * These tests assert that every realistic user-typed variant of the same site
 * collapses to ONE identical key, and that the normalizer is idempotent.
 *
 * Run with:  npx tsx tests/unit/url-normalize.test.ts
 */
import { normalizeBaseUrl } from '../../src/utils/url-normalize';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

function eq(name: string, got: string, want: string) {
  check(name, got === want, `→ got "${got}", want "${want}"`);
}

console.log('url-normalize: canonical key');
eq('plain host gets root path', normalizeBaseUrl('https://example.com'), 'https://example.com/');
eq('trailing slash stripped to root', normalizeBaseUrl('https://example.com/'), 'https://example.com/');
eq('uppercase scheme/host lowercased', normalizeBaseUrl('HTTPS://EXAMPLE.COM/'), 'https://example.com/');
eq('path trailing slash stripped', normalizeBaseUrl('https://example.com/app/'), 'https://example.com/app');
eq('query string dropped', normalizeBaseUrl('https://example.com/app?x=1'), 'https://example.com/app');
eq('hash fragment dropped', normalizeBaseUrl('https://example.com/app#top'), 'https://example.com/app');
eq('surrounding whitespace trimmed', normalizeBaseUrl('  https://example.com/  '), 'https://example.com/');
eq('default https port dropped', normalizeBaseUrl('https://example.com:443/'), 'https://example.com/');
eq('non-default port kept', normalizeBaseUrl('http://localhost:3000/'), 'http://localhost:3000/');

console.log('url-normalize: all variants collapse to ONE key (the duplicate-profile guard)');
const variants = [
  'https://Example.com',
  'https://example.com/',
  'HTTPS://EXAMPLE.COM/',
  '  https://example.com  ',
  'https://example.com:443',
  'https://example.com/?utm=1',
];
const keys = new Set(variants.map(normalizeBaseUrl));
check('exactly one canonical key for all variants', keys.size === 1, `→ got ${keys.size} keys: ${[...keys].join(', ')}`);

console.log('url-normalize: idempotency');
for (const v of variants) {
  const once = normalizeBaseUrl(v);
  const twice = normalizeBaseUrl(once);
  check(`idempotent for "${v}"`, once === twice, `→ "${once}" !== "${twice}"`);
}

console.log('url-normalize: non-URL fallback does not throw');
eq('bare string lowercased + trimmed', normalizeBaseUrl('  Foo/Bar/  '), 'foo/bar');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
