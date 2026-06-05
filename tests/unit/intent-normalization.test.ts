/**
 * Unit tests for intent normalization in script-gen-engine.ts
 *
 * Verifies that human/camelCase locator intents (e.g. "usernameInput") are
 * expanded into the many concrete attribute shapes crawled elements expose
 * (kebab-case, snake_case, spaces, compound-word splits), which is what lets
 * the selector resolver match "usernameInput" → #user-name and
 * "passwordField" → #password.
 *
 * Run with: npx jest tests/unit/intent-normalization.test.ts
 */

import { normalizeIntent } from '../../src/script-gen/script-gen-engine';

describe('normalizeIntent', () => {
  it('returns an empty array for empty/whitespace input', () => {
    expect(normalizeIntent('')).toEqual([]);
    expect(normalizeIntent('   ')).toEqual([]);
  });

  it('expands camelCase into kebab, snake, spaced and joined variants', () => {
    const variants = normalizeIntent('usernameInput');
    expect(variants).toEqual(expect.arrayContaining([
      'username-input',
      'username_input',
      'username input',
    ]));
  });

  it('strips the purpose suffix to reach the core noun (usernameInput → username)', () => {
    const variants = normalizeIntent('usernameInput');
    expect(variants).toContain('username');
  });

  it('decomposes compound words (username → user-name / user_name / user name)', () => {
    const variants = normalizeIntent('usernameInput');
    expect(variants).toEqual(expect.arrayContaining([
      'user-name',
      'user_name',
      'user name',
    ]));
  });

  it('resolves passwordField down to "password" (matches id="password")', () => {
    const variants = normalizeIntent('passwordField');
    expect(variants).toContain('password');
    expect(variants).toEqual(expect.arrayContaining([
      'password-field',
      'password_field',
    ]));
  });

  it('handles snake_case input', () => {
    const variants = normalizeIntent('login_button');
    expect(variants).toEqual(expect.arrayContaining([
      'login-button',
      'login_button',
      'login button',
      'login',
    ]));
  });

  it('handles kebab-case input', () => {
    const variants = normalizeIntent('first-name-input');
    expect(variants).toEqual(expect.arrayContaining([
      'first-name',
      'first_name',
      'first name',
    ]));
  });

  it('handles spaced human descriptions', () => {
    const variants = normalizeIntent('Add to cart button');
    expect(variants).toEqual(expect.arrayContaining([
      'add-to-cart',
      'add_to_cart',
      'add to cart',
    ]));
  });

  it('always includes the lowercased raw intent', () => {
    expect(normalizeIntent('SubmitBtn')).toContain('submitbtn');
  });

  it('produces no duplicate variants', () => {
    const variants = normalizeIntent('usernameInput');
    expect(new Set(variants).size).toBe(variants.length);
  });
});

/**
 * Simulated matching check: prove that the variants produced for common intents
 * line up with the attribute values seen in real crawl data (SauceDemo).
 */
describe('normalizeIntent ↔ crawled attribute alignment', () => {
  const cases: Array<{ intent: string; attr: string }> = [
    { intent: 'usernameInput', attr: 'user-name' }, // SauceDemo id="user-name"
    { intent: 'passwordField', attr: 'password' },  // SauceDemo id="password"
    { intent: 'loginButton', attr: 'login-button' },// SauceDemo id="login-button"
  ];

  for (const { intent, attr } of cases) {
    it(`"${intent}" yields a variant that matches attribute "${attr}"`, () => {
      const variants = normalizeIntent(intent);
      const attrLower = attr.toLowerCase();
      const matched = variants.some(v => v === attrLower || attrLower.includes(v) || v.includes(attrLower));
      expect(matched).toBe(true);
    });
  }
});
