/**
 * Unit tests — FilesystemReportStore
 * ==================================
 * The report store is the seam that keeps report DOCUMENTS out of Postgres (which
 * holds only a report_uri reference) and out of the customer repo. These tests pin
 * down the contract every backend (filesystem today, S3/GCS/Azure later) must honour:
 *   • save() writes the document and returns a durable reference (uri) + key
 *   • get() round-trips the exact content back
 *   • get() returns null for an unknown key (never throws)
 *   • path-traversal in a key cannot escape the base directory
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FilesystemReportStore } from '../../src/reports/report-store';

describe('FilesystemReportStore', () => {
  let baseDir: string;
  let store: FilesystemReportStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reportstore-'));
    store = new FilesystemReportStore(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('saves a report and returns a file:// uri plus the key', async () => {
    const key = 'healing-reports/acme/web/healing-report-42.md';
    const md = '# Healing report\n\nfixed 1 locator';
    const saved = await store.save(key, md);

    expect(saved.key).toBe(key);
    expect(saved.uri.startsWith('file://')).toBe(true);
    expect(saved.uri).toContain(key);
    // The document is physically written under the base dir.
    expect(fs.existsSync(path.join(baseDir, key))).toBe(true);
  });

  it('round-trips content via get()', async () => {
    const key = 'healing-reports/acme/web/healing-report-batch-1700000000000.md';
    const md = 'line A\nline B\n';
    await store.save(key, md);
    await expect(store.get(key)).resolves.toBe(md);
  });

  it('returns null for an unknown key (does not throw)', async () => {
    await expect(store.get('healing-reports/nope/missing.md')).resolves.toBeNull();
  });

  it('neutralises path traversal in keys', async () => {
    const key = '../../../etc/healing-report-1.md';
    const saved = await store.save(key, 'x');
    const escaped = path.resolve('/etc/healing-report-1.md');
    // Whatever the store wrote, it must NOT be the absolute /etc path.
    expect(saved.uri).not.toBe(`file://${escaped}`);
    expect(fs.existsSync(escaped)).toBe(false);
  });
});
