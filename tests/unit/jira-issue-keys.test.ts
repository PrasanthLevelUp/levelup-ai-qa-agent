/**
 * Tests for Jira issue-key parsing / normalization / validation.
 */

import {
  parseIssueKeys,
  isValidIssueKey,
  ISSUE_KEY_REGEX,
} from '../../src/integrations/jira-issue-keys';

describe('isValidIssueKey', () => {
  it('accepts canonical keys', () => {
    expect(isValidIssueKey('AUTH-123')).toBe(true);
    expect(isValidIssueKey('PAY-45')).toBe(true);
    expect(isValidIssueKey('WEB-102')).toBe(true);
  });

  it('accepts project keys containing digits', () => {
    expect(isValidIssueKey('A1-9')).toBe(true);
    expect(isValidIssueKey('PROJ2-100')).toBe(true);
  });

  it('lowercases are normalized and accepted', () => {
    expect(isValidIssueKey('auth-123')).toBe(true);
  });

  it('rejects the founder\'s invalid examples', () => {
    expect(isValidIssueKey('AUTH123')).toBe(false); // no hyphen
    expect(isValidIssueKey('123')).toBe(false);     // no project prefix
    expect(isValidIssueKey('ABC-')).toBe(false);    // no issue number
  });

  it('rejects other malformed keys', () => {
    expect(isValidIssueKey('')).toBe(false);
    expect(isValidIssueKey('-123')).toBe(false);
    expect(isValidIssueKey('AUTH-12A')).toBe(false);
    expect(isValidIssueKey('1AUTH-12')).toBe(false); // must start with a letter
  });

  it('exported regex matches only canonical (already-uppercased) keys', () => {
    expect(ISSUE_KEY_REGEX.test('AUTH-123')).toBe(true);
    expect(ISSUE_KEY_REGEX.test('auth-123')).toBe(false); // regex itself is case-sensitive
  });
});

describe('parseIssueKeys', () => {
  it('parses a single key', () => {
    expect(parseIssueKeys('AUTH-123')).toEqual({ valid: ['AUTH-123'], invalid: [] });
  });

  it('parses comma-separated keys', () => {
    expect(parseIssueKeys('AUTH-123,PAY-44,WEB-102')).toEqual({
      valid: ['AUTH-123', 'PAY-44', 'WEB-102'],
      invalid: [],
    });
  });

  it('parses comma-separated keys with spaces', () => {
    expect(parseIssueKeys('AUTH-123, PAY-44,  WEB-102')).toEqual({
      valid: ['AUTH-123', 'PAY-44', 'WEB-102'],
      invalid: [],
    });
  });

  it('parses newline-separated keys', () => {
    expect(parseIssueKeys('AUTH-123\nPAY-44\nWEB-102')).toEqual({
      valid: ['AUTH-123', 'PAY-44', 'WEB-102'],
      invalid: [],
    });
  });

  it('parses mixed comma + newline + whitespace', () => {
    expect(parseIssueKeys('AUTH-123, PAY-44\nWEB-102   NAV-9')).toEqual({
      valid: ['AUTH-123', 'PAY-44', 'WEB-102', 'NAV-9'],
      invalid: [],
    });
  });

  it('normalizes lowercase to uppercase', () => {
    expect(parseIssueKeys('auth-123, pay-44')).toEqual({
      valid: ['AUTH-123', 'PAY-44'],
      invalid: [],
    });
  });

  it('extracts keys from a single Jira browse URL', () => {
    expect(parseIssueKeys('https://company.atlassian.net/browse/AUTH-123')).toEqual({
      valid: ['AUTH-123'],
      invalid: [],
    });
  });

  it('extracts keys from browse URLs with query/hash suffixes', () => {
    expect(
      parseIssueKeys('https://company.atlassian.net/browse/AUTH-123?filter=abc#comment-1'),
    ).toEqual({ valid: ['AUTH-123'], invalid: [] });
  });

  it('mixes URLs and plain keys', () => {
    expect(
      parseIssueKeys('https://company.atlassian.net/browse/AUTH-123, PAY-44'),
    ).toEqual({ valid: ['AUTH-123', 'PAY-44'], invalid: [] });
  });

  it('mixes bare keys and browse URLs across newlines (common copy-paste workflow)', () => {
    // Real-world: copy a mix of keys and URLs from a backlog, paste them all.
    const input = `AUTH-123

https://company.atlassian.net/browse/PAY-45

WEB-101

https://company.atlassian.net/browse/LOGIN-88`;
    expect(parseIssueKeys(input)).toEqual({
      valid: ['AUTH-123', 'PAY-45', 'WEB-101', 'LOGIN-88'],
      invalid: [],
    });
  });

  it('accepts an array of tokens', () => {
    expect(parseIssueKeys(['AUTH-123', 'PAY-44'])).toEqual({
      valid: ['AUTH-123', 'PAY-44'],
      invalid: [],
    });
  });

  it('accepts an array where each element itself has multiple keys', () => {
    expect(parseIssueKeys(['AUTH-123, PAY-44', 'WEB-102'])).toEqual({
      valid: ['AUTH-123', 'PAY-44', 'WEB-102'],
      invalid: [],
    });
  });

  it('de-duplicates while preserving first-seen order', () => {
    expect(parseIssueKeys('AUTH-123, PAY-44, AUTH-123, auth-123')).toEqual({
      valid: ['AUTH-123', 'PAY-44'],
      invalid: [],
    });
  });

  it('separates invalid tokens from valid ones', () => {
    const res = parseIssueKeys('AUTH-123, AUTH123, 123, ABC-, PAY-44');
    expect(res.valid).toEqual(['AUTH-123', 'PAY-44']);
    expect(res.invalid).toEqual(['AUTH123', '123', 'ABC-']);
  });

  it('rejects an unrecognized (non-browse) URL as invalid', () => {
    const res = parseIssueKeys('https://example.com/foo/AUTH-123-bar');
    expect(res.valid).toEqual([]);
    expect(res.invalid.length).toBe(1);
  });

  it('returns empty for empty / null / undefined input', () => {
    expect(parseIssueKeys('')).toEqual({ valid: [], invalid: [] });
    expect(parseIssueKeys(null)).toEqual({ valid: [], invalid: [] });
    expect(parseIssueKeys(undefined)).toEqual({ valid: [], invalid: [] });
    expect(parseIssueKeys('   \n  ,  ')).toEqual({ valid: [], invalid: [] });
  });
});
