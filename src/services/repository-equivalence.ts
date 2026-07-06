/**
 * Repository Equivalence — Dual-Path Migration Validator
 * ============================================================================
 *
 * This module proves that the **RepositoryProvider** (new) produces the *same
 * intelligence* as the **legacy inline repository path** (old) BEFORE the
 * legacy path is deleted. It is the enforcement of the migration discipline:
 *
 *     Provider → Register → Dual Path → Compare → Delete Legacy → Merge → Next
 *
 * We do NOT introduce another provider until Repository has completed a full
 * migration cycle. The orchestrator runs BOTH paths in shadow mode, normalizes
 * their outputs, and compares them **semantically** (not `JSON.stringify`).
 *
 * ── Why semantic, not byte-for-byte ──────────────────────────────────────────
 * The user's guidance was explicit: comparing raw JSON is brittle. Two results
 * are *equivalent* when they express the same **relationships**:
 *   • the same primary methods (identity = name + filePath + methodType),
 *   • the same supporting methods in the same categories (assertions, waits,
 *     dataAccess, utilities),
 *   • the same related flows,
 *   • the same healing corroboration signals (when caller = 'healing').
 *
 * Ordering, DB row IDs, and volatile fields (usageCount jitter, sourceCode
 * whitespace) must NOT cause a mismatch — we normalize those away. What MUST
 * match is *which method plays which role*.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 * The comparison is pure and side-effect-free except for logging + counters.
 * The orchestrator calls it in a try/catch: a bug here can NEVER affect the
 * legacy result that production actually consumes. The provider path is a
 * SHADOW — observed, never trusted — until match rate proves equivalence.
 */

import { logger } from '../utils/logger';
import type { IntentQueryResult, ReusableMethod } from './knowledge-graph-service';
import type { RepositoryContext, RepositoryMethod } from './repository-provider';

const MOD = 'RepositoryEquivalence';

/* ================================================================== */
/*  Normalized (canonical) shape                                       */
/* ================================================================== */

/**
 * Canonical identity of a reusable method for equivalence purposes.
 * Deliberately EXCLUDES volatile fields (id, usageCount, sourceCode,
 * description) — those don't change *which method plays which role* and would
 * cause false mismatches if they jittered between the two code paths.
 */
export interface NormalizedMethod {
  name: string;
  filePath: string;
  methodType: string;
}

/**
 * Canonical, order-independent view of repository intelligence. Both the legacy
 * path and the provider path are projected into this shape and then compared.
 */
export interface NormalizedRepositoryContext {
  available: boolean;
  intent: string;
  primaryMethods: NormalizedMethod[];
  supportingMethods: {
    assertions: NormalizedMethod[];
    waits: NormalizedMethod[];
    dataAccess: NormalizedMethod[];
    utilities: NormalizedMethod[];
  };
  relatedFlows: string[];
  /**
   * Healing corroboration signals (only meaningful when caller = 'healing').
   * `null` when no healing evidence was gathered on either side.
   */
  healingSignals: {
    methodIndexHit: boolean;
    pageObjectHit: boolean;
    usedByTestCount: number;
    ragHit: boolean;
    topMethodSimilarity: number;
  } | null;
}

/* ================================================================== */
/*  Normalization                                                      */
/* ================================================================== */

/** Stable sort key for a method — identity is (name, filePath, methodType). */
function methodKey(m: NormalizedMethod): string {
  return `${m.name}\u0000${m.filePath}\u0000${m.methodType}`;
}

/** Project a raw ReusableMethod → canonical identity, dropping volatile fields. */
function normalizeMethod(m: ReusableMethod | RepositoryMethod): NormalizedMethod {
  return {
    name: m.name ?? '',
    filePath: m.filePath ?? '',
    methodType: m.methodType ?? '',
  };
}

/** Normalize + sort a method list so ordering never causes a false mismatch. */
function normalizeMethodList(
  methods: Array<ReusableMethod | RepositoryMethod> | undefined | null,
): NormalizedMethod[] {
  return (methods ?? [])
    .map(normalizeMethod)
    .sort((a, b) => methodKey(a).localeCompare(methodKey(b)));
}

