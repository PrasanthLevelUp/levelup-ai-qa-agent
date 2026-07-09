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
 * A scenario is derived ONLY from explicit evidence, in this priority order:
 *
 *   1. Acceptance Criteria      (confidence 1.0 — the strongest, explicit spec)
 *   2. Requirement description  (confidence 0.9 / 0.95 for the core happy-path)
 *   3. App Knowledge            (confidence 0.8 — pages/elements/forms crawled)
 *   4. Test Data                (confidence 0.7 — supplied datasets)
 *
 * Coverage Types are a FILTER, never a creator. Selecting "negative" asks
 * "include the negative scenarios that the evidence justifies" — it can never
 * conjure a negative scenario the requirement/AC/app/data never mention. A bare
 * "user can log in" requirement therefore yields ONE scenario (valid login),
 * not a padded list of invented failures. Quality over quantity.
 *
 * Every planned scenario carries its provenance:
 *
 *   { whyExists, source, confidence, derivedFrom }
 *
 * If the planner cannot populate those fields for a scenario, that scenario is
 * NOT planned — it does not exist. This gives explainability, not just a filter.
 *
 * The planner is PURE + synchronous (ZERO LLM tokens).
 */

import type { CoverageType, RequirementInput } from './test-coverage-engine';
import {
  classifyQACategory,
  getBaselineScenarios,
  QA_KNOWLEDGE_VERSION,
  type PlannedScenario,
  type QACategoryClassification,
} from './qa-knowledge-engine';

/** Where a scenario's justification came from (explicit evidence only). */
export type ProvenanceSource =
  | 'Requirement'
  | 'Acceptance Criteria'
  | 'App Knowledge'
  | 'Test Data';

/**
 * Why a scenario exists. This is the planner's contract: a scenario without a
 * populated provenance is never emitted.
 */
export interface ScenarioProvenance {
  /** Human sentence explaining why this scenario was derived. */
  whyExists: string;
  /** The evidence bucket that justified it. */
  source: ProvenanceSource;
  /** Deterministic confidence 0–1 keyed off the evidence bucket. */
  confidence: number;
  /** The exact evidence text (AC clause / requirement / element / dataset). */
  derivedFrom: string;
  /**
   * By construction the planner ONLY emits evidence-backed scenarios, so this is
   * always false. Retained (salvaged from the earlier provenance model) so any
   * future inferred scenario could be flagged honestly instead of silently.
   */
  assumption: boolean;
}

/** A planned scenario annotated with the provenance that justifies it. */
export interface PlannedScenarioWithProvenance extends PlannedScenario {
  provenance: ScenarioProvenance;
}

