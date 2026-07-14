/**
 * Coverage Intelligence · Sprint CI-1 — Existing Test Discovery
 * ============================================================================
 *
 * THE JOB (and ONLY this job for CI-1):
 *   Before we generate anything, decide — per planned scenario — whether the
 *   repository ALREADY tests it. This is the foundation that determines whether
 *   generation is even needed. It does NOT plan, generate, or aggregate; CI-2
 *   (Coverage Report) and CI-3 (Planner Integration) build on top of it.
 *
 * For every planned scenario it answers:
 *
 *     {
 *       "scenario": "Locked / disabled account cannot log in",
 *       "status": "existing" | "partial" | "missing",
 *       "confidence": 0-100,
 *       "existingTest": "tests/login/locked-user.spec.ts :: locked out user ...",
 *       "recommendation": "reuse" | "extend" | "generate"
 *     }
 *
 * DESIGN CONSTRAINTS (per product direction):
 *   • NO LLM. The decision must be deterministic and explainable — a customer
 *     (and a debugging engineer) must be able to see exactly WHY a scenario was
 *     judged existing/partial/missing. So the matcher is a classic TF-IDF cosine
 *     over normalized tokens, with QA-domain synonym canonicalization and a
 *     polarity guard. No network, no key, no model.
 *   • REUSE existing knowledge, do not invent a new scanner. The candidate tests
 *     come straight from the already-built RepositoryProfile (testSuites +
 *     businessFlows). This module never re-reads the repo.
 *   • HONEST over clever. We never claim a match we cannot defend from token
 *     evidence. A negative scenario ("invalid password") will not be reported as
 *     "reuse" of a positive test ("valid login") just because they share words.
 *
 * WHY NOT the existing SemanticSimilarityEngine / EmbeddingService?
 *   - SemanticSimilarityEngine (src/engines/semantic-similarity-engine.ts) is
 *     DOM/locator-specific (attribute values, form-field synonyms, DOM context).
 *     It is the wrong instrument for prose scenario titles.
 *   - EmbeddingService (src/services/embedding-service.ts) needs an OpenAI key
 *     and is gated behind FEATURE_FLAGS.REPO_INTELLIGENCE.VECTOR_SEARCH (off by
 *     default) — i.e. an LLM dependency that also would not run offline.
 *   So CI-1 reuses the *technique* (vectorize + cosine) in a deterministic,
 *   always-available form. An embedding-based scorer can be dropped in later
 *   behind the same `ScenarioScorer` seam WITHOUT changing any caller.
 */

import type { RepositoryProfile, TestSuiteInfo, BusinessFlow } from '../context/types';
import { CoverageDecision } from './types';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * The minimal shape of a planned scenario this module reads. Deliberately
 * structural (not an import of PlannedScenario) so Coverage Intelligence stays
 * decoupled from the planner's full type and any branch drift. `ScenarioPlan`'s
 * scenarios are structurally assignable to this.
 */
export interface ScenarioLike {
  id: string;
  title: string;
  objective?: string;
  coverageType?: string;
  riskArea?: string;
}

export type CoverageStatus = 'existing' | 'partial' | 'missing';

/** One candidate existing test drawn from the RepositoryProfile. */
export interface ExistingTestCandidate {
  /** "filePath :: testName" — the stable human-readable reference. */
  ref: string;
  filePath: string;
  /** The individual test title, or the describe/suite name for suite-level rows. */
  testName: string;
  suiteName: string;
  category: string;
  tags: string[];
  /** Where this candidate came from — a spec test, or a business flow. */
  source: 'test' | 'business-flow';
}

/** The per-scenario coverage decision — the CI-1 deliverable. */
export interface ScenarioCoverage {
  scenarioId: string;
  scenario: string;
  status: CoverageStatus;
  /** 0-100. 0 means "nothing in the repo is meaningfully related". */
  confidence: number;
  /** Best matching existing test ("filePath :: testName"), or null when missing. */
  existingTest: string | null;
  recommendation: CoverageDecision;
  /** The distinctive normalized terms that drove the match (explainability). */
  matchedOn: string[];
  /** Human one-liner explaining the decision. */
  reason: string;
  /** Next-best matches (for the "suggested extension" UX in CI-4). */
  alternatives: Array<{ ref: string; confidence: number }>;
}

