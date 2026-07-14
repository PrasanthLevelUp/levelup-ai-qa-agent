/**
 * Scenario Planner — the SINGLE SOURCE OF TRUTH for "what scenarios exist".
 * ============================================================================
 *
 * Architectural boundary (do not blur it):
 *
 *   The Scenario Planner is the ONLY component allowed to decide whether a
 *   business scenario exists. Everything downstream — the QA Knowledge Engine
 *   (enrichment), the Scenario Builder (transformation), the Script Composer,
 *   Healing — treats the planner's output as IMMUTABLE. They enrich, transform,
 *   validate or consume scenarios; they never create or remove them.
 *
 * A scenario earns its place from its OBLIGATION, which the KNOWLEDGE BASE (not
 * the Planner) owns as data — see `getScenarioObligation`, which returns a
 * { level, condition } pair. The Planner applies one fixed, generic rule based
 * on `condition`:
 *
 *   • condition 'always'   — emitted for every feature of the category, grounded
 *                            in the Requirement that established the category, NOT
 *                            in keyword evidence. The happy-path (`core`) and the
 *                            category obligations (e.g. "invalid credentials
 *                            rejected" for a credential login) are both 'always'.
 *   • condition 'evidence' — justified ONLY by explicit evidence, matched in this
 *                            priority order:
 *                              1. Acceptance Criteria   (the strongest, explicit spec)
 *                              2. Requirement description
 *                              3. App Knowledge         (pages/elements/forms crawled)
 *                              4. Test Data             (supplied datasets)
 *                            An 'evidence' scenario with no recognised evidence is
 *                            NOT planned — this is where "no invention" is enforced.
 *
 * `level` ('required' | 'optional') describes the STRENGTH of the obligation. It
 * is carried through for future prioritisation / coverage-gap reporting but does
 * not yet gate emission — `condition` alone decides what is planned.
 *
 * Separation of concerns (the whole point of this layer):
 *
 *   • The Planner maps EVIDENCE → SCENARIO IDENTITIES. It stays "dumb": it does
 *     NOT decide which scenarios are obligations, and it does NOT know testing
 *     heuristics (what "lockout"/"sql injection"/"expired" mean). Both the
 *     obligation metadata and the recognition vocabulary + matching live in the
 *     Knowledge layer (`getScenarioObligation`, `recognizeScenarioEvidence`), so
 *     the Planner never turns into a second knowledge engine.
 *   • The Planner emits FACTS (structured `evidence`), NOT scores. Confidence is
 *     computed downstream by the orchestrator (`computeConfidence`) so scoring
 *     is consistent across the whole platform and the Planner has one job.
 *
 * Coverage Types are a FILTER, never a creator. Selecting "negative" asks
 * "include the negative scenarios that the KB obligations / evidence justify" —
 * it can never conjure a CONDITIONAL scenario the requirement/AC/app/data never
 * mention. A bare "user can log in" requirement yields the category's core +
 * mandatory obligations (valid login, invalid credentials, required fields), not
 * a padded list of invented failures. Quality over quantity.
 *
 * Every planned scenario carries its provenance:
 *
 *   { whyExists, source, derivedFrom, assumption, evidence[] }
 *
 * If the planner cannot attach at least one piece of evidence to a scenario,
 * that scenario is NOT planned — it does not exist. This gives explainability,
 * not just a filter.
 *
 * The planner is PURE + synchronous (ZERO LLM tokens).
 */

import type { CoverageType, RequirementInput } from './test-coverage-engine';
import {
  classifyQACategory,
  getBaselineScenarios,
  getScenarioObligation,
  recognizeScenarioEvidence,
  QA_KNOWLEDGE_VERSION,
  type QACategory,
  type PlannedScenario,
  type QACategoryClassification,
  type ScenarioEvidence,
  type EvidenceSource,
  type NormalizedEvidence,
} from './qa-knowledge-engine';

export type { ScenarioEvidence, EvidenceSource } from './qa-knowledge-engine';

