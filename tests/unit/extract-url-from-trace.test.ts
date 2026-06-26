/**
 * Regression test for extractUrlFromTrace().
 *
 * Proves that the REAL page URL can be read from a Playwright trace.zip with NO
 * fixture injection or config rewrite. The fixture trace was produced by running
 * an actual failing locator test (LoginPage with a broken `#username` selector)
 * against https://www.saucedemo.com — see PR description for the evidence table
 * showing that the JSON reporter and error-context.md do NOT contain page.url().
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractUrlFromTrace } from '../../src/core/artifact-collector';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-failure-trace.zip');

describe('extractUrlFromTrace', () => {
  it('reads the REAL page URL from a real Playwright trace.zip', () => {
    expect(fs.existsSync(FIXTURE)).toBe(true);
    const url = extractUrlFromTrace(FIXTURE);
    expect(url).toBe('https://www.saucedemo.com/');
  });

  it('returns null for a non-existent trace path (graceful fallback)', () => {
    expect(extractUrlFromTrace('/no/such/trace.zip')).toBeNull();
  });

  it('returns null for an empty path (graceful fallback)', () => {
    expect(extractUrlFromTrace('')).toBeNull();
  });

  it('returns null for a malformed (non-zip) file (graceful fallback)', () => {
    const tmp = path.join(__dirname, 'tmp-not-a-zip.txt');
    fs.writeFileSync(tmp, 'this is not a zip');
    try {
      expect(extractUrlFromTrace(tmp)).toBeNull();
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
