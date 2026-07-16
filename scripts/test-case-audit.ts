/**
 * ============================================================================
 * TEST CASE LAB — DIAGNOSTIC HARNESS (Phase 2)
 * ============================================================================
 *
 * Executes the pipeline for each gold-benchmark requirement and dumps, at every
 * stage: INPUT · OUTPUT · NEW INFORMATION ADDED · INFORMATION LOST.
 *
 * It does NOT modify production code. It only *calls* the real production
 * functions so the audit measures the shipping behaviour, not a re-implementation.
 *
 * Stages
 *   1. Requirement Understanding  understandRequirement()   [engine exists, NOT wired to live gen]
 *   2. Validation Planning        planValidations()         [engine exists, NOT wired to live gen]
 *   3. Scenario Planner (LIVE)    planScenarios()           ← the real generation ceiling
 *   4. LLM Prompt (LIVE)          buildScenarioPlanBlock()  ← exactly what the model is told
 *   5. LLM Output                 NOT executed here — no API/DB. The prompt instructs the model
 *                                 to NOT add or drop scenarios, so Stage 3 is the honest ceiling
 *                                 of business coverage. resolveType()'s positive-default is noted.
 *   6. Quality Validator (LIVE)   buildQualityReport()      ← the gate that graded 11/1/0
 *
 * Honesty note: because we do not call the live LLM + DB path, "final output"
 * is approximated by the deterministic Stage-3 plan (the coverage ceiling the
 * LLM is forbidden to exceed). This is reproducible and matches how the live
 * planner behaves; count-origin claims about the LLM stage are labelled as such.
 * ============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';

import { GOLD_BENCHMARKS, GoldBenchmark, GoldValidation } from './gold-benchmarks';
import { understandRequirement } from '../src/requirement-understanding/requirement-understanding-engine';
import { planValidations } from '../src/validation-planning/validation-planner';
import {
  planScenarios,
  buildScenarioPlanBlock,
} from '../src/engines/scenario-planner';
import { classifyQACategory } from '../src/engines/qa-knowledge-engine';
import { buildQualityReport } from '../src/engines/generation-quality-engine';
import type { CoverageType } from '../src/engines/test-coverage-engine';

const OUT_DIR = path.join(__dirname, 'audit-output');

/* ---- coverage-detection helpers ---- */

/** Lowercased searchable text of a set of scenarios/obligations/elements. */
function haystack(parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(' \u0001 ').toLowerCase();
}

/**
 * Coverage detection. A validation is covered when ANY of its match phrases is
 * satisfied. A phrase is satisfied when EVERY significant word in it appears in
 * the haystack — compared on a light stem so "expired token" is recognised in
 * "Expired reset token", "exceeds stock" in "exceeding available stock", etc.
 *
 * This is a uniform, generic algorithm (word-subset containment on stems), NOT
 * per-item keyword tuning: it is applied identically to every benchmark. It
 * fixes false-negatives from naive substring matching WITHOUT moving the sealed
 * expectations toward the generator — a genuinely absent concept still misses.
 */
const MATCH_STOPWORDS = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'is', 'are', 'by', 'with', 'no']);
function stem(w: string): string {
  return w.replace(/(ing|edly|ed|es|s)$/i, '');
}
function significantWords(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !MATCH_STOPWORDS.has(w))
    .map(stem);
}
function hayTokens(hay: string): string[] {
  return hay
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    .map(stem);
}
/** A phrase word is present when a hay TOKEN equals it or begins with it (stemmed),
 *  so "search"→"searchable" and "expired"→"expired" match, but "all" does NOT
 *  match inside "manually" (token-boundary, not raw substring). */
function wordPresent(w: string, toks: string[]): boolean {
  return toks.some((t) => t === w || t.startsWith(w));
}
function phraseSatisfied(phrase: string, toks: string[], rawHay: string): boolean {
  const words = significantWords(phrase);
  if (words.length === 0) return rawHay.includes(phrase); // short tokens like "cvv", "zip"
  return words.every((w) => wordPresent(w, toks));
}
function isCovered(v: GoldValidation, hay: string): boolean {
  const toks = hayTokens(hay);
  return v.match.some((m) => phraseSatisfied(m, toks, hay));
}