export interface ScenarioPlan {
  /** Detected QA category + confidence + the signals that drove it. */
  classification: QACategoryClassification;
  /** The justified scenarios (filtered to the user's selected coverage types). */
  scenarios: PlannedScenarioWithProvenance[];
  /** Count of justified scenarios (== scenarios.length; all are evidence-backed). */
  justifiedCount: number;
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

/** Confidence per evidence bucket (deterministic). */
const CONFIDENCE = {
  acceptanceCriteria: 1.0,
  requirementCore: 0.95,
  requirement: 0.9,
  appKnowledge: 0.8,
  testData: 0.7,
} as const;

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

interface Evidence {
  requirementText: string;
  requirementLabel: string;
  acceptanceClauses: string[];
  appKnowledge: string;
  testData: string;
}

function buildEvidence(
  input: Pick<RequirementInput, 'title' | 'description' | 'module' | 'businessFlow' | 'acceptanceCriteria'>,
  knowledge?: PlannerKnowledge,
): Evidence {
  return {
    requirementText: lc([input.title, input.description, input.module, input.businessFlow].filter(Boolean).join(' ')),
    requirementLabel: cap((input.title || input.description || 'the requirement').trim()),
    acceptanceClauses: splitAcceptanceClauses(input.acceptanceCriteria),
    appKnowledge: appKnowledgeText(knowledge),
    testData: testDataText(knowledge),
  };
}

/** First keyword that appears in `haystack`, else null. */
function firstHit(haystack: string, keywords: string[]): string | null {
  for (const k of keywords) if (k && haystack.includes(k)) return k;
  return null;
}

/**
 * Derive the provenance for a baseline scenario, or null if the evidence does
 * not justify it (⇒ the scenario is not planned). This is where "no invention"
 * is enforced — a non-core scenario with no evidence match simply does not exist.
 */
function deriveProvenance(scenario: PlannedScenario, ev: Evidence): ScenarioProvenance | null {
  // The core happy-path is the requirement itself — always justified by it.
  if (scenario.core) {
    return {
      whyExists: 'Primary happy-path stated by the requirement',
      source: 'Requirement',
      confidence: CONFIDENCE.requirementCore,
      derivedFrom: ev.requirementLabel,
      assumption: false,
    };
  }

  const keywords = (scenario.conditionalOnKeywords || []).map(lc).filter(Boolean);
  // Without a recognition vocabulary a non-core scenario cannot be tied to
  // evidence, so it is never planned (coverage type alone never creates it).
  if (!keywords.length) return null;

  // 1. Acceptance Criteria — cite the specific clause.
  for (const clause of ev.acceptanceClauses) {
    const hit = firstHit(lc(clause), keywords);
    if (hit) return {
      whyExists: `Acceptance criteria specify "${hit}"`,
      source: 'Acceptance Criteria',
      confidence: CONFIDENCE.acceptanceCriteria,
      derivedFrom: cap(clause),
      assumption: false,
    };
  }
  // 2. Requirement description.
  const rq = firstHit(ev.requirementText, keywords);
  if (rq) return {
    whyExists: `Requirement mentions "${rq}"`,
    source: 'Requirement',
    confidence: CONFIDENCE.requirement,
    derivedFrom: ev.requirementLabel,
    assumption: false,
  };
  // 3. App Knowledge.
  const ak = firstHit(ev.appKnowledge, keywords);
  if (ak) return {
    whyExists: `App knowledge references "${ak}"`,
    source: 'App Knowledge',
    confidence: CONFIDENCE.appKnowledge,
    derivedFrom: `App knowledge references "${ak}"`,
    assumption: false,
  };
  // 4. Test Data.
  const td = firstHit(ev.testData, keywords);
  if (td) return {
    whyExists: `Supplied test data references "${td}"`,
    source: 'Test Data',
    confidence: CONFIDENCE.testData,
    derivedFrom: `Test data references "${td}"`,
    assumption: false,
  };

  // Nothing explicit justifies it → it does not exist.
  return null;
}

/**
 * Build a deterministic scenario plan for a requirement.
 *
 * @param input          The requirement.
 * @param coverageTypes  The user's SELECTED coverage types (a FILTER — we only
 *                       keep justified scenarios whose type the user picked).
 * @param featureTypeHint Optional upstream analysis featureType hint.
 * @param knowledge      Optional App Knowledge / Test Data — additional evidence
 *                       the planner may derive scenarios from.
 */
export function planScenarios(
  input: Pick<RequirementInput, 'title' | 'description' | 'module' | 'businessFlow' | 'acceptanceCriteria'>,
  coverageTypes: CoverageType[],
  featureTypeHint?: string,
  knowledge?: PlannerKnowledge,
): ScenarioPlan {
  const classification = classifyQACategory(input, featureTypeHint);
  const baseline = getBaselineScenarios(classification.category);

  // Respect the user's coverage selection: never keep a scenario for a type the
  // user did not select. If nothing is selected, fall back to positive so a plan
  // can still form (matches the engine's own default).
  const selected = new Set<CoverageType>(coverageTypes.length ? coverageTypes : ['positive']);

  const evidence = buildEvidence(input, knowledge);

  // Derive ONLY the scenarios explicit evidence justifies. Coverage type filters;
  // provenance decides existence.
  const scenarios: PlannedScenarioWithProvenance[] = [];
  for (const s of baseline) {
    if (!selected.has(s.coverageType)) continue;
    const provenance = deriveProvenance(s, evidence);
    if (!provenance) continue; // unjustified → not planned (no invention)
    scenarios.push({ ...s, provenance });
  }

  return {
    classification,
    scenarios,
    justifiedCount: scenarios.length,
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

  // Group by coverage type for a clean, senior-QA-style checklist.
  const byType = new Map<CoverageType, PlannedScenarioWithProvenance[]>();
  for (const s of plan.scenarios) {
    const arr = byType.get(s.coverageType) || [];
    arr.push(s);
    byType.set(s.coverageType, arr);
  }

  const lines: string[] = [];
  for (const [type, items] of byType) {
    lines.push(`  [${type}]`);
    for (const s of items) {
      lines.push(`    • ${s.title} — ${s.objective}  (source: ${s.provenance.source})`);
    }
  }

  return `
--- DERIVED SCENARIO PLAN (QA Knowledge Engine — category: ${plan.classification.category}, confidence: ${plan.classification.confidence}) ---
These are the ONLY business scenarios justified by the explicit Requirement, Acceptance Criteria, App Knowledge and Test Data. They were derived deterministically and each cites the evidence that justifies it.

Your job is to write each scenario up as a concrete, grounded test case — NOT to change WHICH scenarios exist:
  • Produce exactly one (or more, if a scenario genuinely needs multiple data variations) test case per planned scenario below.
  • DO NOT invent additional scenarios. If a failure mode / edge case is not listed here, the evidence did not justify it — leave it out.
  • DO NOT drop a planned scenario. Every line below is justified and must be written up.

PLANNED SCENARIOS (${plan.justifiedCount} justified):
${lines.join('\n')}
--- END SCENARIO PLAN ---`;
}
