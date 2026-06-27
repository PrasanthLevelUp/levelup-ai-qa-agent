import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSpecFile, resolveRerunRelFile } from '../../src/core/rerun-target';

/**
 * Regression test for the real production "Report only" cause once the container
 * was healthy: a page-object locator heal whose `specFilePath` was missing from
 * the CI-uploaded results JSON. The rerun then targeted the Page Object file,
 * which contains NO tests → Playwright ran 0 tests, exited 1 with an empty
 * report → the heal could not be confirmed → a correct fix was silently reverted.
 *
 * resolveRerunRelFile must NEVER return a Page Object path; it returns a real
 * spec path, or `undefined` so the caller reruns by --grep across the suite.
 */
describe('isSpecFile', () => {
  it('recognizes spec/test files in ts/js/tsx/jsx', () => {
    expect(isSpecFile('tests/login.spec.ts')).toBe(true);
    expect(isSpecFile('tests/login.test.ts')).toBe(true);
    expect(isSpecFile('a/b/c.spec.js')).toBe(true);
    expect(isSpecFile('a/b/c.test.jsx')).toBe(true);
  });
  it('rejects Page Objects and non-spec sources', () => {
    expect(isSpecFile('pages/LoginPage.ts')).toBe(false);
    expect(isSpecFile('src/utils/env.ts')).toBe(false);
    expect(isSpecFile(undefined)).toBe(false);
    expect(isSpecFile(null)).toBe(false);
    expect(isSpecFile('')).toBe(false);
  });
});

describe('resolveRerunRelFile', () => {
  let repo: string;
  let spec: string;
  let pageObject: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rerun-target-'));
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'pages'), { recursive: true });
    spec = path.join(repo, 'tests', 'login.spec.ts');
    pageObject = path.join(repo, 'pages', 'LoginPage.ts');
    fs.writeFileSync(spec, '// spec', 'utf-8');
    fs.writeFileSync(pageObject, '// page object', 'utf-8');
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('THE BUG: page-object heal with missing specFilePath → grep-only (never the PO)', () => {
    const rel = resolveRerunRelFile({ specFilePath: undefined, filePath: pageObject }, repo);
    expect(rel).toBeUndefined();
  });

  it('uses a real spec when specFilePath is present', () => {
    const rel = resolveRerunRelFile({ specFilePath: spec, filePath: pageObject }, repo);
    expect(rel).toBe(path.join('tests', 'login.spec.ts'));
  });

  it('uses filePath when IT is the spec (inline-locator failure)', () => {
    const rel = resolveRerunRelFile({ specFilePath: undefined, filePath: spec }, repo);
    expect(rel).toBe(path.join('tests', 'login.spec.ts'));
  });

  it('falls back to grep-only when the spec path does not exist on disk', () => {
    const rel = resolveRerunRelFile(
      { specFilePath: path.join(repo, 'tests', 'ghost.spec.ts'), filePath: pageObject },
      repo,
    );
    expect(rel).toBeUndefined();
  });

  it('falls back to grep-only when the spec escapes the repo root', () => {
    const outside = path.join(os.tmpdir(), 'outside.spec.ts');
    fs.writeFileSync(outside, '// outside', 'utf-8');
    try {
      const rel = resolveRerunRelFile({ specFilePath: outside, filePath: pageObject }, repo);
      expect(rel).toBeUndefined();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