export interface DiscoveryOptions {
  /**
   * Score thresholds (cosine 0..1). Tuned conservatively: we would rather send a
   * borderline scenario to "extend" than wrongly skip generation as "reuse".
   */
  existingThreshold?: number; // >= → existing / reuse   (default 0.72)
  partialThreshold?: number;  // >= → partial  / extend  (default 0.40)
  /** How many alternatives to keep per scenario (default 3). */
  maxAlternatives?: number;
  /** Pluggable scorer seam — defaults to the deterministic TF-IDF cosine. */
  scorer?: ScenarioScorer;
}

const DEFAULTS = {
  existingThreshold: 0.72,
  partialThreshold: 0.4,
  maxAlternatives: 3,
};

/* ------------------------------------------------------------------ */
/*  Text normalization (deterministic, no NLP library)                 */
/* ------------------------------------------------------------------ */

/** Words that carry no discriminating signal for test/scenario matching. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'be', 'to', 'of', 'and', 'or', 'in', 'on',
  'for', 'with', 'that', 'this', 'it', 'as', 'at', 'by', 'from', 'into', 'out',
  'should', 'must', 'can', 'will', 'when', 'then', 'given', 'if', 'test', 'tests',
  'case', 'cases', 'scenario', 'verify', 'verifies', 'verified', 'check', 'checks',
  'ensure', 'ensures', 'validate', 'validates', 'spec', 'e2e',
  // temporal / connective filler — rare enough to look distinctive but carries
  // no coverage signal ("after login", "during checkout").
  'after', 'before', 'during', 'while', 'again', 'per', 'via', 'able',
]);

/**
 * QA-domain synonym canonicalization. Each variant maps to ONE canonical token
 * so "sign in", "log in" and "login" all collapse together. Multi-word phrases
 * are handled before tokenization (see canonicalizePhrases). This is the
 * scenario-language analogue of the DOM SEMANTIC_GROUPS — co-located here and
 * tuned for test prose rather than form fields.
 */
const SYNONYMS: Record<string, string> = {
  // auth
  login: 'login', signin: 'login', logon: 'login', authenticate: 'login',
  authentication: 'login', auth: 'login',
  logout: 'logout', signout: 'logout', signoff: 'logout',
  credential: 'credential', credentials: 'credential', password: 'password',
  passwd: 'password', pwd: 'password', username: 'user', user: 'user', account: 'user',
  // polarity / states
  invalid: 'invalid', wrong: 'invalid', incorrect: 'invalid', bad: 'invalid',
  locked: 'locked', lock: 'locked', disabled: 'locked', suspended: 'locked', blocked: 'locked',
  expired: 'expired', expire: 'expired', expiry: 'expired', timeout: 'timeout',
  empty: 'empty', blank: 'empty', missing: 'empty',
  unknown: 'unknown', nonexistent: 'unknown', unregistered: 'unknown',
  reject: 'reject', rejected: 'reject', denied: 'reject', deny: 'reject',
  forbidden: 'reject', unauthorized: 'reject',
  error: 'error', fail: 'fail', failure: 'fail', failed: 'fail',
  success: 'success', successful: 'success', successfully: 'success', valid: 'valid',
  // commerce / common flows
  cart: 'cart', basket: 'cart', checkout: 'checkout', purchase: 'checkout',
  payment: 'payment', pay: 'payment', inventory: 'inventory', product: 'product',
  products: 'product', item: 'product', items: 'product',
  search: 'search', query: 'search', filter: 'filter', sort: 'sort',
  navigate: 'navigation', navigation: 'navigation', nav: 'navigation',
};

/** Multi-word phrases collapsed to a single canonical token BEFORE tokenizing. */
const PHRASES: Array<[RegExp, string]> = [
  [/\bsign[\s-]?in\b/g, 'login'],
  [/\blog[\s-]?in\b/g, 'login'],
  [/\bsign[\s-]?out\b/g, 'logout'],
  [/\blog[\s-]?out\b/g, 'logout'],
  [/\blocked[\s-]?out\b/g, 'locked'],
  [/\bsession[\s-]?timeout\b/g, 'timeout'],
  [/\bnon[\s-]?existent\b/g, 'unknown'],
];

/** Terms that mark a scenario/test as NEGATIVE (error/blocked path). */
const NEGATIVE_MARKERS = new Set([
  'invalid', 'locked', 'expired', 'timeout', 'empty', 'unknown', 'reject',
  'error', 'fail', 'without', 'cannot', 'no', 'not', 'deny',
]);

