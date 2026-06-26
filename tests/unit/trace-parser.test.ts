/**
 * Regression test for the Playwright TraceParser.
 *
 * Proves that the REAL page URL can be read from a Playwright trace.zip with NO
 * fixture injection or config rewrite. The fixture trace was produced by running
 * an actual failing locator test (LoginPage with a broken `#username` selector)
 * against https://www.saucedemo.com — see PR description for the evidence table
 * showing that the JSON reporter and error-context.md do NOT contain page.url().
 */

import * as fs from 'fs';
import * as path from 'path';
import * as TraceParser from '../../src/core/playwright/trace-parser';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-failure-trace.zip');

describe('TraceParser', () => {
  describe('extractPageUrl', () => {
    it('reads the REAL page URL from a real Playwright trace.zip', () => {
      expect(fs.existsSync(FIXTURE)).toBe(true);
      const url = TraceParser.extractPageUrl(FIXTURE);
      expect(url).toBe('https://www.saucedemo.com/');
    });

    it('returns null for a non-existent trace path (graceful fallback)', () => {
      expect(TraceParser.extractPageUrl('/no/such/trace.zip')).toBeNull();
    });

    it('returns null for an empty path (graceful fallback)', () => {
      expect(TraceParser.extractPageUrl('')).toBeNull();
    });

    it('returns null for a malformed (non-zip) file (graceful fallback)', () => {
      const tmp = path.join(__dirname, 'tmp-not-a-zip.txt');
      fs.writeFileSync(tmp, 'this is not a zip');
      try {
        expect(TraceParser.extractPageUrl(tmp)).toBeNull();
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
  });

  describe('parse', () => {
    it('returns an ExecutionContext with the page URL', () => {
      const context = TraceParser.parse(FIXTURE);
      expect(context.pageUrl).toBe('https://www.saucedemo.com/');
    });

    it('returns an ExecutionContext with null pageUrl when trace is missing', () => {
      const context = TraceParser.parse('/no/such/trace.zip');
      expect(context.pageUrl).toBeNull();
    });
  });
});
