/**
 * Unit tests — Repo Path Resolver (Repo Intelligence)
 * ===================================================
 * Proves the resolver maps foreign / CI-prefixed / relative failure paths onto
 * the real clone using ONLY the filesystem — with ZERO folder-convention
 * knowledge. The same code therefore resolves ANY repository layout
 * (`pages/`, `ui/pageObjects/`, `framework/pom/`, `automation/specs/`, …)
 * without a single change to Healing.
 *
 * An injected existence checker simulates each layout deterministically, so the
 * tests run with no real files on disk.
 */
import * as path from 'path';
import { createRepoPathResolver } from '../../src/intelligence/repo-path-resolver';

const ROOT = '/home/ubuntu/clone';

/** Build an existence checker for a fixed set of repo-relative files. */
function fsWith(relFiles: string[]) {
  const abs = new Set(relFiles.map((f) => path.join(ROOT, f)));
  return (p: string) => abs.has(p);
}

describe('createRepoPathResolver — filesystem-grounded, convention-free', () => {
  it('peels a GitHub Actions CI prefix onto a conventional pages/ layout', () => {
    const r = createRepoPathResolver(ROOT, fsWith(['pages/LoginPage.ts']));
    const ci = '/home/runner/work/Repo/Repo/pages/LoginPage.ts';
    expect(r.toRepoRelative(ci)).toBe('pages/LoginPage.ts');
    expect(r.toAbsolute(ci)).toBe(path.join(ROOT, 'pages/LoginPage.ts'));
  });

  it('resolves a NON-conventional nested layout (ui/pageObjects/) with no code change', () => {
    const r = createRepoPathResolver(ROOT, fsWith(['ui/pageObjects/LoginPage.ts']));
    const ci = '/builds/org/Repo/ui/pageObjects/LoginPage.ts'; // GitLab-style prefix
    expect(r.toRepoRelative(ci)).toBe('ui/pageObjects/LoginPage.ts');
  });

  it('resolves a framework/pom/ layout (the folder Healing must NOT need to know)', () => {
    const r = createRepoPathResolver(ROOT, fsWith(['framework/pom/LoginPage.ts']));
    const ci = '/home/runner/work/X/X/framework/pom/LoginPage.ts';
    expect(r.toRepoRelative(ci)).toBe('framework/pom/LoginPage.ts');
  });

  it('resolves an automation/specs/ layout', () => {
    const r = createRepoPathResolver(ROOT, fsWith(['automation/specs/login.spec.ts']));
    const ci = '/tmp/anything/automation/specs/login.spec.ts';
    expect(r.toRepoRelative(ci)).toBe('automation/specs/login.spec.ts');
  });

  it('accepts an already repo-relative path verbatim', () => {
    const r = createRepoPathResolver(ROOT, fsWith(['pages/LoginPage.ts']));
    expect(r.toRepoRelative('pages/LoginPage.ts')).toBe('pages/LoginPage.ts');
    expect(r.toRepoRelative('./pages/LoginPage.ts')).toBe('pages/LoginPage.ts');
  });

  it('uses an absolute path as-is when it already exists locally (shared FS)', () => {
    const local = path.join(ROOT, 'pages/LoginPage.ts');
    const r = createRepoPathResolver(ROOT, fsWith(['pages/LoginPage.ts']));
    expect(r.toAbsolute(local)).toBe(local);
  });

  it('normalizes Windows separators', () => {
    const r = createRepoPathResolver(ROOT, fsWith(['pages/LoginPage.ts']));
    expect(r.toRepoRelative('C:\\runner\\Repo\\pages\\LoginPage.ts')).toBe('pages/LoginPage.ts');
  });

  it('returns null from toRepoRelative when the file is not in the clone', () => {
    const r = createRepoPathResolver(ROOT, fsWith(['pages/LoginPage.ts']));
    // basename find is skipped for injected checkers, so this is deterministic.
    expect(r.toRepoRelative('/x/y/pages/Missing.ts')).toBeNull();
  });

  it('toAbsolute keeps its non-null contract via a folder-free fallback', () => {
    const r = createRepoPathResolver(ROOT, fsWith([]));
    // relative unknown → joined under root verbatim (no conventional dir invented)
    expect(r.toAbsolute('whatever/Thing.ts')).toBe(path.join(ROOT, 'whatever/Thing.ts'));
    // absolute unknown → basename under root
    expect(r.toAbsolute('/foreign/abs/Thing.ts')).toBe(path.join(ROOT, 'Thing.ts'));
  });

  it('prefers the deepest/most-specific suffix that exists (no shallow false match)', () => {
    // Both "Repo/pages/LoginPage.ts" and "pages/LoginPage.ts" could be suffixes;
    // only the real file exists, so the resolver lands on it.
    const r = createRepoPathResolver(ROOT, fsWith(['pages/LoginPage.ts']));
    expect(r.toRepoRelative('/a/Repo/Repo/pages/LoginPage.ts')).toBe('pages/LoginPage.ts');
  });
});