function canonicalizePhrases(text: string): string {
  let out = ` ${text.toLowerCase()} `;
  for (const [re, tok] of PHRASES) out = out.replace(re, ` ${tok} `);
  return out;
}

/** Lightweight singularization for the handful of plurals we care about. */
function singularize(tok: string): string {
  if (tok.length > 4 && tok.endsWith('ies')) return `${tok.slice(0, -3)}y`;
  if (tok.length > 3 && tok.endsWith('es')) return tok.slice(0, -2);
  if (tok.length > 3 && tok.endsWith('s') && !tok.endsWith('ss')) return tok.slice(0, -1);
  return tok;
}

/** Normalize free text → an ordered list of canonical tokens. */
export function tokenize(text: string): string[] {
  // Split camelCase BEFORE lowercasing (so "lockedUser" → "locked user"), then
  // canonicalize phrases (which lowercases), then split identifiers/paths.
  const camel = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const phrased = canonicalizePhrases(camel);
  const raw = phrased
    .replace(/[_\-./\\]+/g, ' ')       // split identifiers & paths
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    if (STOPWORDS.has(t)) continue;
    const canon = SYNONYMS[t] ?? singularize(t);
    const canon2 = SYNONYMS[canon] ?? canon;
    if (canon2.length < 3) continue; // drop 1-2 char noise ("re", "ts", "id")
    if (STOPWORDS.has(canon2)) continue;
    out.push(canon2);
  }
  return out;
}

function polarity(tokens: string[]): 'negative' | 'positive' {
  return tokens.some((t) => NEGATIVE_MARKERS.has(t)) ? 'negative' : 'positive';
}

/* ------------------------------------------------------------------ */
/*  TF-IDF cosine scorer (the default, deterministic scorer)           */
/* ------------------------------------------------------------------ */

/** A scenario→candidate scorer. Swap-in seam for a future embedding scorer. */
export interface ScenarioScorer {
  /** Returns 0..1 for every candidate, aligned to the candidates array. */
  score(scenarioTokens: string[], candidateTokens: string[][]): number[];
}

/**
 * Classic TF-IDF cosine similarity. IDF is computed over the candidate corpus so
 * distinctive terms ("locked", "timeout") outweigh common ones ("login", "user")
 * — which is exactly what separates "locked user login" from "valid user login".
 */
