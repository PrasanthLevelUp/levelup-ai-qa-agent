/**
 * Unit tests — Option A: healing reports are NEVER committed to the customer repo
 * ===============================================================================
 * Architectural decision: the healing report is execution metadata owned by
 * LevelUp (the document lives in object storage, referenced by
 * pr_automations.report_uri, and surfaced in the PR body /
 * dashboard). The customer repository must contain only source code — never an
 * ever-growing healing-reports/ folder.
 *
 * These guard the two pure helpers that enforce that invariant:
 *   • isHealingReportPath — recognises report artifacts
 *   • selectCommitFiles   — strips them from the commit set
 *
 * This also closes the previous failure mode: when the report was committed, its
 * live `new Date().toISOString()` timestamp always dirtied `git status`/`git diff`,
 * so a heal that changed no source file still pushed a phantom, fix-less PR. With
 * the report out of git, an empty working tree unambiguously means "no source
 * change" and the route stops before pushing.
 */

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { isHealingReportPath, selectCommitFiles } from '../../src/api/routes/healing-pr';

describe('isHealingReportPath — report artifact recogniser', () => {
  it.each([
    'healing-reports/healing-report-231.md',
    'healing-reports/healing-report-batch-1782730000000.md',
    './healing-reports/healing-report-7.md',
    'healing-report-9.md',
    'HEALING-REPORTS/Healing-Report-1.MD',
  ])('TRUE for report path: %s', (p) => {
    expect(isHealingReportPath(p)).toBe(true);
  });

  it.each([
    'tests/login.spec.ts',
    'pages/LoginPage.ts',
    'src/checkout.ts',
    'data/test-data.ts',
    'docs/healing-report-format.md', // a doc ABOUT reports, in a non-report folder, not a report file
  ])('FALSE for source path: %s', (p) => {
    expect(isHealingReportPath(p)).toBe(false);
  });
});

describe('selectCommitFiles — commit set is source-only', () => {
  it('drops the healing report and keeps source files', () => {
    const files = [
      { filePath: 'pages/LoginPage.ts', content: 'a' },
      { filePath: 'healing-reports/healing-report-231.md', content: 'report' },
      { filePath: 'tests/login.spec.ts', content: 'b' },
    ];
    const kept = selectCommitFiles(files);
    expect(kept.map((f) => f.filePath)).toEqual(['pages/LoginPage.ts', 'tests/login.spec.ts']);
  });

  it('returns an EMPTY set when the only change is the report (the phantom-PR case)', () => {
    const files = [{ filePath: 'healing-reports/healing-report-9.md', content: 'r' }];
    expect(selectCommitFiles(files)).toEqual([]);
  });

  it('is a no-op when there is no report', () => {
    const files = [{ filePath: 'a.ts', content: '1' }, { filePath: 'b.ts', content: '2' }];
    expect(selectCommitFiles(files)).toHaveLength(2);
  });
});
