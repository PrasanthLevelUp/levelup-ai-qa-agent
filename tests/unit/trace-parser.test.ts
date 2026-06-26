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
import { DOMCandidateExtractor } from '../../src/engines/dom-candidate-extractor';

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

  describe('extractDomHtml', () => {
    it('reconstructs the failure-time page DOM from a real Playwright trace.zip', () => {
      const dom = TraceParser.extractDomHtml(FIXTURE);
      expect(dom).not.toBeNull();
      // The broken test used `#username`; the REAL element is `#user-name`
      // (data-test="username"). Proving the trace DOM contains the real element
      // proves healing can now ground on it without any prior crawl snapshot.
      expect(dom).toContain('id="user-name"');
      expect(dom).toContain('data-test="username"');
      expect(dom).toContain('login-button');
    });

    it('returns null for a non-existent trace path (graceful fallback)', () => {
      expect(TraceParser.extractDomHtml('/no/such/trace.zip')).toBeNull();
    });

    it('returns null for an empty path (graceful fallback)', () => {
      expect(TraceParser.extractDomHtml('')).toBeNull();
    });

    it('returns null for a malformed (non-zip) file (graceful fallback)', () => {
      const tmp = path.join(__dirname, 'tmp-not-a-zip-dom.txt');
      fs.writeFileSync(tmp, 'this is not a zip');
      try {
        expect(TraceParser.extractDomHtml(tmp)).toBeNull();
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
  });

  describe('trace DOM → healing candidate (end-to-end)', () => {
    it('finds the real selector for a trivial broken locator from trace DOM alone', () => {
      // This is the exact scenario the fix targets: a fresh repo with no crawl
      // snapshot, a deliberately broken `#username` locator. The ONLY DOM source
      // is the failing run's trace. Prove the DOM-candidate extractor recovers
      // the real selector from it.
      const dom = TraceParser.extractDomHtml(FIXTURE);
      expect(dom).not.toBeNull();

      const result = new DOMCandidateExtractor().extractFromHTML(
        dom as string,
        '#username',
        'username = this.page.locator(\'#username\');',
      );

      expect(result.candidates.length).toBeGreaterThan(0);
      const top = result.candidates[0];
      expect(top.selector).toContain('[data-test="username"]');
      // Comfortably above the 0.70 acceptance threshold used by healing.
      expect(top.score).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('parse', () => {
    it('returns an ExecutionContext with the page URL and DOM', () => {
      const context = TraceParser.parse(FIXTURE);
      expect(context.pageUrl).toBe('https://www.saucedemo.com/');
      expect(context.domHtml).toContain('id="user-name"');
    });

    it('returns an ExecutionContext with null fields when trace is missing', () => {
      const context = TraceParser.parse('/no/such/trace.zip');
      expect(context.pageUrl).toBeNull();
      expect(context.domHtml).toBeNull();
    });
  });
});