/** Where a scenario's justification came from (explicit evidence only). */
export type ProvenanceSource =
  | 'Requirement'
  | 'Acceptance Criteria'
  | 'App Knowledge'
  | 'Test Data'
  /**
   * Deep Coverage (Sprint 5.2) — a domain best-practice scenario emitted ONLY
   * when the user opts into Deep Coverage. It is grounded in the QA Knowledge
   * Base's obligations for the detected category (NOT hallucinated), but is not
   * gated on explicit evidence in THIS requirement. Always carries assumption:true
   * so it is never mistaken for requirement-grounded coverage.
   */
  | 'Deep Coverage';

/** Map the machine evidence source to the human-readable provenance bucket. */
const SOURCE_LABEL: Record<EvidenceSource, ProvenanceSource> = {
  acceptanceCriteria: 'Acceptance Criteria',
  requirement: 'Requirement',
  appKnowledge: 'App Knowledge',
  testData: 'Test Data',
};

/**
 * Why a scenario exists. This is the planner's contract: a scenario without at
 * least one piece of `evidence` is never emitted.
 *
 * NOTE: there is deliberately NO numeric confidence here. The Planner emits
 * facts (evidence); the orchestrator scores them (`computeConfidence`).
 */
export interface ScenarioProvenance {
  /** Human sentence explaining why this scenario was derived. */
  whyExists: string;
  /** The (highest-priority) evidence bucket that justified it. */
  source: ProvenanceSource;
  /** The exact evidence text of the highest-priority match (readable citation). */
  derivedFrom: string;
  /**
   * By construction the planner ONLY emits evidence-backed scenarios, so this is
   * always false. Retained (salvaged from the earlier provenance model) so any
   * future inferred scenario could be flagged honestly instead of silently.
   */
  assumption: boolean;
  /**
   * The structured, strongly-typed evidence that justifies this scenario — every
   * matching AC clause / requirement / app-knowledge / test-data item, in
   * priority order. This is the reusable contract downstream modules (Script
   * Gen, Healing, RCA, Impact Analysis, Explainability) consume so they can
   * explain WHY a scenario exists without reparsing the requirement.
   */
  evidence: ScenarioEvidence[];
}

/** A planned scenario annotated with the provenance that justifies it. */
export interface PlannedScenarioWithProvenance extends PlannedScenario {
  provenance: ScenarioProvenance;
}

/**
 * A single EXPLICIT requirement step — a numbered instruction, bullet, acceptance
 * criterion, or business-flow line the author actually wrote. Sprint 5.1 makes
 * these the PRIMARY source of scenarios: every step must be represented by at
 * least one generated test case before any baseline/deep coverage is added.
 */
export interface RequirementStep {
  /** Stable id: req-step-<n>. */
  id: string;
  /** The exact author text of the step (readable citation, capped). */
  text: string;
  /** Which requirement field this step was extracted from. */
  source: 'acceptanceCriteria' | 'description' | 'businessFlow';
  /** Coverage type inferred from the step's wording (positive default). */
  coverageType: CoverageType;
}

/** Per-step coverage record — powers the "Requirement Coverage X/Y" KPI. */
export interface RequirementStepCoverage {
  id: string;
  text: string;
  source: RequirementStep['source'];
  /** True when at least one planned scenario represents this step. */
  covered: boolean;
  /** Ids of the planned scenarios that cover this step. */
  scenarioIds: string[];
}

/**
 * The Requirement Coverage summary — the headline trust metric. The product
 * guarantee (Sprint 5.1) is that this is ALWAYS 100%: no explicit requirement
 * step is left without a test case.
 */
export interface RequirementCoverage {
  steps: RequirementStepCoverage[];
  total: number;
  covered: number;
  /** Integer percent 0-100. */
  percent: number;
}

export interface ScenarioPlan {
  /** Detected QA category + confidence + the signals that drove it. */
  classification: QACategoryClassification;
  /** The justified scenarios (filtered to the user's selected coverage types). */
  scenarios: PlannedScenarioWithProvenance[];
  /** Count of justified scenarios (== scenarios.length; all are evidence-backed). */
  justifiedCount: number;
  /**
   * Requirement Coverage — the mandatory per-step coverage map (Sprint 5.1).
   * Guaranteed 100% because unmatched steps synthesize a requirement-derived
   * scenario. Undefined only on the legacy zero-requirement edge.
   */
  requirementCoverage: RequirementCoverage;
  /** KB version for telemetry correlation. */
  knowledgeVersion: string;
  /** Whether the plan is empty (generic category or nothing justified). */
  isEmpty: boolean;
}

