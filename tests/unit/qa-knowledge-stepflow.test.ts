/**
 * Step-Flow KB contract — the Builder consumes intent, never infers it.
 *
 * These pin the structured `stepFlow` discriminator the Scenario Builder reads
 * to shape a scenario's MANUAL steps when the generic "open → fill → submit"
 * template is wrong for the intent (a cancel must click Cancel; a search must
 * create then find). The invariants:
 *
 *   (1) `getScenarioStepFlow` is a PURE lookup — it returns exactly the authored
 *       value, and `null` when none is authored (never a guessed flow).
 *   (2) The KB authors ONLY the closed set of proven flows ('search' | 'cancel')
 *       — no drift into ad-hoc strings.
 *   (3) The scenarios the Add Employee audit demanded carry the RIGHT flow.
 *   (4) `stepFlow` is NOT an action template — it is deliberately outside the
 *       auth action-template ratchet, so authoring it never touches that gate.
 */

import {
  QA_KNOWLEDGE_BASE,
  getScenarioStepFlow,
  getScenarioActionTemplate,
  type PlannedScenario,
  type ScenarioStepFlow,
} from '../../src/engines/qa-knowledge-engine';

const ALL_SCENARIOS: PlannedScenario[] = Object.values(QA_KNOWLEDGE_BASE).flat();
const LEGAL_FLOWS = new Set<ScenarioStepFlow>(['search', 'cancel']);

describe('Step-Flow KB contract', () => {
  it('(1) getScenarioStepFlow returns the authored value, or null — never a guess', () => {
    const withFlow: PlannedScenario = { id: 'x', title: 't', objective: 'o', coverageType: 'positive', priority: 'P1', riskArea: 'r', stepFlow: 'cancel' };
    const withoutFlow: PlannedScenario = { id: 'y', title: 't', objective: 'o', coverageType: 'positive', priority: 'P1', riskArea: 'r' };
    expect(getScenarioStepFlow(withFlow)).toBe('cancel');
    expect(getScenarioStepFlow(withoutFlow)).toBeNull();
  });

  it('(2) every authored stepFlow is in the closed, proven set', () => {
    for (const s of ALL_SCENARIOS) {
      const flow = getScenarioStepFlow(s);
      if (flow !== null) expect(LEGAL_FLOWS.has(flow)).toBe(true);
    }
  });

  it('(3) the audited CRUD scenarios carry the correct flow', () => {
    const byId = (id: string) => ALL_SCENARIOS.find((s) => s.id === id)!;
    expect(getScenarioStepFlow(byId('crud-pos-cancel-discards'))).toBe('cancel');
    expect(getScenarioStepFlow(byId('crud-pos-searchable'))).toBe('search');
    expect(getScenarioStepFlow(byId('crud-pos-search-partial'))).toBe('search');
    expect(getScenarioStepFlow(byId('crud-pos-search-case-insensitive'))).toBe('search');
  });

  it('(4) stepFlow is a manual-step concern, NOT an action template (ratchet-independent)', () => {
    // A scenario may declare a stepFlow while carrying NO action template — the
    // two surfaces are independent, so the auth action-template ratchet is never
    // implicated by authoring a stepFlow on a CRUD scenario.
    const cancel = ALL_SCENARIOS.find((s) => s.id === 'crud-pos-cancel-discards')!;
    expect(getScenarioStepFlow(cancel)).toBe('cancel');
    expect(getScenarioActionTemplate(cancel)).toBeNull();
  });
});
