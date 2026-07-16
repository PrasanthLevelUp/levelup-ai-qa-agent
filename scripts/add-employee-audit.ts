/**
 * ============================================================================
 * ADD EMPLOYEE AUDIT — generate vs. the gold standard, one requirement, deep
 * ============================================================================
 *
 * Phase 1 tool. It reads the human gold standard (`benchmarks/add-employee-gold.md`),
 * generates what the Test Case Lab produces for the Add Employee requirement TODAY,
 * and reports — per category, worst-priority first — exactly which scenarios a
 * senior QA architect would notice are missing.
 *
 * It is NOT a leaderboard and prints no headline percentage to optimise. The
 * output is a worklist: every ✗ is a capability to trace to its loss stage
 * (knowledge base / planner / prompt / LLM) and fix.
 *
 * Two columns are shown per scenario:
 *   • CEILING  — planner run with every family + deep: the maximum the generator
 *                is permitted to emit. A ✗ here is a genuine KB/planner gap.
 *   • DEFAULT  — the out-of-the-box production run (positive, negative,
 *                edge_cases; deep off). A scenario that is ✓ CEILING but ✗ DEFAULT
 *                is planned but not surfaced by default — a selection/planner issue.
 *
 * The requirement text is imported from the sealed gold-benchmarks (single source
 * of truth); this harness only measures the deep single-requirement gold.
 * ============================================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import { GOLD_BENCHMARKS } from './gold-benchmarks';
import { planScenarios } from '../src/engines/scenario-planner';
import { isCovered } from './coverage-match';
import type { CoverageType } from '../src/engines/test-coverage-engine';

/* -------------------------------------------------------------------------- */
/* Gold parsing                                                               */
/* -------------------------------------------------------------------------- */

type Priority = 'Critical' | 'High' | 'Medium' | 'Low';
const PRIORITY_ORDER: Record<Priority, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

interface GoldScenario {
  category: string;
  id: string;
  name: string;
  priority: Priority;
  grounding: string;
  match: string[];
}

const GOLD_PATH = path.join(__dirname, '..', 'benchmarks', 'add-employee-gold.md');

/** Parse the gold markdown: category from `### N. Name`, scenarios from table rows. */
function parseGold(md: string): GoldScenario[] {
  const out: GoldScenario[] = [];
  let category = '';
  for (const line of md.split('\n')) {
    const head = line.match(/^###\s+\d+\.\s+([^—-]+)/);
    if (head) {
      category = head[1].trim();
      continue;
    }
    // Scenario rows begin with an ID like | FUN-01 | ...
    const row = line.match(/^\|\s*([A-Z]{3}-\d+)\s*\|(.+)\|\s*$/);
    if (!row) continue;
    const cells = row[2].split('|').map((c) => c.trim());
    // cells: [name, priority, grounding, keywords]
    if (cells.length < 4) continue;
    const [name, priority, grounding, kwCell] = cells;
    const match = Array.from(kwCell.matchAll(/`([^`]+)`/g)).map((m) => m[1].toLowerCase());
    if (!match.length) continue;
    out.push({ category, id: row[1], name, priority: priority as Priority, grounding, match });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Generation (the current Test Case Lab output for Add Employee)             */
/* -------------------------------------------------------------------------- */

const ALL_FAMILIES: CoverageType[] = [
  'positive', 'negative', 'edge_cases', 'boundary', 'security', 'integration', 'role_based',
];
const DEFAULT_FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];

function haystacks(types: CoverageType[], deep: boolean): string[] {
  const employee = GOLD_BENCHMARKS.find((b) => b.id === 'employee')!;
  const plan = planScenarios(employee.requirement as any, types, undefined, undefined, deep);
  return plan.scenarios.map((s) =>
    `${s.title} ${s.objective ?? ''} ${(s as any).riskArea ?? ''}`.toLowerCase(),
  );
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

function main(): void {
  const gold = parseGold(fs.readFileSync(GOLD_PATH, 'utf8'));
  const ceiling = haystacks(ALL_FAMILIES, true);
  const def = haystacks(DEFAULT_FAMILIES, false);

  const rows = gold.map((g) => ({
    ...g,
    ceiling: ceiling.some((h) => isCovered(g, h)),
    default: def.some((h) => isCovered(g, h)),
  }));

  console.log('============================================================');
  console.log(' ADD EMPLOYEE — GENERATED vs. GOLD STANDARD');
  console.log('============================================================');
  console.log(' CEILING = planner max (all families + deep). DEFAULT = out-of-box');
  console.log(' (positive, negative, edge_cases). No live LLM/DB in this env, so');
  console.log(' these measure the deterministic KB+planner backbone the LLM cannot');
  console.log(' exceed. ✗ CEILING = KB/planner gap; ✓ CEILING & ✗ DEFAULT = not');
  console.log(' surfaced by default.\n');

  const categories = [...new Set(gold.map((g) => g.category))];
  for (const cat of categories) {
    const items = rows.filter((r) => r.category === cat);
    const covered = items.filter((r) => r.ceiling).length;
    console.log(`\n━━━ ${cat}  (${covered}/${items.length} at ceiling) ━━━`);
    for (const r of items) {
      const c = r.ceiling ? '✓' : '✗';
      const d = r.default ? '✓' : '✗';
      console.log(`  C:${c} D:${d}  [${r.priority.padEnd(8)}] ${r.id}  ${r.name}`);
    }
  }

  // The worklist: everything missing even at the ceiling, worst priority first.
  const missing = rows
    .filter((r) => !r.ceiling)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  const planningGap = rows.filter((r) => r.ceiling && !r.default);

  console.log('\n============================================================');
  console.log(' WORKLIST — missing even at the planner ceiling (fix these)');
  console.log('============================================================');
  if (!missing.length) console.log('  (nothing — the ceiling covers the whole gold standard)');
  for (const m of missing) {
    console.log(`  [${m.priority.padEnd(8)}] ${m.category} :: ${m.id} ${m.name}  (${m.grounding})`);
  }

  console.log('\n--- planned at ceiling but NOT surfaced by default (selection gap) ---');
  if (!planningGap.length) console.log('  (none)');
  for (const p of planningGap) console.log(`  [${p.priority.padEnd(8)}] ${p.id} ${p.name}`);

  const total = rows.length;
  const cov = rows.filter((r) => r.ceiling).length;
  const crit = missing.filter((m) => m.priority === 'Critical').length;
  const high = missing.filter((m) => m.priority === 'High').length;
  console.log('\n------------------------------------------------------------');
  console.log(` Ceiling covers ${cov}/${total} gold scenarios. Missing: ${crit} Critical, ${high} High.`);
  console.log(' (Coverage is a worklist size, not a KPI to game.)');
}

main();