/**
 * Minimal shape of the knowledge context the planner reads for evidence.
 * Deliberately permissive (index signatures) so the richer engine
 * `KnowledgeContext` is structurally assignable without a cast — the planner
 * only reads the handful of fields below and ignores the rest.
 */
interface PlannerKnowledge {
  applicationProfile?: {
    name?: string;
    pages?: Array<{ title?: string; pageType?: string; [k: string]: any }>;
    keyElements?: Array<{ label?: string; role?: string; tag?: string; [k: string]: any }>;
    forms?: Array<{ submitLabel?: string; [k: string]: any }>;
    [k: string]: any;
  };
  testData?: Array<{ name?: string; sampleKeys?: string[]; [k: string]: any }>;
  [k: string]: any;
}

const lc = (s?: string) => (s || '').toLowerCase();

/**
 * Split acceptance criteria into individual clauses so a matched scenario can
 * cite the SPECIFIC criterion it came from (not the whole blob). Splits on
 * newlines, bullets, semicolons and numbered markers — no NLP, fully
 * deterministic.
 */
function splitAcceptanceClauses(ac?: string): string[] {
  if (!ac) return [];
  return ac
    .split(/\r?\n|;|•|\u2022|\u2023|\u25E6|(?:^|\s)[-*]\s+|\d+[.)]\s+/)
    .map(c => c.trim())
    .filter(c => c.length > 0);
}

/** Cap evidence text so provenance stays a readable citation, not a dump. */
function cap(s: string, n = 160): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** All searchable App Knowledge text — page titles/types, element labels/roles,
 * form submit labels. Deliberately EXCLUDES field names so a password/username
 * field never false-matches a security/negative keyword. */
function appKnowledgeText(k?: PlannerKnowledge): string {
  const ap = k?.applicationProfile;
  if (!ap) return '';
  const parts: string[] = [];
  if (ap.name) parts.push(ap.name);
  for (const p of ap.pages || []) { if (p.title) parts.push(p.title); if (p.pageType) parts.push(p.pageType); }
  for (const e of ap.keyElements || []) { if (e.label) parts.push(e.label); if (e.role) parts.push(e.role); }
  for (const f of ap.forms || []) { if (f.submitLabel) parts.push(f.submitLabel); }
  return lc(parts.join(' '));
}

/** All searchable Test Data text — dataset names + sample keys. */
function testDataText(k?: PlannerKnowledge): string {
  const parts: string[] = [];
  for (const d of k?.testData || []) {
    if (d.name) parts.push(d.name);
    for (const key of d.sampleKeys || []) parts.push(key);
  }
  return lc(parts.join(' '));
}

/**
 * Assemble the normalized evidence buckets for a requirement. This is evidence
 * COLLECTION (which the Planner owns for now — a dedicated Evidence Collector is
 * a later stage). The MATCHING against this evidence is owned by the Knowledge
 * layer (`recognizeScenarioEvidence`), never here.
 */
function buildEvidence(
  input: Pick<RequirementInput, 'title' | 'description' | 'module' | 'businessFlow' | 'acceptanceCriteria'>,
  knowledge?: PlannerKnowledge,
): NormalizedEvidence {
  return {
    requirementText: lc([input.title, input.description, input.module, input.businessFlow].filter(Boolean).join(' ')),
    requirementLabel: cap((input.title || input.description || 'the requirement').trim()),
    acceptanceClauses: splitAcceptanceClauses(input.acceptanceCriteria),
    appKnowledge: appKnowledgeText(knowledge),
    testData: testDataText(knowledge),
  };
}

