/**
 * Artifact Ingestion — turn a remote CI run's uploaded artifacts into a LOCAL
 * Playwright workspace the existing healing pipeline can consume unchanged.
 *
 * A remote provider (e.g. GitHub Actions) finishes a run and exposes one or more
 * uploaded artifacts as zip archives. This module:
 *   1. downloads each artifact zip (via a provider-supplied downloader),
 *   2. extracts it into a working directory,
 *   3. locates the canonical Playwright `test-results.json` (the `json` reporter
 *      output) and classifies the other captured files (traces, screenshots,
 *      videos, HTML report).
 *
 * The single REQUIRED output is the path to a parseable `test-results.json`.
 * Everything else is best-effort evidence enrichment — diagnosis itself reads
 * source from the local clone, so a missing trace never blocks healing.
 *
 * ── Workflow requirement (documented, not magic) ───────────────────────────
 * For ingestion to work the customer's workflow must produce and upload a
 * Playwright JSON results file (i.e. run with the `json` reporter and
 * `actions/upload-artifact`). This is the one contract we surface to users; we
 * do NOT rewrite their CI, we just consume what a standard Playwright CI emits.
 */
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { logger } from '../../../utils/logger';

const MOD = 'artifact-ingestion';

/** A remote artifact descriptor + a way to fetch its bytes. */
export interface RemoteArtifact {
  id: number;
  name: string;
  archiveDownloadUrl?: string;
  expired?: boolean;
}

/** Function that fetches a single artifact's zip bytes (provider supplies auth). */
export type ArtifactDownloader = (
  artifact: RemoteArtifact,
) => Promise<{ ok: boolean; buffer?: Buffer; error?: string }>;

/** What ingestion found after extracting all artifacts. */
export interface IngestedArtifacts {
  /** Directory all artifacts were extracted into. */
  extractDir: string;
  /** Path to the Playwright `test-results.json`, if one was found. */
  resultsFile: string | null;
  /** Other classified files, by kind (absolute paths in `extractDir`). */
  traces: string[];
  screenshots: string[];
  videos: string[];
  /** Path to an HTML report's index.html, if present. */
  htmlReport: string | null;
  /** Names of artifacts successfully extracted. */
  extractedArtifacts: string[];
  /** Non-fatal warnings (e.g. an expired artifact skipped). */
  warnings: string[];
}

/** True when a parsed JSON object looks like a Playwright JSON-reporter file. */
function looksLikePlaywrightResults(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  // Playwright JSON reporter always has `config` + `suites`; `stats` is common.
  return ('suites' in o && ('config' in o || 'stats' in o));
}

/** Recursively list every file under `dir`. */
function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Extract one zip Buffer into `destDir` (preserving its internal structure).
 * Returns the list of files written. Path-traversal entries are rejected.
 */
async function extractZip(buffer: Buffer, destDir: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const written: string[] = [];
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    if (entry.dir) continue;
    // Guard against zip-slip — never write outside destDir.
    const target = path.join(destDir, entry.name);
    const normalized = path.normalize(target);
    if (!normalized.startsWith(path.normalize(destDir + path.sep)) && normalized !== path.normalize(destDir)) {
      logger.warn(MOD, 'Skipping zip entry outside destination (zip-slip guard)', { entry: entry.name });
      continue;
    }
    fs.mkdirSync(path.dirname(normalized), { recursive: true });
    const content = await entry.async('nodebuffer');
    fs.writeFileSync(normalized, content);
    written.push(normalized);
  }
  return written;
}

/**
 * Classify an extracted file tree and pick the canonical results file. The
 * results file is whichever JSON parses as a Playwright reporter file; a file
 * literally named `test-results.json` wins ties.
 */
export function classifyExtracted(files: string[]): Omit<IngestedArtifacts, 'extractDir' | 'extractedArtifacts' | 'warnings'> {
  const traces: string[] = [];
  const screenshots: string[] = [];
  const videos: string[] = [];
  let htmlReport: string | null = null;
  const jsonCandidates: string[] = [];

  for (const f of files) {
    const base = path.basename(f).toLowerCase();
    const ext = path.extname(f).toLowerCase();
    if (ext === '.zip' && base.includes('trace')) traces.push(f);
    else if (ext === '.zip') traces.push(f); // Playwright trace.zip files
    else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') screenshots.push(f);
    else if (ext === '.webm' || ext === '.mp4') videos.push(f);
    else if (base === 'index.html' && f.toLowerCase().includes('report')) htmlReport = htmlReport ?? f;
    else if (ext === '.json') jsonCandidates.push(f);
  }

  // Pick the results file: prefer an exact `test-results.json`, else the first
  // JSON whose shape matches the Playwright reporter.
  let resultsFile: string | null = null;
  const exact = jsonCandidates.find(f => path.basename(f).toLowerCase() === 'test-results.json');
  const ordered = exact ? [exact, ...jsonCandidates.filter(f => f !== exact)] : jsonCandidates;
  for (const f of ordered) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (looksLikePlaywrightResults(parsed)) { resultsFile = f; break; }
    } catch {
      // not JSON / unreadable — skip
    }
  }

  return { resultsFile, traces, screenshots, videos, htmlReport };
}

/**
 * Download + extract every (non-expired) artifact for a run, then locate the
 * Playwright results. Returns a structured {@link IngestedArtifacts}.
 */
export async function ingestRunArtifacts(
  artifacts: RemoteArtifact[],
  download: ArtifactDownloader,
  extractDir: string,
): Promise<IngestedArtifacts> {
  fs.mkdirSync(extractDir, { recursive: true });
  const warnings: string[] = [];
  const extractedArtifacts: string[] = [];
  let allFiles: string[] = [];

  for (const art of artifacts) {
    if (art.expired) {
      warnings.push(`Artifact "${art.name}" has expired and was skipped.`);
      continue;
    }
    const dl = await download(art);
    if (!dl.ok || !dl.buffer) {
      warnings.push(`Failed to download artifact "${art.name}": ${dl.error || 'unknown error'}`);
      continue;
    }
    const artDir = path.join(extractDir, sanitize(art.name));
    try {
      const written = await extractZip(dl.buffer, artDir);
      allFiles.push(...written);
      extractedArtifacts.push(art.name);
    } catch (err) {
      warnings.push(`Failed to extract artifact "${art.name}": ${(err as Error).message}`);
    }
  }

  const classified = classifyExtracted(allFiles);
  if (!classified.resultsFile) {
    warnings.push(
      'No Playwright test-results.json was found in the uploaded artifacts. ' +
      'Ensure the workflow runs with the JSON reporter and uploads the results file via actions/upload-artifact.',
    );
  }

  return { extractDir, ...classified, extractedArtifacts, warnings };
}

/** Make an artifact name safe to use as a directory segment. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100) || 'artifact';
}
