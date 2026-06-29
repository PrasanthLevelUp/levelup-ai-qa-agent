/**
 * Report storage seam.
 *
 * Architectural direction (reviewer-approved): the database stores METADATA, object
 * storage stores DOCUMENTS. A healing report is a (potentially several-KB) markdown
 * document produced on every execution. At scale — e.g. 50 customers × 100
 * executions/day — keeping that content inline in a relational column means storing
 * a lot of document blobs inside `pr_automations` rows. Instead we persist the
 * document through a pluggable store and keep only an opaque reference
 * (`report_uri`) in Postgres.
 *
 * The DB column is deliberately named `report_uri` (not `report_md`) so the backing
 * store can change later — S3 → GCS → Azure Blob → Railway volume — WITHOUT another
 * schema migration. Only the URI scheme changes; the column does not.
 *
 * Today's default implementation is a local/volume-backed filesystem store
 * (`REPORTS_DIR`, defaulting to a Railway-style persistent volume path). Swapping to
 * S3/GCS/Azure later is a matter of adding a new `ReportStore` implementation and
 * selecting it here — no caller and no database changes required.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

const MOD = 'report-store';

export interface SavedReport {
  /** Opaque reference persisted in pr_automations.report_uri (e.g. file:///…, s3://…). */
  uri: string;
  /** Storage-relative key (path within the backing store). */
  key: string;
}

export interface ReportStore {
  /** Persist a markdown report under `key` and return its durable reference. */
  save(key: string, markdown: string): Promise<SavedReport>;
  /** Fetch a previously stored report by its key, or null if absent. */
  get(key: string): Promise<string | null>;
}

/**
 * Filesystem / persistent-volume backed store.
 *
 * Reports are written under REPORTS_DIR (default: a Railway-style volume path),
 * namespaced by `healing-reports/` so the layout maps 1:1 onto an object-storage
 * bucket/prefix when we migrate. `uri` is a `file://` URL today and becomes
 * `s3://bucket/<key>` (etc.) under a future store — same column, no migration.
 */
export class FilesystemReportStore implements ReportStore {
  constructor(private readonly baseDir: string) {}

  private absFor(key: string): string {
    // Guard against path traversal in the (controlled) key.
    const safe = key.replace(/\.\.(\/|\\|$)/g, '');
    return path.join(this.baseDir, safe);
  }

  async save(key: string, markdown: string): Promise<SavedReport> {
    const abs = this.absFor(key);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, markdown, 'utf-8');
    const uri = `file://${abs}`;
    logger.info(MOD, 'Saved healing report to object store (filesystem)', {
      key,
      uri,
      bytes: Buffer.byteLength(markdown, 'utf-8'),
    });
    return { uri, key };
  }

  async get(key: string): Promise<string | null> {
    const abs = this.absFor(key);
    try {
      return fs.readFileSync(abs, 'utf-8');
    } catch {
      return null;
    }
  }
}

let singleton: ReportStore | null = null;

/**
 * Resolve the active report store.
 *
 * Selection is centralised here so callers never care which backend is in play.
 * Future: branch on REPORT_STORE=s3|gcs|azure and return the matching implementation.
 */
export function getReportStore(): ReportStore {
  if (singleton) return singleton;
  const baseDir =
    process.env.REPORTS_DIR && process.env.REPORTS_DIR.trim()
      ? process.env.REPORTS_DIR.trim()
      : '/data/reports'; // Railway-style persistent volume by default.
  singleton = new FilesystemReportStore(baseDir);
  return singleton;
}

/** Test seam — override the active store (and reset with null). */
export function __setReportStoreForTests(store: ReportStore | null): void {
  singleton = store;
}
