/* eslint-disable no-console */
/**
 * EXECUTION GRAPH COVERAGE — "How much of the product runs from the graph?"
 * =========================================================================
 * NOT a unit test. The OBJECTIVE GATE for Sprint 2D.5 (legacy deletion).
 *
 * Rule 1 of 2D.5: you may only delete an inference once the Execution Graph
 * provably OWNS the behaviour it inferred. This tool turns that judgment call
 * into a number. It reads the SAME authored knowledge base the engine consumes
 * (`QA_KNOWLEDGE_BASE`) and, for every scenario, asks the two questions that
 * decide which code path Script Gen takes at generation time:
 *
 *     graph owns ACTIONS?      →  scenario.actionTemplate?.length > 0
 *     graph owns ASSERTIONS?   →  scenario.assertionTemplate?.length > 0
 *
 * A scenario is GRAPH-OWNED only when BOTH are true — because in
 * `script-gen-engine.ts` the actions[] and assertions[] gates are independent,
 * and a scenario that owns one but not the other STILL drops to legacy
 * inference for the other half. That is the honest bar.
 *
 *   Execution Graph Coverage =  graph-owned scenarios / total scenarios
 *
 * Reported per module and overall. Pending auth scenarios (knowingly not yet
 * authored, blocked on grammar) are listed explicitly so the gap is never
 * silent. 2D.5 (deletion) may begin ONLY when overall coverage is 100%.
 *
 * Run:  npx ts-node tools/measure-graph-coverage.ts
 * Exit: 0 when 100% (gate open), 1 otherwise (gate closed) — CI-friendly.
 */
import {
  QA_KNOWLEDGE_BASE,
  AUTH_SCENARIOS_PENDING_ACTION_TEMPLATE,
  type PlannedScenario,
} from '../src/engines/qa-knowledge-engine';

interface Row {
  module: string;
  total: number;
  owned: number;
  actionsOnly: number;
  assertionsOnly: number;
  neither: number;
  pendingIds: string[];
}

function ownsActions(s: PlannedScenario): boolean {
  return Array.isArray(s.actionTemplate) && s.actionTemplate.length > 0;
}
function ownsAssertions(s: PlannedScenario): boolean {
  return Array.isArray(s.assertionTemplate) && s.assertionTemplate.length > 0;
}

function measure(): Row[] {
  const rows: Row[] = [];
  for (const [module, scenarios] of Object.entries(QA_KNOWLEDGE_BASE)) {
    const row: Row = {
      module,
      total: scenarios.length,
      owned: 0,
      actionsOnly: 0,
      assertionsOnly: 0,
      neither: 0,
      pendingIds: [],
    };
    for (const s of scenarios) {
      const a = ownsActions(s);
      const v = ownsAssertions(s);
      if (a && v) row.owned++;
      else if (a && !v) row.actionsOnly++;
      else if (!a && v) row.assertionsOnly++;
      else row.neither++;
      if (!(a && v)) row.pendingIds.push(s.id);
    }
    rows.push(row);
  }
  return rows;
}

function pct(n: number, d: number): string {
  if (d === 0) return '  n/a';
  return `${((100 * n) / d).toFixed(0).padStart(4)}%`;
}

function bar(n: number, d: number, width = 20): string {
  if (d === 0) return ' '.repeat(width);
  const filled = Math.round((width * n) / d);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function main(): void {
  const rows = measure();
  const totBoth = rows.reduce((s, r) => s + r.owned, 0);
  const totAll = rows.reduce((s, r) => s + r.total, 0);

  console.log('EXECUTION GRAPH COVERAGE — the 2D.5 gate\n' + '='.repeat(72));
  console.log('A scenario is GRAPH-OWNED only when it has BOTH actions[] AND');
  console.log('assertions[]. Anything less still falls back to legacy inference.\n');

  const head =
    'module'.padEnd(16) +
    'owned'.padStart(8) +
    'cover'.padStart(7) +
    '  ' +
    'coverage'.padEnd(20) +
    '   gaps (actions-only / assertions-only / neither)';
  console.log(head);
  console.log('-'.repeat(72));

  // Sort: worst coverage first, so the biggest gaps are at the top.
  rows
    .slice()
    .sort((a, b) => a.owned / (a.total || 1) - b.owned / (b.total || 1))
    .forEach((r) => {
      const gaps = `${r.actionsOnly} / ${r.assertionsOnly} / ${r.neither}`;
      console.log(
        r.module.padEnd(16) +
          `${r.owned}/${r.total}`.padStart(8) +
          pct(r.owned, r.total).padStart(7) +
          '  ' +
          bar(r.owned, r.total) +
          '   ' +
          gaps,
      );
    });

  console.log('-'.repeat(72));
  console.log(
    'OVERALL'.padEnd(16) +
      `${totBoth}/${totAll}`.padStart(8) +
      pct(totBoth, totAll).padStart(7) +
      '  ' +
      bar(totBoth, totAll),
  );

  // Pending auth scenarios — the ones with a KNOWN reason (grammar gap).
  const pendingAuth = Object.keys(AUTH_SCENARIOS_PENDING_ACTION_TEMPLATE);
  if (pendingAuth.length) {
    console.log('\nAuthentication — knowingly pending (blocked on grammar):');
    for (const id of pendingAuth) {
      console.log(`  • ${id}\n      ${AUTH_SCENARIOS_PENDING_ACTION_TEMPLATE[id]}`);
    }
  }

  const open = totBoth === totAll;
  console.log('\n' + '='.repeat(72));
  console.log(
    open
      ? '✅ GATE OPEN — every scenario runs from the graph. 2D.5 (deletion) may begin.'
      : `❌ GATE CLOSED — ${totAll - totBoth}/${totAll} scenarios still need the graph. ` +
          'Do NOT delete legacy inference yet (Rule 1).',
  );
  process.exit(open ? 0 : 1);
}

main();