/**
 * Derive the provenance for a baseline scenario, or null if the evidence does
 * not justify it (⇒ the scenario is not planned). This is where "no invention"
 * is enforced — an 'evidence' scenario with no recognised evidence simply does
 * not exist.
 *
 * The Planner does NOT decide WHICH scenarios are obligations, nor does it
 * inspect keywords: it asks the Knowledge layer for the scenario's obligation
 * (`getScenarioObligation`) and delegates recognition to it
 * (`recognizeScenarioEvidence`). It only maps the result into provenance. No
 * numeric confidence is attached — the orchestrator scores the evidence
 * downstream.
 *
 * Two emission paths, keyed off obligation.condition (owned by the KB):
 *   • 'always'   — justified by the Requirement that established the category.
 *                  `core` reads as the primary happy-path; every other 'always'
 *                  obligation reads as a category obligation. No keyword needed.
 *   • 'evidence' — justified ONLY by recognised explicit evidence, else dropped.
 */
function deriveProvenance(
  scenario: PlannedScenario,
  ev: NormalizedEvidence,
  category: QACategory,
): ScenarioProvenance | null {
  const obligation = getScenarioObligation(scenario);

  // ALWAYS obligations are emitted for ANY feature of this category — the KB
  // declares them, the Planner just honours them. They are grounded in the
  // Requirement that ESTABLISHED the category (not in keyword evidence), so the
  // citation is the requirement itself. This is an evidence MAPPING (obligation ⇒
  // requirement evidence), not a testing heuristic, so it stays in the Planner.
  // The only difference between the happy-path and the other always-obligations
  // is the human-readable reason: `core` is the primary flow the requirement
  // states, the rest are category obligations the requirement implies.
  if (obligation.condition === 'always') {
    const evidence: ScenarioEvidence[] = [{
      id: `${scenario.id}:req`,
      source: 'requirement',
      reference: 'REQ',
      excerpt: ev.requirementLabel,
    }];
    const whyExists = scenario.core
      ? 'Primary happy-path stated by the requirement'
      : `Standard ${category} obligation — expected for any ${category} feature, independent of the specific wording`;
    return {
      whyExists,
      source: 'Requirement',
      derivedFrom: ev.requirementLabel,
      assumption: false,
      evidence,
    };
  }

  // EVIDENCE obligations: ask the Knowledge layer which evidence recognises this
  // scenario. Nothing recognised → not planned (the Planner never invents).
  const evidence = recognizeScenarioEvidence(scenario, ev);
  if (!evidence.length) return null; // no recognised evidence → not planned

  // The highest-priority match (evidence is returned AC → REQ → AK → TD) drives
  // the human-readable provenance summary.
  const primary = evidence[0];
  return {
    whyExists: `Justified by ${SOURCE_LABEL[primary.source]}: "${primary.excerpt}"`,
    source: SOURCE_LABEL[primary.source],
    derivedFrom: primary.excerpt,
    assumption: false,
    evidence,
  };
}

/* ---------------------------------------------------------------------------
 * Sprint 5.1 — Requirement Completeness
 * The requirement is the PRIMARY source of scenarios. We extract every explicit
 * step (numbered instruction / bullet / acceptance criterion / business-flow
 * line) and GUARANTEE each is represented by at least one scenario. The baseline
 * library is ADDITIVE (adds quality) — it never replaces requirement coverage.
 * ------------------------------------------------------------------------- */

/** Splitter for explicit step markers: newlines, bullets, numbered markers,
 *  flow arrows, and sentence terminators. Deterministic — no NLP. */