/** Normalize the healing evidence signals from either path (or null). */
function normalizeHealingSignals(
  evidence:
    | { signals?: NormalizedRepositoryContext['healingSignals'] }
    | undefined
    | null,
): NormalizedRepositoryContext['healingSignals'] {
  const s = evidence?.signals;
  if (!s) return null;
  return {
    methodIndexHit: !!s.methodIndexHit,
    pageObjectHit: !!s.pageObjectHit,
    usedByTestCount: s.usedByTestCount ?? 0,
    ragHit: !!s.ragHit,
    // Round similarity to 4 dp so float noise between paths doesn't mismatch.
    topMethodSimilarity: round4(s.topMethodSimilarity ?? 0),
  };
}

function round4(n: number): number {
  return Math.round((Number(n) || 0) * 1e4) / 1e4;
}

/**
 * Normalize the LEGACY inline path output (IntentQueryResult, possibly with a
 * `healingEvidence` field bolted on via `(repoGraph as any)`).
 */
export function normalizeLegacy(
  legacy: IntentQueryResult & { healingEvidence?: { signals?: any } },
): NormalizedRepositoryContext {
  return {
    available: !!legacy.available,
    intent: legacy.intent ?? '',
    primaryMethods: normalizeMethodList(legacy.primaryMethods),
    supportingMethods: {
      assertions: normalizeMethodList(legacy.supportingMethods?.assertions),
      waits: normalizeMethodList(legacy.supportingMethods?.waits),
      dataAccess: normalizeMethodList(legacy.supportingMethods?.dataAccess),
      utilities: normalizeMethodList(legacy.supportingMethods?.utilities),
    },
    relatedFlows: [...(legacy.relatedFlows ?? [])].sort(),
    healingSignals: normalizeHealingSignals(legacy.healingEvidence),
  };
}

/**
 * Normalize the PROVIDER path output (RepositoryContext). This is the same
 * projection so that — if the provider is faithful — both normalize to a
 * deep-equal canonical form.
 */
export function normalizeProvider(
  context: RepositoryContext | null,
): NormalizedRepositoryContext {
  if (!context) {
    return {
      available: false,
      intent: '',
      primaryMethods: [],
      supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
      relatedFlows: [],
      healingSignals: null,
    };
  }
  return {
    available: !!context.available,
    intent: context.intent ?? '',
    primaryMethods: normalizeMethodList(context.primaryMethods),
    supportingMethods: {
      assertions: normalizeMethodList(context.supportingMethods?.assertions),
      waits: normalizeMethodList(context.supportingMethods?.waits),
      dataAccess: normalizeMethodList(context.supportingMethods?.dataAccess),
      utilities: normalizeMethodList(context.supportingMethods?.utilities),
    },
    relatedFlows: [...(context.relatedFlows ?? [])].sort(),
    healingSignals: normalizeHealingSignals(context.healingEvidence),
  };
}

/* ================================================================== */
/*  Semantic comparison                                                */
/* ================================================================== */

export interface EquivalenceResult {
  /** True when legacy and provider are semantically equivalent. */
  match: boolean;
  /** Human-readable descriptions of each semantic difference found. */
  differences: string[];
}

/** Compare two normalized method lists; describe adds/drops by identity. */
function diffMethodLists(
  label: string,
  legacy: NormalizedMethod[],
  provider: NormalizedMethod[],
  out: string[],
): void {
  const legacyKeys = new Set(legacy.map(methodKey));
  const providerKeys = new Set(provider.map(methodKey));

  for (const m of legacy) {
    if (!providerKeys.has(methodKey(m))) {
      out.push(`${label}: legacy has "${m.name}" (${m.methodType} @ ${m.filePath}) but provider does not`);
    }
  }
  for (const m of provider) {
    if (!legacyKeys.has(methodKey(m))) {
      out.push(`${label}: provider has "${m.name}" (${m.methodType} @ ${m.filePath}) but legacy does not`);
    }
  }
}

/**
 * Semantic deep-compare of two normalized contexts. Order-independent for all
 * method sets and flows. Returns every difference (not just the first) so the
 * mismatch log is actionable.
 */