/** Concepts present in a haystack, expressed as the gold-validation names it satisfies. */
function coveredNames(expected: GoldValidation[], hay: string): Set<string> {
  const s = new Set<string>();
  for (const v of expected) if (isCovered(v, hay)) s.add(`${v.group} :: ${v.name}`);
  return s;
}

function diff(prev: Set<string>, next: Set<string>): { added: string[]; lost: string[] } {
  const added = [...next].filter((x) => !prev.has(x));
  const lost = [...prev].filter((x) => !next.has(x));
  return { added, lost };
}

interface StageRecord {
  stage: string;
  wired: boolean;
  input: unknown;
  output: unknown;
  newInformationAdded: string[];
  informationLost: string[];
}

interface BenchmarkAudit {
  id: string;
  label: string;
  requirement: unknown;
  classification: { category: string; confidence: number; matchedSignals: string[]; expected: string; correct: boolean };
  stages: StageRecord[];
  gap: {
    mode: string;
    totalExpected: number;
    covered: number;
    missing: number;
    coveragePercent: number;
    criticalMissing: string[];
    rows: { validation: string; weight: string; covered: boolean }[];
  }[];
  earliestLoss: { validation: string; weight: string; lostAtStage: string }[];
}

const MODES: { name: string; coverageTypes: CoverageType[]; deep: boolean }[] = [
  { name: 'default (positive only)', coverageTypes: ['positive'], deep: false },
  {
    name: 'full (all families + deep)',
    coverageTypes: ['positive', 'negative', 'edge_cases', 'boundary', 'security', 'integration', 'role_based'],
    deep: true,
  },
];

