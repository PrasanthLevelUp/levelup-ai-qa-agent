# Intelligence Roadmap (revised per final review)

This supersedes the "Coverage Intelligence as master orchestrator" idea. Per the
final review, **Coverage Intelligence is deferred and demoted to a pure consumer**.
The **Intelligence Orchestrator remains the central brain** that every feature uses.

> Architecture principle: **Rule-first → Intelligence-first → AI-last.**
> Coverage *observes*, it never *controls*.

```
                 Intelligence Orchestrator  (the brain)
   Repository · Knowledge · Patterns · Similarity · App Profile · Test Data · DOM
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                      ▼
   Test Case Lab          Script Gen             Healing
        │                     │                      │
        └──────────── Execution ─────────────────────┘
                              │
                              ▼
                     Coverage (consumer only, DEFERRED)
```

## Phases (each = backend + frontend, shipped incrementally)

| Phase | Scope | Status |
|---|---|---|
| **1** | **Intelligence Score** in the orchestrator (signature "grounded vs AI" metric) | ✅ Done (backend) |
| **2** | Migrate **Test Case Lab** onto the orchestrator; expose `intelligenceScore` in `/generate` response | ⏳ Next |
| **3** | Migrate **Healing** onto the orchestrator (evidence output + adapter) | ⏳ |
| **4** | **Requirement Intelligence** + **Intent Intelligence** layers feeding the orchestrator | ⏳ |
| **5** | **Frontend**: Intelligence Score UI across Script Gen, Test Case Lab, Healing | ⏳ |
| — | Coverage Intelligence dashboards / snapshots / trends / heatmaps / alerts / risk scoring | ❌ Deferred |

## What each phase delivers

### Phase 1 — Intelligence Score (this PR)
- New `IntelligenceScore` type on `OrchestratedIntelligence.metadata.intelligenceScore`:
  `{ grounded, aiContribution, bySource, summary }`.
- `IntelligenceOrchestrator.computeIntelligenceScore()` — pure, deterministic,
  reusable by API + prompt block + dashboard.
- Rendered into the prompt block ("Intelligence Score: 94% grounded / 6% AI-generated").
- Summary one-liner ready for UI: *"94% grounded in repository intelligence. Only 6% AI-generated."*
- Fully additive — no behaviour change when the orchestrator flag is off.

### Phase 2 — Test Case Lab migration
- `TestCoverageEngine.buildOrchestratedIntelligenceBlock()` (mirrors Script Gen).
- Sources: `['repository','appProfile','testData','knowledge','patterns']`.
- Skip legacy flat blocks when the orchestrated block is present (no double-injection).
- Return `intelligenceScore` in the `/api/test-coverage/generate` response.

### Phase 3 — Healing migration
- Orchestrator gains method-index + RAG retrieval and an `evidence` output.
- `HealingIntelligenceContext` becomes a thin adapter over the orchestrator,
  preserving the `promptBlock` + confidence-boost `evidence` contract.

### Phase 4 — Requirement + Intent Intelligence
- **Requirement Intelligence**: extract entities, workflows, actors, validations,
  dependencies, business rules *before* AI.
- **Intent Intelligence**: expand a requirement into intents (e.g. Login →
  Authentication / Positive / Negative / Boundary / Session / Security) so the
  repository search is intent-scoped and sharper.

### Phase 5 — Frontend (dashboard repo)
- Intelligence Score badge/panel on generation results for all three features.
- Per-source breakdown bars; headline "% grounded / % AI-generated".
