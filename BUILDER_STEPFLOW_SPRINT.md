# Sprint — Fix Builder Semantic Loss (SEARCH + CANCEL)

**Discipline:** Generate → audit like a Senior QA → fix ONE defect → regenerate → prove. No new engines, no framework, no planner/builder redesign. Two strategies only: **SEARCH** and **CANCEL**.

---

## Phase 1 — Audit (why did the Builder emit generic steps?)

Generated Add Employee (39 scenarios) and inspected the three intent-carrying CRUD scenarios. **Every one produced byte-identical steps**, contradicting its own title:

| Scenario | Title says | Steps it emitted (BEFORE) |
|---|---|---|
| `crud-pos-cancel-discards` | Cancel discards input, nothing saved | Open → fill 3 fields → **Click Save** |
| `crud-pos-searchable` | Created record is searchable | Open → fill 3 fields → **Click Save** |
| `crud-pos-search-partial` | Partial-name search returns record | Open → fill 3 fields → **Click Save** |

The cancel case literally **clicked Save** — the opposite of its intent. All three shared one Expected: *"The action succeeds and the user reaches the expected next state."*

**Evidence — what the planner actually carries.** Printing every own-property of these scenarios showed the intent lives ONLY in free text (`id`, `title`, `objective`); the structured-intent fields were all `undefined`:

```
semantics : undefined   actionTemplate : undefined
assertionTemplate : undefined   obligation : undefined

Own-property key set across ALL crud scenarios:
conditionalOnKeywords, core, coverageType, id, objective,
priority, provenance, riskArea, title
```

## Phase 2 — Root cause (file / function / line)

`src/engines/scenario-builder.ts` → `buildDraftTestCases` → the `plan.scenarios.forEach` loop (orig. lines 640–669).

The tail was **one unconditional template** for every scenario in every category:
- push `"Open the page…"`,
- loop `form.fields` → `"Enter {data} in the {label} field"`,
- push `"Click {submitLabel}"`.

There was **no branch on intent at all** — only the *data phrase* varied, never the *step shape*. So a cancel, a search and a plain create were structurally the same case.

**Decision — Outcome B.** The intent was NOT in a structured field the builder ignored (that would be A). It existed only in title/objective text. Fix per the founder's constraint: **extend the planner by ONE structured field; the Builder consumes it and never infers intent itself.**

## Phase 3 — Implementation (ONE field, TWO flows)

**`src/engines/qa-knowledge-engine.ts`**
- New closed discriminator `export type ScenarioStepFlow = 'search' | 'cancel';` and optional `stepFlow?` on `PlannedScenario`. Deliberately **separate from `actionTemplate`** (that is script-gen grammar, frozen behind the auth ratchet) — `stepFlow` is the manual step shape a human QA reads, so it is not implicated by that ratchet.
- Pure lookup `getScenarioStepFlow(scenario)` → authored value or `null`. Never a guess.
- Authored `stepFlow: 'cancel'` on `crud-pos-cancel-discards`; `stepFlow: 'search'` on `crud-pos-searchable`, `crud-pos-search-partial`, `crud-pos-search-case-insensitive`.

**`src/engines/scenario-builder.ts`**
- After the common create prefix (open + fill every field), the Builder reads `getScenarioStepFlow(scenario)` and **dispatches** on it — it never reads the title:
  - **cancel** → `Click the Cancel button` → `Return to the list and confirm the record was NOT created`.
  - **search** → submit → `Open the records list / search page` → `Search for the newly created record` → `Confirm the record appears in the search results`.
  - **no flow** → unchanged plain-create submit (purely additive).
- `buildExpected` takes the same declared flow so title, steps and Expected all agree. New steps stay **page-level grounded** — no fabricated Cancel/search selectors.

## Phase 4 — Regenerate & prove (same audit, before → after)

**CANCEL — `crud-pos-cancel-discards`**
```
BEFORE                                AFTER
1 Open the page under test            1 Open the page under test
2 Enter valid First Name…             2 Enter valid First Name…
3 Enter valid Last Name…              3 Enter valid Last Name…
4 Enter valid Employee ID…            4 Enter valid Employee ID…
5 Click the Save button        →      5 Click the Cancel button
                                      6 Return to the list and confirm the
                                        record was NOT created (data discarded)
Expected: "The action succeeds…"  →   Expected: "No record is created: the form is
                                      discarded… not persisted… does not appear in
                                      the list afterwards."
```

**SEARCH — `crud-pos-searchable` (and `crud-pos-search-partial`)**
```
BEFORE                                AFTER
1 Open the page under test            1 Open the page under test
2 Enter valid First Name…             2 Enter valid First Name…
3 Enter valid Last Name…              3 Enter valid Last Name…
4 Enter valid Employee ID…            4 Enter valid Employee ID…
5 Click the Save button        →      5 Click the Save button
                                      6 Open the records list / search page
                                      7 Search for the newly created record
                                        (by identifier and by name)
                                      8 Confirm the record appears in the results
Expected: "The action succeeds…"  →   Expected: "The newly created record is returned
                                      in the search results — found by identifier and
                                      by name — confirming it was persisted and is
                                      immediately discoverable (no reindex delay)."
```

**Cancel mismatch → FIXED. Search mismatch → FIXED.**

## Validation

- `npx tsc --noEmit` — clean.
- New tests: `tests/unit/qa-knowledge-stepflow.test.ts` (4, KB contract) + Rule 4 block in `scenario-correctness.test.ts` (12, end-to-end steps/expected). All pass.
- 154/154 across the 7 scenario/knowledge suites; no new regressions. (The one pre-existing `qa-knowledge-actions-invariant` failure about `auth-reset-*` scenarios exists on the clean tree too and is out of this sprint's scope.)

## Scope honored

One structured field, two flows, dispatch-only Builder. No new engine, no ScenarioIntent framework, no planner/builder redesign. Undeclared scenarios are untouched.
