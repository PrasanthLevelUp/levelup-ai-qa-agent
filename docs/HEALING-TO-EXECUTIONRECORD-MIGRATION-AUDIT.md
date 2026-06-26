# Healing → ExecutionRecord Migration Audit & Plan

**Status:** Audit / planning only — **no code in this deliverable.**
**Goal:** Make `ExecutionRecord` the single canonical source so that **Healing becomes a
filtered Execution view** (with extra Learning/RCA panels), and prove this can happen with
**zero feature regression** before we write any migration code.

**Scope of audit:** the three overlapping screens — `Jobs` (`/jobs`), `Healings`
(`/healings`, `/healings/[id]`), `Executions` (`/executions`, `/executions/[id]`) — and
their backend data sources.

---

## 0. TL;DR — the one finding that shapes everything

> **Today `ExecutionRecord` is written ONLY for failing tests inside the heal loop.
> Passing tests, and the "already-fixed-by-prior-heal" pre-check path, never get an
> ExecutionRecord. There is also no `running` state in the record.**

That means the slogan *"Executions = every run (pass / fail / running)"* is **not yet true**
in the data. Before Healing can become a *filtered* view of Executions, the **worker must
emit one ExecutionRecord per test — including passes** (and ideally an early "running"
record). This is **infrastructure plumbing, not new intelligence**, and it is the gating
prerequisite for the whole migration.

Everything else (field coverage, obsolete tables) is solvable. This one is the real work.

---

## 1. Data sources as they exist today

| Concept | Table | Written by | Contains |
|---|---|---|---|
| **Job / run** (orchestration) | `healing_jobs` | job queue + worker | repo, branch, commit, queue status (`pending/running/completed/failed/cancelled`), `progress` text, aggregate `result` JSON (totals, healingActions, healingTrails) |
| **Per-test execution (legacy)** | `test_executions` | `logExecution()` — worker `server.ts:748` (healed pre-check) & `server.ts:785` (failed) | test_name, status, error_message, screenshot_path, commit, duration, healing_attempted/succeeded, company/project/env/sprint |
| **Per-heal action (legacy)** | `healing_actions` | `logHealing()` — 5 call sites in `server.ts` + `healing-orchestrator.ts:1493` | failed/healed locator, strategy, ai_tokens_used, success, confidence, validation_status/reason, patch_path, **decision_trail JSON**, target_file/line, page-object impact, company/project/env/sprint |
| **Canonical record (new)** | `execution_records` | `saveExecutionRecord()` — worker `server.ts:1750` **(failing tests only)** | full `ExecutionRecord` JSONB: artifacts, observations, diagnosis, healing, validation, learning + scope columns |

### Backend endpoints

| Endpoint | Reads from | Used by |
|---|---|---|
| `GET /api/dashboard/jobs`, `/jobs/:jobId` | `healing_jobs` | `/jobs` screen |
| `GET /api/dashboard/healings/recent`, `/healings/:id` | `healing_actions` ⨝ `test_executions` | `/healings` list + detail |
| `GET /api/dashboard/executions`, `/executions/:id` | `execution_records` | `/executions` list + detail |
| `GET /api/execution-records`, `/:id` | `execution_records` | **orphaned** — no frontend consumer (dashboard uses the `/api/dashboard/*` pair) |

> **Duplication #1 (backend):** `/api/execution-records/*` and `/api/dashboard/executions/*`
> serve the *same* records from the *same* accessors. One should be retired. The dashboard
> only calls `/api/dashboard/executions/*`, so `/api/execution-records/*` is the redundant one.

---

## 2. The three screens are NOT the same concept

A critical clarification that the audit makes concrete:

```
Jobs        = the RUN / orchestration   (repo, branch, queue, live progress, cancel)   ← healing_jobs
Executions  = per-TEST lifecycle record (timeline, evidence, diagnosis, healing…)      ← execution_records
Healing     = a FILTERED slice of Executions (only tests where a heal was attempted)   ← should also be execution_records
```

- **Jobs is a different domain** (a job runs *many* tests). `ExecutionRecord` is per-test and
  cannot represent repo/branch/queue/progress/cancel. **➜ Jobs should NOT be folded into
  ExecutionRecord.** It can be renamed/repositioned (e.g. "Runs") but it stays job-scoped.
- **Healing IS the same domain as Executions** (per-test). **➜ Healing should become a
  filtered Executions view**, exactly as proposed.

So the target navigation is:

```
Testing
 ├── Scripts
 ├── Executions   ← every test execution (pass/fail/running) + timeline + evidence
 ├── Healing      ← filtered Executions where healing happened + Learning / RCA / patch history
 └── Release Signoff
(Runs/Jobs)        ← orchestration trigger + live job progress (kept, separate concern)
```

---

## 3. Field-by-field coverage: can ExecutionRecord feed the Healing screens?

### 3a. Healings **list** (`/healings`) — `healing_actions` ⨝ `test_executions`

| UI field | Legacy source | In ExecutionRecord? | Notes / gap |
|---|---|---|---|
| `id` (links to `/healings/{id}`) | `healing_actions.id` (int) | ⚠️ key change | Record is keyed by `executionId` (string). Bridge: `healing_actions.test_execution_id = test_executions.id = record.executionId`. Detail route must move to `executionId`. |
| `testName` | `ha.test_name` | ✅ `record.testName` | |
| `repository` | `te.test_name` (mislabeled today) | ❌ | Record has **no repository field**. Comes from the job (`healing_jobs.repository_url`). Add `repository` to record OR join via job. |
| `failedLocator` | `ha.failed_locator` | ✅ `healing.brokenLocator` | |
| `healedLocator` | `ha.healed_locator` | ✅ `healing.newLocator` | |
| `status` healed/failed | `ha.success` | ✅ `validation.passedAfterHealing` / `healing.appliedStrategy` | |
| `strategy` | `ha.healing_strategy` | ✅ `healing.appliedStrategy` / `healing.source` | |
| `confidence` | `ha.confidence` (the *heal* confidence) | ⚠️ partial | Record stores `diagnosis.confidence`, **not** a per-applied-fix heal confidence. **Gap — add `healing.confidence`.** |
| `tokensUsed` | `ha.ai_tokens_used` | ❌ **missing** | **No token field anywhere in ExecutionRecord.** |
| `cost` | derived from tokens | ❌ **missing** | Same gap. Cost/tokens drive the list's "AI vs Deterministic / Token Cost" cards. |
| `validationStatus` | `ha.validation_status` | ✅ `validation.notes` (partial) | |
| `timestamp` | `ha.created_at` | ✅ `record.startTime/endTime` | |

### 3b. Healings **detail** (`/healings/[id]`)

| UI field | Legacy source | In ExecutionRecord? | Notes / gap |
|---|---|---|---|
| Header testName / repository / status / strategy / timestamp / duration | `ha` + `te.duration_ms` | ✅ mostly | `repository` gap as above; `durationMs` ✅. |
| **Confidence breakdown** (syntax/semantic/exists/unique/visible/interactable/security) | **synthesized in backend** from `success`+`confidence` (NOT stored) | ✅ re-synthesizable | Not a stored dependency — can be reproduced from record (or from `observations.locatorState`, which is *better* real data). |
| **Code changes** before → after | derived from `failed/healed_locator` | ✅ from `healing.brokenLocator/newLocator` | |
| `validationReason` | `ha.validation_reason` | ✅ `validation.notes[]` | |
| **Cost impact** (tokens, cost, strategy desc) | `ha.ai_tokens_used` | ❌ **missing** (tokens/cost) | Same token/cost gap. |
| **Apply & Create PR** | uses `healingId` → `/api/healings/{id}/create-pr` | ⚠️ rewire | PR creation is keyed by `healing_actions.id`. Must accept `executionId` (or keep a heal-id lookup during transition). |

### 3c. Jobs (`/jobs`) — for completeness (stays on `healing_jobs`)

