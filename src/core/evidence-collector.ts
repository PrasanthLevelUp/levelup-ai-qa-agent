/**
 * Evidence Collector
 * ------------------
 * The component the product owner asked for *before* the Failure Classifier.
 * Its job: aggregate everything Playwright already produces about a failure into
 * one structured `EvidenceBundle`, so the classifier reasons over OBSERVED FACTS
 * instead of guessing from an error string.
 *
 *     Playwright failure
 *        ↓ screenshot
 *        ↓ trace
 *        ↓ DOM snapshot
 *        ↓ console errors
 *        ↓ network
 *        ↓ locator state (exists / visible / enabled / clickable / pointer-events)
 *        → Failure Classifier
 *
 * Each evidence source is OPTIONAL and the collector degrades gracefully: with a
 * DOM snapshot it produces hard locator-state facts; without one it still records
 * console/network signals and the available artifact paths. The classifier then
 * reflects how much evidence backed the diagnosis in its confidence.
 *
 * Live vs offline locator state
 * -----------------------------
 * When a live Playwright page is available, pass a `LocatorStateProbe` and the
 * collector will use real `isVisible()` / `boundingBox()` / `elementFromPoint`
 * probes. Otherwise it falls back to the pure `analyzeLocatorState` over the DOM
 * snapshot we persist. Same `LocatorState` shape either way.
 */

import { analyzeLocatorState, type LocatorState } from './locator-state-analyzer';
import type { FailureDetails } from './failure-analyzer';

export interface NetworkErrorEvidence {
  url?: string;
  status?: number;
  detail: string;
}

export interface EvidenceBundle {
  /** Locator state facts (exists/visible/enabled/clickable/pointer-events). */
  locatorState: LocatorState | null;
  /** Console errors observed around the failure. */
  consoleErrors: string[];
  /** Network failures (refused/aborted/4xx/5xx) observed around the failure. */
  networkErrors: NetworkErrorEvidence[];
  /** Artifact availability + paths (for the Failure Replay UI). */
  artifacts: {
    screenshotPath: string | null;
    tracePath: string | null;
    videoPath: string | null;
    domSnapshotPresent: boolean;
  };
  /** Compact, human-readable evidence lines (for the Evidence panel + logs). */
  summary: string[];
}

/**
 * Optional live probe. When a real Playwright page is in scope the worker can
 * implement this; the collector prefers it over DOM-snapshot analysis.
 */
export interface LocatorStateProbe {
  probe(selector: string): Promise<LocatorState> | LocatorState;
}

export interface EvidenceSources {
  failure: FailureDetails;
  /** Persisted DOM snapshot HTML for the failing page (tenant-scoped). */
  domSnapshot?: string | null;
  /** Path to the Playwright trace.zip, when captured. */
  tracePath?: string | null;
  /** Path to the failure video, when captured. */
  videoPath?: string | null;
  /** Raw console log text (e.g. from stdout / a console attachment). */
  consoleLog?: string | null;
  /** Live locator-state probe (preferred when a live page is available). */
  locatorProbe?: LocatorStateProbe | null;
}

const NET_ERR_RE = /(net::ERR_[A-Z_]+)/g;
const HTTP_STATUS_RE = /\b(?:status(?:\s*code)?|http)\D{0,4}(4\d\d|5\d\d)\b/gi;
const REQUEST_FAIL_RE = /(request to\s+\S+\s+failed|failed to fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up)/gi;
const CONSOLE_ERR_RE = /(?:console\s+error|Uncaught\s+\w*Error|TypeError|ReferenceError|SyntaxError)[^\n]*/gi;

/** Pull network-failure evidence out of any text (error message / console log). */
export function extractNetworkErrors(text: string): NetworkErrorEvidence[] {
  if (!text) return [];
  const out: NetworkErrorEvidence[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(NET_ERR_RE)) {
    const detail = m[1];
    if (!seen.has(detail)) { seen.add(detail); out.push({ detail }); }
  }
  for (const m of text.matchAll(HTTP_STATUS_RE)) {
    const detail = `HTTP ${m[1]}`;
    if (!seen.has(detail)) { seen.add(detail); out.push({ status: Number(m[1]), detail }); }
  }
  for (const m of text.matchAll(REQUEST_FAIL_RE)) {
    const detail = m[1];
    if (!seen.has(detail)) { seen.add(detail); out.push({ detail }); }
  }
  return out;
}

/** Pull console-error evidence out of any text. */
export function extractConsoleErrors(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CONSOLE_ERR_RE)) {
    const line = m[0].trim().slice(0, 200);
    if (!seen.has(line)) { seen.add(line); out.push(line); }
  }
  return out;
}

export class EvidenceCollector {
  async collect(sources: EvidenceSources): Promise<EvidenceBundle> {
    const { failure } = sources;
    const summary: string[] = [];

    // ── Locator state (live probe preferred, DOM snapshot fallback) ──
    let locatorState: LocatorState | null = null;
    const selector = failure.failedLocator || failure.diagnosis?.locator || '';
    if (selector) {
      try {
        if (sources.locatorProbe) {
          locatorState = await sources.locatorProbe.probe(selector);
        } else {
          locatorState = analyzeLocatorState(selector, sources.domSnapshot);
        }
      } catch {
        locatorState = analyzeLocatorState(selector, sources.domSnapshot);
      }
    }
    if (locatorState && locatorState.source !== 'unknown') {
      summary.push(
        `Locator state — exists:${tick(locatorState.exists)} visible:${tick(locatorState.visible)} ` +
          `enabled:${tick(locatorState.enabled)} clickable:${tick(locatorState.clickable)}` +
          (locatorState.interceptedBy ? ` (intercepted by ${locatorState.interceptedBy})` : ''),
      );
    }

    // ── Console + network evidence (from error message + optional console log) ──
    const haystack = [failure.errorMessage || '', sources.consoleLog || ''].join('\n');
    const consoleErrors = extractConsoleErrors(haystack);
    const networkErrors = extractNetworkErrors(haystack);
    if (consoleErrors.length) summary.push(`${consoleErrors.length} console error(s) observed.`);
    if (networkErrors.length) {
      summary.push(`${networkErrors.length} network failure(s): ${networkErrors.map((n) => n.detail).join(', ')}.`);
    }

    // ── Artifacts (for Failure Replay) ──
    const artifacts = {
      screenshotPath: failure.screenshotPath ?? null,
      tracePath: sources.tracePath ?? null,
      videoPath: sources.videoPath ?? null,
      domSnapshotPresent: !!sources.domSnapshot,
    };
    const present = Object.entries({
      screenshot: !!artifacts.screenshotPath,
      trace: !!artifacts.tracePath,
      video: !!artifacts.videoPath,
      dom: artifacts.domSnapshotPresent,
    })
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (present.length) summary.push(`Artifacts captured: ${present.join(', ')}.`);

    return { locatorState, consoleErrors, networkErrors, artifacts, summary };
  }
}

function tick(b: boolean): string {
  return b ? '✔' : '✖';
}