export function compareRepositoryOutputs(
  legacy: NormalizedRepositoryContext,
  provider: NormalizedRepositoryContext,
): EquivalenceResult {
  const differences: string[] = [];

  if (legacy.available !== provider.available) {
    differences.push(`available: legacy=${legacy.available} provider=${provider.available}`);
  }
  if (legacy.intent !== provider.intent) {
    differences.push(`intent: legacy="${legacy.intent}" provider="${provider.intent}"`);
  }

  diffMethodLists('primaryMethods', legacy.primaryMethods, provider.primaryMethods, differences);
  diffMethodLists('assertions', legacy.supportingMethods.assertions, provider.supportingMethods.assertions, differences);
  diffMethodLists('waits', legacy.supportingMethods.waits, provider.supportingMethods.waits, differences);
  diffMethodLists('dataAccess', legacy.supportingMethods.dataAccess, provider.supportingMethods.dataAccess, differences);
  diffMethodLists('utilities', legacy.supportingMethods.utilities, provider.supportingMethods.utilities, differences);

  // relatedFlows — order-independent set comparison
  const legacyFlows = new Set(legacy.relatedFlows);
  const providerFlows = new Set(provider.relatedFlows);
  for (const f of legacy.relatedFlows) {
    if (!providerFlows.has(f)) differences.push(`relatedFlows: legacy has "${f}" but provider does not`);
  }
  for (const f of provider.relatedFlows) {
    if (!legacyFlows.has(f)) differences.push(`relatedFlows: provider has "${f}" but legacy does not`);
  }

  // Healing signals — compare only when either side has them.
  const ls = legacy.healingSignals;
  const ps = provider.healingSignals;
  if (JSON.stringify(ls) !== JSON.stringify(ps)) {
    differences.push(`healingSignals: legacy=${JSON.stringify(ls)} provider=${JSON.stringify(ps)}`);
  }

  return { match: differences.length === 0, differences };
}

/* ================================================================== */
/*  Match-rate recorder                                                */
/* ================================================================== */

/**
 * Aggregates match/mismatch counts across the process lifetime so we can see
 * "99.9% match" before deleting legacy. Logs each comparison and periodically
 * emits the running match rate. This is intentionally in-memory + best-effort;
 * it exists to build confidence in the migration, not for durable analytics.
 */
class RepositoryEquivalenceRecorder {
  private total = 0;
  private matches = 0;
  private mismatches = 0;

  record(intent: string, caller: string, result: EquivalenceResult): void {
    this.total += 1;
    if (result.match) {
      this.matches += 1;
      logger.info(MOD, 'Dual-path MATCH', {
        intent,
        caller,
        total: this.total,
        matchRatePct: this.matchRatePct(),
      });
    } else {
      this.mismatches += 1;
      logger.warn(MOD, 'Dual-path MISMATCH — provider differs from legacy', {
        intent,
        caller,
        total: this.total,
        mismatches: this.mismatches,
        matchRatePct: this.matchRatePct(),
        // Cap logged differences to keep log lines bounded.
        differences: result.differences.slice(0, 20),
      });
    }
  }

  matchRatePct(): number {
    if (this.total === 0) return 100;
    return round4((this.matches / this.total) * 100);
  }

  stats(): { total: number; matches: number; mismatches: number; matchRatePct: number } {
    return {
      total: this.total,
      matches: this.matches,
      mismatches: this.mismatches,
      matchRatePct: this.matchRatePct(),
    };
  }

  /** Test-only: reset counters. */
  reset(): void {
    this.total = 0;
    this.matches = 0;
    this.mismatches = 0;
  }
}

let recorderInstance: RepositoryEquivalenceRecorder | undefined;

export function getRepositoryEquivalenceRecorder(): RepositoryEquivalenceRecorder {
  if (!recorderInstance) {
    recorderInstance = new RepositoryEquivalenceRecorder();
  }
  return recorderInstance;
}

/* ================================================================== */
/*  One-shot convenience                                               */
/* ================================================================== */

/**
 * Normalize both paths, compare them, and record the outcome. Returns the
 * EquivalenceResult for callers/tests that want it. Pure except for the
 * recorder's counters + logging.
 */
export function evaluateRepositoryEquivalence(
  legacy: IntentQueryResult & { healingEvidence?: { signals?: any } },
  provider: RepositoryContext | null,
  meta: { intent: string; caller: string },
): EquivalenceResult {
  const result = compareRepositoryOutputs(normalizeLegacy(legacy), normalizeProvider(provider));
  getRepositoryEquivalenceRecorder().record(meta.intent, meta.caller, result);
  return result;
}