The Jobs "3-Layer Healing Trail" panel renders `healingTrails` + per-action `decision_trail`
(per-layer `hit/miss/confidence/reasoning`) from `healing_jobs.result` JSON. The record's
`healing.attemptedStrategies` (names only) + `candidatesConsidered` + `rationale` is **coarser**
than `decision_trail`. If we ever want the full trail on the Execution/Healing page, we must
enrich `HealingDecisionRecord` with the structured per-layer trail. (Not required to migrate
Healing's *list/detail*, but noted.)

---

## 4. Gaps that MUST be closed before migration (no-regression checklist)

| # | Gap | Severity | Fix (infrastructure, not new intelligence) |
|---|---|---|---|
| **G1** | **ExecutionRecord written for failing tests only** — no passes, no pre-check-healed, no `running` | 🔴 blocker | Worker emits one record per test (pass & fail); optionally an early `running` record updated on finish. Add `'running'` to status union. |
| **G2** | **No `tokensUsed` / `cost`** in record | 🔴 blocker | Add `costTokens` / `costUsd` (or a `cost` block) to `HealingDecisionRecord`; populate from the same value `logHealing` uses. |
| **G3** | **No per-heal `confidence`** in record | 🟠 | Add `healing.confidence` (distinct from `diagnosis.confidence`). |
| **G4** | **No `repository`** in record | 🟠 | Add `repository` (+ branch/commit) to record from job context. |
| **G5** | **Detail keyed by `healing_actions.id`**, record keyed by `executionId` | 🟠 | Move `/healings/[id]` → execution-id routing; keep a transitional id→executionId resolver. |
| **G6** | `decision_trail` richer than record's strategy list | 🟡 (Jobs only) | Optional: add structured `healing.decisionTrail[]` if we want the 3-layer panel on Executions. |
| **G7** | Backend endpoint duplication (`/api/execution-records` vs `/api/dashboard/executions`) | 🟡 | Retire the orphaned `/api/execution-records/*` router. |

**Rule:** none of these add intelligence — they make the record *carry the facts the legacy
tables already carry*. Migration proceeds only once G1–G5 are done and verified.

---

## 5. Which legacy tables/APIs become obsolete (and which stay)

| Asset | After migration | Why |
|---|---|---|
| `execution_records` | ✅ **canonical, central** | single source of truth |
| `test_executions` | ⚠️ **demote, keep during transition** | still feeds older stats/metrics queries (`stats/overview` etc.) and is the source of the `executionId`. Retire only after analytics also read the record. |
| `healing_actions` | ⚠️ **demote, keep during transition** | still feeds learning loops (`recordSelectorBreak`), PR creation, and several analytics. Becomes a *write-through projection* of the record's healing section, then retired. |
| `healing_jobs` | ✅ **keep** | orchestration domain; not replaced by the record |
| `GET /api/dashboard/healings/*` | 🔄 **reimplement on records** | same response shape, sourced from `execution_records` filtered to `healing IS NOT NULL` |
| `GET /api/execution-records/*` | ❌ **retire** | duplicate of `/api/dashboard/executions/*` |
| `GET /api/dashboard/jobs/*` | ✅ **keep** | orchestration |

> **Anti-goal explicitly avoided:** we must NOT end up running *two parallel execution
> systems*. The plan therefore demotes the legacy tables to transitional/projection roles with
> a clear retirement gate, rather than leaving them as a second source of truth.

---

## 6. Phased migration plan (each phase independently reviewable, no regression)

**Phase 0 — (this document).** Audit + mapping + no-regression checklist. ✅

**Phase 1 — Make the record complete (backend only, additive).**
- Close G1–G4: worker emits a record for **every** test (pass/fail), add `running` status,
  add `healing.confidence`, `cost/tokens`, `repository`. Bump `EXECUTION_RECORD_SCHEMA_VERSION`.
- No UI change yet. Verify: every test in a job produces a record; counts match
  `healing_jobs.result` totals (passed/failed/healed). **Proof = parity test** comparing
  record-derived stats vs legacy `test_executions` stats for the same job.

**Phase 2 — Reimplement Healing endpoints on records (backend), shape-compatible.**
- New `healings/recent` + `healings/:id` read `execution_records WHERE healing present`,
  returning the **exact same JSON shape** the current UI expects. Keep legacy endpoints behind
  a flag for A/B verification. Close G5 (id routing) + G7 (retire orphan router).

**Phase 3 — Navigation + Healing as a filtered Executions view (frontend).**
- Healing page becomes a filter over the Executions data source (status filter =
  `healed / failed-with-heal-attempt`) plus the existing Learning/RCA/patch panels.
- Reposition nav: `Scripts · Executions · Healing · Release Signoff`; keep Runs/Jobs separate.

**Phase 4 — Demote legacy tables.**
- Point remaining analytics/stats at the record; convert `healing_actions`/`test_executions`
  writes to projections; schedule retirement once nothing reads them.

**Then (per your order): Replay → Dashboard Summary**, both trivial once every run is a record.

---

## 7. What we are explicitly NOT doing

Knowledge Graph · more advisors · more AI models · more similarity engines · more healing
intelligence. The bottleneck is **experience**, not intelligence. This migration strengthens
architecture (one source of truth) **without** adding complexity.