const STEP_SPLIT_RE = /\r?\n|(?:^|\s)[-*]\s+|[•\u2022\u2023\u25E6]|\d+[.)]\s+|→|=>|(?<=[.!?])\s+(?=[A-Z0-9"'(])/;

/** Leading BDD / ordinal noise we strip so two phrasings of the same step match. */
const STEP_PREFIX_RE = /^\s*(?:given|when|then|and|but|step\s*\d+|scenario)\b[:.)\-]?\s*/i;

/** Words that add no meaning to token-overlap similarity. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'are', 'be', 'in', 'on', 'for',
  'with', 'that', 'this', 'it', 'as', 'at', 'by', 'from', 'should', 'must', 'will',
  'shall', 'can', 'user', 'users', 'system', 'when', 'then', 'given', 'if',
]);

/** Cues that flip an extracted step's inferred coverage type away from positive. */
const NEGATIVE_CUES = ['invalid', 'incorrect', 'reject', 'error', 'fail', 'must not', 'cannot', "can't", 'denied', 'deny', 'unauthorized', 'unauthorised', 'blocked', 'forbidden', 'not allowed', 'wrong', 'missing', 'empty', 'without', 'prevent'];
const BOUNDARY_CUES = ['maximum', 'minimum', ' max ', ' min ', 'at least', 'at most', 'up to', 'no more than', 'no less than', 'limit', 'characters', 'length', 'between', 'exceed'];
const SECURITY_CUES = ['injection', 'xss', 'csrf', 'sql', 'sanitiz', 'sanitis', 'malicious', 'session token', 'brute', 'permission', 'role', 'authorization', 'authorisation', 'access control'];

function inferStepCoverageType(text: string): CoverageType {
  const t = lc(` ${text} `);
  if (SECURITY_CUES.some(c => t.includes(c))) return 'security';
  if (BOUNDARY_CUES.some(c => t.includes(c))) return 'boundary';
  if (NEGATIVE_CUES.some(c => t.includes(c))) return 'negative';
  return 'positive';
}

/** Normalize step text to a comparable token set (lowercase, stopwords removed). */
function tokenize(text: string): Set<string> {
  return new Set(
    lc(text)
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Jaccard token overlap of two texts (0-1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** A short, readable scenario title from a longer step sentence. */
function stepTitle(text: string): string {
  const words = text.replace(/[.;:]+$/, '').split(/\s+/);
  const short = words.slice(0, 9).join(' ');
  const titled = short.charAt(0).toUpperCase() + short.slice(1);
  return words.length > 9 ? `${titled}…` : titled;
}

/**
 * Extract explicit requirement steps from the acceptance criteria, description
 * and business flow. Steps are de-duplicated (lexically) across fields, in
 * priority order AC → description → businessFlow, so the strongest spec wins.
 */
export function extractRequirementSteps(
  input: Partial<Pick<RequirementInput, 'description' | 'businessFlow' | 'acceptanceCriteria'>>,
): RequirementStep[] {
  const fields: Array<{ source: RequirementStep['source']; raw?: string }> = [
    { source: 'acceptanceCriteria', raw: input.acceptanceCriteria },
    { source: 'description', raw: input.description },
    { source: 'businessFlow', raw: input.businessFlow },
  ];

  const steps: RequirementStep[] = [];
  const seen: Set<string>[] = []; // token sets already accepted (for cross-field dedup)
  let n = 0;

  for (const { source, raw } of fields) {
    if (!raw || !raw.trim()) continue;
    const fragments = raw
      .split(STEP_SPLIT_RE)
      .map(f => (f || '').replace(STEP_PREFIX_RE, '').trim())
      .filter(f => f.length >= 4 && /[a-z0-9]/i.test(f));

    for (const frag of fragments) {
      const toks = tokenize(frag);
      if (toks.size === 0) continue;
      // Skip if a near-identical step was already captured (>= 0.8 overlap).
      if (seen.some(prev => jaccard(prev, toks) >= 0.8)) continue;
      seen.push(toks);
      n += 1;
      steps.push({
        id: `req-step-${n}`,
        text: cap(frag, 200),
        source,
        coverageType: inferStepCoverageType(frag),
      });
      if (steps.length >= MAX_REQUIREMENT_STEPS) return steps; // runaway guard
    }
  }
  return steps;
}

/** Upper bound on extracted steps so a pathological paste never explodes the plan. */
const MAX_REQUIREMENT_STEPS = 60;

/** How close a scenario must be to a step (token overlap) to "cover" it. */
const STEP_COVER_THRESHOLD = 0.34;

/** Build a requirement-derived scenario for a step the baseline did not cover. */
function requirementScenario(step: RequirementStep): PlannedScenarioWithProvenance {
  const isAC = step.source === 'acceptanceCriteria';
  const sourceLabel: ProvenanceSource = isAC ? 'Acceptance Criteria' : 'Requirement';
  const evSource: EvidenceSource = isAC ? 'acceptanceCriteria' : 'requirement';
  const fieldName = step.source === 'acceptanceCriteria' ? 'Acceptance Criteria'
    : step.source === 'businessFlow' ? 'Business Flow' : 'Requirement description';
  return {
    id: step.id,
    title: stepTitle(step.text),
    objective: `Verify the requirement: "${step.text}"`,
    coverageType: step.coverageType,
    priority: 'P1',
    riskArea: 'Requirement coverage',
    provenance: {
      whyExists: `Explicit requirement step (${fieldName})`,
      source: sourceLabel,
      derivedFrom: step.text,
      assumption: false,
      evidence: [{
        id: `${step.id}:${evSource}`,
        source: evSource,
        reference: isAC ? 'AC' : 'REQ',
        excerpt: step.text,
      }],
    },
  };
}

/**
 * Build a deterministic scenario plan for a requirement.
 *
 * Pipeline (Sprint 5.1 + 5.2):
 *   1. Requirement Coverage (MANDATORY) — every explicit step gets a scenario.
 *   2. Baseline Library (additive) — evidence-justified category obligations,
 *      filtered to the user's selected coverage types.
 *   3. Deep Coverage (optional) — when `deep`, also emit the category's known
 *      obligations that lack explicit evidence, as honest best-practice cases.
 *   4. Deduplicate (lexical) — merge near-identical scenarios; requirement
 *      coverage is preserved (a step matched to a baseline scenario stays covered).
 *
 * @param input          The requirement.
 * @param coverageTypes  The user's SELECTED coverage types (a FILTER for the
 *                       baseline/deep library only — requirement steps are ALWAYS
 *                       covered regardless).
 * @param featureTypeHint Optional upstream analysis featureType hint.
 * @param knowledge      Optional App Knowledge / Test Data — additional evidence.
 * @param deep           Deep Coverage toggle (Sprint 5.2). When true, broadens
 *                       the baseline library with best-practice obligations.
 */
/**
 * Requirement-aware Deep Coverage sets (Sprint 6.x).
 *
 * Deep Coverage USED to expand every requirement to the SAME fixed 7 types
 * (positive, negative, edge_cases, boundary, security, integration, role_based).
 * That is right for a complex workflow but wasteful for a simple one — a login
 * story does not need boundary/integration/role_based, yet paid tokens for them
 * on BOTH the prompt (planned-scenario block) and completion (per-scenario
 * output budget) sides. That's what tripled a login run's tokens (4.5k → 13k)
 * for little added value.
 *
 * The fix is NOT a token cap (which would truncate genuine coverage on a big
 * requirement — explicitly forbidden by the "budget never shrinks coverage"
 * directive). Instead we make the deep set CONTEXT-AWARE: each QA category adds
 * only the extra coverage types that actually matter for it. The user's own
 * selection is always honoured on top of this (union) — we only decide what
 * Deep ADDS, never what it removes.
 */
const DEEP_COVERAGE_TYPES_BY_CATEGORY: Record<QACategory, CoverageType[]> = {
  // Auth: credential correctness + abuse resistance. No boundary/integration/RBAC.
  authentication: ['positive', 'negative', 'edge_cases', 'security'],
  // CRUD: field-level correctness + limits. No security/RBAC unless user asked.
  crud: ['positive', 'negative', 'edge_cases', 'boundary'],
  // Search: query handling + input limits.
  search: ['positive', 'negative', 'edge_cases', 'boundary'],
  // Checkout: money path — the widest legitimately-deep flow.
  checkout: ['positive', 'negative', 'edge_cases', 'boundary', 'security', 'integration'],
  // Payment: money path + gateway integration + fraud surface.
  payment: ['positive', 'negative', 'edge_cases', 'boundary', 'security', 'integration'],
  // Admin: privilege + access control is the whole point → role_based + security.
  admin: ['positive', 'negative', 'edge_cases', 'security', 'role_based'],
  // Workflow: multi-step state hand-off → integration matters, boundary rarely.
  workflow: ['positive', 'negative', 'edge_cases', 'integration'],
  // Reporting: correctness of aggregates + range limits.
  reporting: ['positive', 'negative', 'edge_cases', 'boundary'],
  // Import: file parsing + malformed input + downstream persistence.
  import: ['positive', 'negative', 'edge_cases', 'boundary', 'integration'],
  // Export: output correctness + large-set limits.
  export: ['positive', 'negative', 'edge_cases', 'boundary'],
  // Generic/unknown: stay conservative — do NOT invent security/RBAC surface for
  // a feature we couldn't classify. Positive/negative/edge is the honest floor.
  generic: ['positive', 'negative', 'edge_cases'],
};

export function planScenarios(
  input: Pick<RequirementInput, 'title' | 'description' | 'module' | 'businessFlow' | 'acceptanceCriteria'>,
  coverageTypes: CoverageType[],
  featureTypeHint?: string,
  knowledge?: PlannerKnowledge,
  deep = false,
): ScenarioPlan {
  const classification = classifyQACategory(input, featureTypeHint);
  const baseline = getBaselineScenarios(classification.category);

  // Respect the user's coverage selection for the LIBRARY only. If nothing is
  // selected, fall back to positive. In Deep mode the selection is broadened —
  // but by a REQUIREMENT-AWARE set (per category), not a fixed 7-type blast, so
  // a simple requirement is not padded with irrelevant types (see the map above).
  const deepTypes = DEEP_COVERAGE_TYPES_BY_CATEGORY[classification.category]
    ?? DEEP_COVERAGE_TYPES_BY_CATEGORY.generic;
  const base: CoverageType[] = coverageTypes.length ? coverageTypes : ['positive'];
  const selected = new Set<CoverageType>(deep ? [...base, ...deepTypes] : base);

  const evidence = buildEvidence(input, knowledge);

  const scenarios: PlannedScenarioWithProvenance[] = [];

  // ── Phase 2: Baseline library (evidence-justified) ──
  // Existing behaviour — a scenario earns its place from explicit evidence /
  // 'always' obligation. Coverage type filters; provenance decides existence.
  const emittedIds = new Set<string>();
  for (const s of baseline) {
    if (!selected.has(s.coverageType)) continue;
    const provenance = deriveProvenance(s, evidence, classification.category);
    if (!provenance) continue; // unjustified → not planned (no invention)
    scenarios.push({ ...s, provenance });
    emittedIds.add(s.id);
  }

  // ── Phase 3: Deep Coverage (optional, honest best-practice) ──
  // Emit the category's KNOWN obligations that lacked explicit evidence, marked
  // as assumption-based Deep Coverage so they are never mistaken for grounded
  // requirement coverage. This is what makes the toggle produce MORE real cases.
  if (deep) {
    for (const s of baseline) {
      if (emittedIds.has(s.id)) continue;
      if (!selected.has(s.coverageType)) continue;
      const obligation = getScenarioObligation(s);
      if (obligation.condition === 'always') continue; // already covered above
      scenarios.push({
        ...s,
        provenance: {
          whyExists: `Deep Coverage: standard ${classification.category} ${s.coverageType} check — domain best-practice, not explicitly stated in this requirement`,
          source: 'Deep Coverage',
          derivedFrom: `${classification.category} best-practice`,
          assumption: true,
          evidence: [],
        },
      });
      emittedIds.add(s.id);
    }
  }

  // ── Phase 1 (guarantee): Requirement Coverage ──
  // Extract explicit steps and ensure each maps to at least one scenario. A step
  // already represented by an emitted scenario (lexical match) is marked covered
  // by it; otherwise we synthesize a requirement-derived scenario. Requirement
  // steps are NEVER dropped for coverage-type reasons — completeness first.
  const steps = extractRequirementSteps(input);
  const scenarioTokens = scenarios.map(s => tokenize(`${s.title} ${s.objective} ${(s.conditionalOnKeywords || []).join(' ')}`));
  const coverage: RequirementStepCoverage[] = [];

  for (const step of steps) {
    const stepToks = tokenize(step.text);
    const matchedIds: string[] = [];
    let best = 0;
    scenarios.forEach((s, i) => {
      const sim = jaccard(stepToks, scenarioTokens[i]);
      if (sim >= STEP_COVER_THRESHOLD) matchedIds.push(s.id);
      if (sim > best) best = sim;
    });

    if (matchedIds.length === 0) {
      // No existing scenario represents this step → synthesize one (mandatory).
      const rs = requirementScenario(step);
      scenarios.push(rs);
      scenarioTokens.push(stepToks);
      matchedIds.push(rs.id);
    }
    coverage.push({ id: step.id, text: step.text, source: step.source, covered: true, scenarioIds: matchedIds });
  }

  const requirementCoverage: RequirementCoverage = {
    steps: coverage,
    total: coverage.length,
    covered: coverage.filter(c => c.covered).length,
    percent: coverage.length === 0 ? 100 : Math.round((coverage.filter(c => c.covered).length / coverage.length) * 100),
  };

  return {
    classification,
    scenarios,
    justifiedCount: scenarios.length,
    requirementCoverage,
    knowledgeVersion: QA_KNOWLEDGE_VERSION,
    isEmpty: scenarios.length === 0,
  };
}

/**
 * Render a scenario plan into a compact prompt block. Because the planner is now
 * the single source of truth for scenario existence, the block tells the LLM to
 * REFINE the wording of these scenarios — it must NOT invent additional
 * scenarios. Each line cites its provenance so the instruction is self-evident.
 *
 * Returns '' for an empty plan so the caller can cleanly fall back to the legacy
 * (plan-free) prompt with no dangling section.
 */
export function buildScenarioPlanBlock(plan: ScenarioPlan): string {
  if (plan.isEmpty) return '';

  // ── Phase 5: Ordering — Happy → Negative → Boundary → Edge → the rest. ──
  const TYPE_ORDER: CoverageType[] = ['positive', 'negative', 'boundary', 'edge_cases', 'security', 'integration', 'role_based'];
  const orderIdx = (t: CoverageType) => {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? TYPE_ORDER.length : i;
  };
  const byType = new Map<CoverageType, PlannedScenarioWithProvenance[]>();
  for (const s of plan.scenarios) {
    const arr = byType.get(s.coverageType) || [];
    arr.push(s);
    byType.set(s.coverageType, arr);
  }
  const orderedTypes = [...byType.keys()].sort((a, b) => orderIdx(a) - orderIdx(b));

  const lines: string[] = [];
  for (const type of orderedTypes) {
    lines.push(`  [${type}]`);
    // Within a type, list requirement-grounded scenarios first, then Deep Coverage.
    const items = (byType.get(type) || []).slice().sort((a, b) => {
      const aDeep = a.provenance.source === 'Deep Coverage' ? 1 : 0;
      const bDeep = b.provenance.source === 'Deep Coverage' ? 1 : 0;
      return aDeep - bDeep;
    });
    for (const s of items) {
      const tag = s.provenance.source === 'Deep Coverage' ? 'deep-coverage' : 'requirement-grounded';
      lines.push(`    • ${s.title} — ${s.objective}  (source: ${s.provenance.source}; ${tag})`);
    }
  }

  const rc = plan.requirementCoverage;
  const checklist = rc.steps
    .map((s, i) => `  ${s.covered ? '✓' : '✗'} Step ${i + 1}: ${s.text}`)
    .join('\n');
  const coverageHeader = rc.total > 0
    ? `REQUIREMENT COVERAGE: ${rc.covered}/${rc.total} (${rc.percent}%) — every explicit requirement step below MUST have at least one test case.\n${checklist}\n`
    : '';

  return `
--- DERIVED SCENARIO PLAN (QA Knowledge Engine — category: ${plan.classification.category}, confidence: ${plan.classification.confidence}) ---
These are the business scenarios justified by the explicit Requirement, Acceptance Criteria, App Knowledge and Test Data, plus (when Deep Coverage is on) domain best-practice checks clearly tagged 'deep-coverage'. They were derived deterministically and each cites the evidence that justifies it.

${coverageHeader}
Your job is to write each scenario up as a concrete, grounded test case — NOT to change WHICH scenarios exist:
  • Produce exactly one (or more, if a scenario genuinely needs multiple data variations) test case per planned scenario below.
  • DO NOT invent additional scenarios. If a failure mode / edge case is not listed here, it was not justified — leave it out.
  • DO NOT drop a planned scenario. Every line below is justified and MUST be written up — most importantly, every requirement step above must be covered.
  • Scenarios are already ordered Happy Path → Negative → Boundary → Edge; preserve that order.

PLANNED SCENARIOS (${plan.justifiedCount} justified):
${lines.join('\n')}
--- END SCENARIO PLAN ---`;
}