export class TfidfCosineScorer implements ScenarioScorer {
  score(scenarioTokens: string[], candidates: string[][]): number[] {
    const docs = candidates;
    const N = docs.length;
    if (N === 0) return [];

    // Document frequency across candidates.
    const df = new Map<string, number>();
    for (const doc of docs) {
      for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    // The scenario also contributes to IDF so its rare terms stay discriminative.
    for (const t of new Set(scenarioTokens)) df.set(t, (df.get(t) ?? 0) + 1);
    const total = N + 1;
    const idf = (t: string) => Math.log((total + 1) / ((df.get(t) ?? 0) + 1)) + 1;

    const vec = (tokens: string[]): Map<string, number> => {
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      const v = new Map<string, number>();
      for (const [t, c] of tf) v.set(t, (c / tokens.length) * idf(t));
      return v;
    };

    const sv = vec(scenarioTokens);
    return docs.map((doc) => cosine(sv, vec(doc)));
  }
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of small) {
    const w2 = large.get(t);
    if (w2 !== undefined) dot += w * w2;
  }
  let na = 0;
  for (const w of a.values()) na += w * w;
  let nb = 0;
  for (const w of b.values()) nb += w * w;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/* ------------------------------------------------------------------ */
/*  Candidate extraction from the RepositoryProfile                     */
/* ------------------------------------------------------------------ */

/**
 * Flatten the RepositoryProfile into the set of existing tests we can match
 * against. Each individual test title becomes a candidate (carrying its suite +
 * describe context); business flows are added as coarser candidates so a
 * scenario can still match a flow when per-test titles are sparse.
 */
export function extractCandidates(profile: RepositoryProfile): ExistingTestCandidate[] {
  const out: ExistingTestCandidate[] = [];
  for (const suite of profile.testSuites ?? []) {
    const s = suite as TestSuiteInfo;
    const names = s.testNames?.length ? s.testNames : [s.describeName ?? s.name];
    for (const testName of names) {
      if (!testName) continue;
      out.push({
        ref: `${s.filePath} :: ${testName}`,
        filePath: s.filePath,
        testName,
        suiteName: s.name,
        category: s.category ?? 'general',
        tags: s.tags ?? [],
        source: 'test',
      });
    }
  }
  for (const flow of profile.businessFlows ?? []) {
    const f = flow as BusinessFlow;
    const ref = f.relatedFiles?.[0] ?? `flow:${f.name}`;
    out.push({
      ref: `${ref} :: ${f.name}`,
      filePath: f.relatedFiles?.[0] ?? '',
      testName: f.name,
      suiteName: f.name,
      category: f.category ?? 'general',
      tags: [],
      source: 'business-flow',
    });
  }
  return out;
}

/** Build the text a candidate is matched on: test title + describe + filename. */
function candidateText(c: ExistingTestCandidate): string {
  const fileStem = c.filePath.split(/[\\/]/).pop()?.replace(/\.(spec|test)\.[cm]?[jt]sx?$/, '') ?? '';
  return [c.testName, c.suiteName, fileStem, c.tags.join(' ')].join(' ');
}

/** Build the text a scenario is matched on: title (primary) + objective. */
function scenarioText(s: ScenarioLike): string {
  return [s.title, s.title, s.objective ?? ''].join(' '); // title weighted 2x
}

/* ------------------------------------------------------------------ */
/*  The engine                                                         */
/* ------------------------------------------------------------------ */

/**
 * Decide coverage for a SINGLE scenario against a set of candidates. Exposed for
 * unit-level use; `discoverExistingTests` is the batch entry point.
 */
export function discoverForScenario(
  scenario: ScenarioLike,
  candidates: ExistingTestCandidate[],
  candidateTokens: string[][],
  opts: Required<Pick<DiscoveryOptions, 'existingThreshold' | 'partialThreshold' | 'maxAlternatives'>> & {
    scorer: ScenarioScorer;
  },
): ScenarioCoverage {
  const scTokens = tokenize(scenarioText(scenario));

  if (candidates.length === 0 || scTokens.length === 0) {
    return {
      scenarioId: scenario.id,
      scenario: scenario.title,
      status: 'missing',
      confidence: 0,
      existingTest: null,
      recommendation: CoverageDecision.GENERATE,
      matchedOn: [],
      reason:
        candidates.length === 0
          ? 'Repository has no existing tests to match against.'
          : 'Scenario title produced no matchable terms.',
      alternatives: [],
    };
  }

  const rawScores = opts.scorer.score(scTokens, candidateTokens);
  const scPolarity = polarity(scTokens);

  // Distinctiveness gate: a token that appears in a large fraction of candidates
  // ("login", "user") is generic and does NOT prove coverage on its own. We
  // treat a term as distinctive if it is a negative/state marker, or if it
  // appears in only a small share of candidates. A match whose overlap is made
  // up entirely of generic terms is honestly reported as MISSING rather than a
  // spurious "partial" — this is what stops "session timeout after login" from
  // looking covered just because it shares the word "login".
  const df = new Map<string, number>();
  for (const doc of candidateTokens) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const distinctiveMax = Math.max(1, Math.floor(candidateTokens.length * 0.34));
  const isDistinctive = (t: string) =>
    NEGATIVE_MARKERS.has(t) || (df.get(t) ?? 0) <= distinctiveMax;

  // Apply the polarity guard: a mismatch (positive scenario vs negative test or
  // vice versa) caps the score just below the "existing" line, so we recommend
  // EXTEND rather than wrongly REUSE. This is what stops "valid login" being
  // reported as covered by "invalid login rejected".
  const adjusted = rawScores.map((score, i) => {
    const candPol = polarity(candidateTokens[i]);
    if (score > 0 && candPol !== scPolarity) {
      return Math.min(score, opts.existingThreshold - 0.001);
    }
    return score;
  });

  // Rank candidates by adjusted score.
  const ranked = adjusted
    .map((score, i) => ({ i, score }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return {
      scenarioId: scenario.id,
      scenario: scenario.title,
      status: 'missing',
      confidence: 0,
      existingTest: null,
      recommendation: CoverageDecision.GENERATE,
      matchedOn: [],
      reason: 'No existing test shares meaningful terms with this scenario.',
      alternatives: [],
    };
  }

  const best = ranked[0];
  const bestCand = candidates[best.i];
  const matchedOn = distinctiveOverlap(scTokens, candidateTokens[best.i]);

  // If the best match shares no distinctive term, the overlap is generic filler
  // ("login", "user") and cannot be defended as coverage — report MISSING.
  if (!matchedOn.some(isDistinctive)) {
    return {
      scenarioId: scenario.id,
      scenario: scenario.title,
      status: 'missing',
      confidence: 0,
      existingTest: null,
      recommendation: CoverageDecision.GENERATE,
      matchedOn: [],
      reason:
        'Only generic terms overlap with existing tests (no distinctive shared concept) — this is new coverage.',
      alternatives: [],
    };
  }

  const confidence = Math.round(best.score * 100);

  let status: CoverageStatus;
  let recommendation: CoverageDecision;
  let reason: string;
  const polarityCapped =
    rawScores[best.i] >= opts.existingThreshold &&
    polarity(candidateTokens[best.i]) !== scPolarity;

  if (best.score >= opts.existingThreshold) {
    status = 'existing';
    recommendation = CoverageDecision.REUSE;
    reason = `Strong match with an existing test — reuse it instead of generating a duplicate.`;
  } else if (best.score >= opts.partialThreshold) {
    status = 'partial';
    recommendation = CoverageDecision.EXTEND;
    reason = polarityCapped
      ? `Related test exists but its polarity differs (e.g. positive vs negative path) — extend it rather than duplicate.`
      : `A related test exists but does not fully cover this scenario — extend it.`;
  } else {
    status = 'missing';
    recommendation = CoverageDecision.GENERATE;
    reason = `No sufficiently similar test found — this is new coverage.`;
  }

  const alternatives = ranked
    .slice(1, 1 + opts.maxAlternatives)
    .map((r) => ({ ref: candidates[r.i].ref, confidence: Math.round(r.score * 100) }));

  return {
    scenarioId: scenario.id,
    scenario: scenario.title,
    status,
    confidence,
    existingTest: status === 'missing' ? null : bestCand.ref,
    recommendation,
    matchedOn,
    reason,
    alternatives,
  };
}

/** The overlapping canonical terms, most-distinctive first, for explainability. */
function distinctiveOverlap(a: string[], b: string[]): string[] {
  const bSet = new Set(b);
  const seen = new Set<string>();
  const overlap: string[] = [];
  for (const t of a) {
    if (bSet.has(t) && !seen.has(t)) {
      seen.add(t);
      overlap.push(t);
    }
  }
  // Put negative/state markers first — they are the discriminating terms.
  return overlap.sort((x, y) => Number(NEGATIVE_MARKERS.has(y)) - Number(NEGATIVE_MARKERS.has(x)));
}

/**
 * BATCH ENTRY POINT — decide coverage for every planned scenario against the
 * repository's existing tests. Deterministic, no LLM. Returns one
 * ScenarioCoverage per input scenario, in input order.
 */
export function discoverExistingTests(
  scenarios: ScenarioLike[],
  profile: RepositoryProfile | null | undefined,
  options: DiscoveryOptions = {},
): ScenarioCoverage[] {
  const opts = {
    existingThreshold: options.existingThreshold ?? DEFAULTS.existingThreshold,
    partialThreshold: options.partialThreshold ?? DEFAULTS.partialThreshold,
    maxAlternatives: options.maxAlternatives ?? DEFAULTS.maxAlternatives,
    scorer: options.scorer ?? new TfidfCosineScorer(),
  };

  const candidates = profile ? extractCandidates(profile) : [];
  const candidateTokens = candidates.map((c) => tokenize(candidateText(c)));

  return scenarios.map((s) =>
    discoverForScenario(s, candidates, candidateTokens, opts),
  );
}

/* ------------------------------------------------------------------ */
/*  Human-readable render (log / debug — no UI, per direction)          */
/* ------------------------------------------------------------------ */

const STATUS_MARK: Record<CoverageStatus, string> = {
  existing: '✓ EXISTING',
  partial: '~ PARTIAL',
  missing: '✗ MISSING',
};

/** Render the per-scenario decisions as a developer-facing text block. */
export function formatDiscovery(results: ScenarioCoverage[]): string {
  const lines: string[] = ['Existing Test Discovery'];
  const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
  for (const r of results) {
    lines.push(
      `  ${pad(STATUS_MARK[r.status], 11)} ${pad(`${r.confidence}%`, 5)} ` +
        `${r.scenario}  →  ${r.recommendation.toUpperCase()}` +
        (r.existingTest ? `\n        ${r.existingTest}` : ''),
    );
  }
  return lines.join('\n');
}