function auditBenchmark(b: GoldBenchmark): BenchmarkAudit {
  const expected = b.expected;
  const stages: StageRecord[] = [];

  /* ---------- Stage 1: Requirement Understanding (engine exists, NOT wired) ---------- */
  const model = understandRequirement({ requirement: b.requirement as any });
  const s1Hay = haystack([
    ...model.entities.map((e) => e.name),
    ...model.actions.map((a) => a.name),
    ...model.fields.map((f) => `${f.name} ${f.required ? 'required' : ''}`),
    ...model.businessRules.map((r) => r.statement),
  ]);
  const s1Names = coveredNames(expected, s1Hay);
  stages.push({
    stage: '1. Requirement Understanding',
    wired: false,
    input: b.requirement,
    output: {
      entities: model.entities.map((e) => e.name),
      actions: model.actions.map((a) => a.name),
      fields: model.fields.map((f) => f.name),
      businessRules: model.businessRules.map((r) => r.statement),
      confidence: model.confidence,
    },
    newInformationAdded: [...s1Names],
    informationLost: [],
  });

  /* ---------- Stage 2: Validation Planning (engine exists, NOT wired) ---------- */
  const plan = planValidations(model);
  const s2Hay = haystack([
    ...plan.obligations.map((o) => `${o.concept} ${o.intent} ${o.statement}`),
  ]);
  const s2Names = coveredNames(expected, s2Hay);
  const d2 = diff(s1Names, s2Names);
  stages.push({
    stage: '2. Validation Planning',
    wired: false,
    input: { entities: model.entities.length, fields: model.fields.length, rules: model.businessRules.length },
    output: {
      capability: plan.capability,
      complexity: plan.riskProfile.complexity,
      applicableDimensions: plan.riskProfile.applicableDimensions,
      obligationCount: plan.obligations.length,
      obligations: plan.obligations.map((o) => o.statement),
    },
    newInformationAdded: d2.added,
    informationLost: d2.lost,
  });

  /* ---------- Stage 3-6 run per MODE (default vs full selection) ---------- */
  const cls = classifyQACategory(b.requirement as any);
  const gap: BenchmarkAudit['gap'] = [];
  const earliestLossMap = new Map<string, string>();

  const classificationCorrect = cls.category === b.expectedCategory;
  // hays captured per mode so earliest-loss can reason over the LIVE path.
  let defaultHay = '';
  let fullHay = '';

  MODES.forEach((mode) => {
    const scenarioPlan = planScenarios(b.requirement as any, mode.coverageTypes, undefined, undefined, mode.deep);
    const s3Hay = haystack(scenarioPlan.scenarios.map((s) => `${s.title} ${s.objective} ${s.riskArea ?? ''}`));
    const s3Names = coveredNames(expected, s3Hay);

    const promptBlock = buildScenarioPlanBlock(scenarioPlan);
    const s4Hay = haystack([promptBlock]);
    const s4Names = coveredNames(expected, s4Hay);

    // Quality report on the planned scenarios (as the generator would grade them).
    const quality = buildQualityReport(
      scenarioPlan.scenarios.map((s) => ({
        coverageType: s.coverageType,
        title: s.title,
        objective: s.objective,
      })),
      { selectedTypes: mode.coverageTypes },
    );

    if (mode.name === MODES[0].name) {
      // record stages 3-6 (default mode) into the stage log
      const d3 = diff(s2Names, s3Names);
      stages.push({
        stage: '3. Scenario Planner (LIVE)',
        wired: true,
        input: { category: cls.category, coverageTypes: mode.coverageTypes, deep: mode.deep },
        output: {
          category: scenarioPlan.classification.category,
          plannedCount: scenarioPlan.scenarios.length,
          byType: countBy(scenarioPlan.scenarios.map((s) => s.coverageType)),
          scenarios: scenarioPlan.scenarios.map((s) => s.title),
        },
        newInformationAdded: d3.added,
        // What understanding/validation KNEW but the planner did not emit:
        informationLost: [...new Set([...s1Names, ...s2Names])].filter((x) => !s3Names.has(x)),
      });
      const d4 = diff(s3Names, s4Names);
      stages.push({
        stage: '4. LLM Prompt (LIVE)',
        wired: true,
        input: { plannedScenarios: scenarioPlan.scenarios.length },
        output: { promptChars: promptBlock.length, instructsNoInvent: true, instructsNoDrop: true },
        newInformationAdded: d4.added,
        informationLost: d4.lost,
      });
      stages.push({
        stage: '5. LLM Output (NOT executed)',
        wired: true,
        input: { note: 'no live API/DB in harness' },
        output: {
          note: 'Prompt forbids add/drop, so Stage-3 plan is the coverage ceiling.',
          knownLeak: "resolveType() defaults an unlabelled/lost coverage-type link to 'positive' (test-coverage-engine ~L2399) → inflates positive count.",
        },
        newInformationAdded: [],
        informationLost: [],
      });
      stages.push({
        stage: '6. Quality Validator (LIVE)',
        wired: true,
        input: { casesGraded: scenarioPlan.scenarios.length },
        output: {
          riskScore: quality.risk.score,
          passed: quality.passed,
          byFamily: quality.coverageMix.byFamily,
          missingCategories: quality.missingCategories,
          recommendations: quality.recommendations,
          regenerationGate: "buildQualityReport GRADES balance, but regeneration is behind GEN_QUALITY_REGEN (OFF by default) — measures the imbalance, ships it anyway.",
        },
        newInformationAdded: [],
        informationLost: [],
      });
    }

    // gap table for this mode (final generated = planned scenarios)
    const rows = expected.map((v) => ({
      validation: `${v.group} :: ${v.name}`,
      weight: v.weight,
      covered: isCovered(v, s3Hay),
    }));
    const covered = rows.filter((r) => r.covered).length;
    const criticalMissing = rows.filter((r) => !r.covered && r.weight === 'critical').map((r) => r.validation);
    gap.push({
      mode: mode.name,
      totalExpected: expected.length,
      covered,
      missing: expected.length - covered,
      coveragePercent: Math.round((covered / expected.length) * 100),
      criticalMissing,
      rows,
    });

    if (mode.name === MODES[0].name) defaultHay = s3Hay;
    if (mode.name === MODES[1].name) fullHay = s3Hay;
  });

  // ── EARLIEST LOSS over the LIVE path (classify → KB/planner → coverage selection) ──
  // The requirement-understanding & validation-planning engines are NOT wired to
  // live generation, so they cannot be the "earliest live loss". The live
  // generator's only knowledge source is the KB consulted by the Scenario Planner
  // for the CLASSIFIED category. So a missing validation is lost at one of:
  //   A. Classification — routed to the wrong KB category (right KB never consulted)
  //   B. Scenario Planner / KB depth — right category, but the KB has no such obligation (missing even at full+deep)
  //   C. Coverage selection — KB HAS it, but the default (positive-only) selection never emits it
  for (const v of expected) {
    const key = `${v.group} :: ${v.name}`;
    const inFull = isCovered(v, fullHay);
    const inDefault = isCovered(v, defaultHay);
    if (inDefault) continue; // present in the default live suite → not lost
    if (inFull) {
      earliestLossMap.set(key, 'C. Coverage selection (KB has it; default positive-only never emits it)');
    } else if (!classificationCorrect) {
      earliestLossMap.set(
        key,
        `A. Classification (routed to '${cls.category}', senior QA expects '${b.expectedCategory}' — wrong KB consulted)`,
      );
    } else {
      earliestLossMap.set(key, 'B. Scenario Planner / KB depth (correct category, but no such obligation in the KB)');
    }
  }

  const earliestLoss = [...earliestLossMap.entries()].map(([validation, lostAtStage]) => {
    const v = expected.find((e) => `${e.group} :: ${e.name}` === validation)!;
    return { validation, weight: v.weight, lostAtStage };
  });

  return {
    id: b.id,
    label: b.label,
    requirement: b.requirement,
    classification: { ...cls, expected: b.expectedCategory, correct: classificationCorrect },
    stages,
    gap,
    earliestLoss,
  };
}

