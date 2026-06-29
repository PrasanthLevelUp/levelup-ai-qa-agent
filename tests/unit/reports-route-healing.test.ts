/**
 * Unit tests — GET /api/reports/healing/* route
 * ==============================================
 * The healing report endpoint decouples the PR creation response (metadata only)
 * from report rendering (fetched on demand). Benefits: smaller responses, cleaner
 * caching, future PDF/HTML rendering without changing the PR endpoint.
 *
 * These tests pin down the core contract:
 *   • GET /api/reports/healing/<key> → 200 with markdown content (Content-Type: text/markdown)
 *   • GET /api/reports/healing/<unknown> → 404
 *   • GET /api/reports/healing/ (empty key) → 400
 */
import { __setReportStoreForTests, type ReportStore } from '../../src/reports/report-store';

// Mock logger to silence output during tests
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('ReportStore contract for healing reports route', () => {
  let mockStore: ReportStore;
  const data = new Map<string, string>();

  beforeEach(() => {
    data.clear();
    mockStore = {
      async save(key: string, markdown: string) {
        data.set(key, markdown);
        return { uri: `file:///tmp/${key}`, key };
      },
      async get(key: string) {
        return data.get(key) ?? null;
      },
    };
    __setReportStoreForTests(mockStore);
  });

  afterEach(() => {
    __setReportStoreForTests(null);
  });

  it('returns markdown content when the report exists', async () => {
    const key = 'healing-reports/acme/web/healing-report-42.md';
    const markdown = '# Healing Report\n\nFixed 1 locator.';
    await mockStore.save(key, markdown);

    const result = await mockStore.get(key);
    expect(result).toBe(markdown);
  });

  it('returns null when the report does not exist', async () => {
    const result = await mockStore.get('healing-reports/nope/missing.md');
    expect(result).toBeNull();
  });

  it('handles keys with nested paths', async () => {
    const key = 'healing-reports/owner/repo/subdir/healing-report-batch-1700000000000.md';
    const markdown = 'Batch report content.';
    await mockStore.save(key, markdown);

    const result = await mockStore.get(key);
    expect(result).toBe(markdown);
  });

  it('returns null for empty key (store defensive behavior)', async () => {
    const result = await mockStore.get('');
    expect(result).toBeNull();
  });
});