function countBy(arr: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const a of arr) m[a] = (m[a] ?? 0) + 1;
  return m;
}

function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const all: BenchmarkAudit[] = [];

  for (const b of GOLD_BENCHMARKS) {
    const audit = auditBenchmark(b);
    all.push(audit);
    fs.writeFileSync(path.join(OUT_DIR, `${b.id}.json`), JSON.stringify(audit, null, 2));
  }
  fs.writeFileSync(path.join(OUT_DIR, `_all.json`), JSON.stringify(all, null, 2));

  // ---- console summary ----
  console.log('\n================= TEST CASE LAB — DIAGNOSTIC HARNESS =================\n');
  for (const a of all) {
    const clsMark = a.classification.correct ? 'OK' : `MISROUTED (expected ${a.classification.expected})`;
    console.log(`\n### ${a.label}  [classified: ${a.classification.category} @ ${a.classification.confidence} — ${clsMark}]`);
    console.log(`    matched signals: ${a.classification.matchedSignals.join(', ') || '(none)'}`);
    for (const g of a.gap) {
      console.log(
        `    ${g.mode.padEnd(28)} coverage ${String(g.covered).padStart(2)}/${g.totalExpected} (${g.coveragePercent}%)  ` +
          `critical-missing: ${g.criticalMissing.length}`,
      );
    }
    // stage flow (default mode)
    console.log('    stage flow (default mode):');
    for (const s of a.stages) {
      const w = s.wired ? '' : '  [NOT WIRED TO LIVE GEN]';
      console.log(`      · ${s.stage}${w}  +${s.newInformationAdded.length} added  -${s.informationLost.length} lost`);
    }
  }

  // ---- aggregate earliest-loss tally ----
  const lossTally: Record<string, number> = {};
  for (const a of all) for (const e of a.earliestLoss) lossTally[e.lostAtStage] = (lossTally[e.lostAtStage] ?? 0) + 1;
  console.log('\n================= EARLIEST-LOSS TALLY (full mode, all benchmarks) =================');
  for (const [stage, n] of Object.entries(lossTally).sort((x, y) => y[1] - x[1])) {
    console.log(`   ${String(n).padStart(3)}  missing validations first lost at → ${stage}`);
  }
  console.log(`\nJSON dumps written to ${OUT_DIR}/`);
}

main();
