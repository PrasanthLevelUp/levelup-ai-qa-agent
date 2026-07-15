# Workspace Context Ownership Model

## Overview
Every artifact created inside LevelUp **auto-inherits the active Workspace Context** — like a Jira Story inheriting its Sprint. Each artifact type persists **only the context dimensions it owns**; children inherit the rest via FK joins (never duplicated down the tree).

This document defines **who owns what**. When you wonder "Why doesn't a Script have its own `sprint_id`?" or "Why is `requirements.environment_id` nullable?", the answer is here.

---

## Ownership Table

| Artifact             | Owns Project | Owns Sprint | Owns Environment | Inherits From    | Notes |
|----------------------|--------------|-------------|------------------|------------------|-------|
| **Requirement** (RTM)| ✅           | ✅          | ❌               | —                | Planning-root; environment-independent (one requirement exercised across QA, UAT, Prod) |
| **Test Requirement** (coverage root) | ✅ | ✅ | ❌ | — | Parent of generated scenarios → test cases; environment-independent |
| **Scenario**         | ❌           | ❌          | ❌               | Test Requirement | No own context columns; filter via `test_requirements` FK join |
| **Test Case**        | ❌           | ❌          | ❌               | Scenario → Test Requirement | No own context columns; filter via `scenario → test_requirements` FK join |
| **Script**           | ✅           | ❌          | ❌               | Requirement (via `requirement_id` link) | Inherits sprint from linked requirement; ad-hoc scripts (URL/repo, no requirement) have NULL sprint |
| **Test Data**        | ✅           | ❌          | ✅               | —                | Environment-specific datasets (QA credentials ≠ UAT credentials); sprint optional (not auto-stamped) |
| **Execution**        | ✅           | ✅          | ✅               | —                | Runtime artifact: "WHERE + WHEN did it run?" |
| **Healing**          | ✅           | ✅          | ✅               | —                | Runtime artifact: "WHERE + WHEN did it heal?" |
| **RCA**              | ✅           | ✅          | ✅               | —                | Runtime artifact: "WHERE + WHEN was it analyzed?" |

---

## Rules

### 1. Planning artifacts are environment-independent
A **Requirement** / **Test Case** / **Script** is a design artifact. It describes *what* to test, not *where* it ran. One requirement is exercised across multiple environments (QA, UAT, Prod) — stamping it with a single `environment_id` would wrongly duplicate it per-env. So:
- `requirements.environment_id` = always NULL (no env trigger, column is back-compat only)
- `test_requirements.environment_id` = does not exist (not in ENV_LINKED_TABLES)
- `generated_scripts.environment_id` = always NULL (no env trigger, column is back-compat only)

### 2. Runtime artifacts own BOTH environment + sprint
An **Execution** / **Healing** / **RCA** answers "WHERE + WHEN did it happen?" They auto-populate both via triggers:
- `environment_id` ← default environment (if not explicitly passed)
- `sprint_id` ← current sprint (if not explicitly passed)

### 3. Children NEVER duplicate context
A **Scenario** / **Test Case** does NOT carry its own `sprint_id` or `environment_id`. Instead:
- The **root** (`test_requirements`) owns `sprint_id`.
- Children filter via JOIN: `FROM generated_test_cases c JOIN generated_test_scenarios s ON c.scenario_id=s.id JOIN test_requirements tr ON s.requirement_id=tr.id WHERE tr.sprint_id=?`

This matches Jira's Epic → Story → Subtask model: moving the Epic to a new Sprint doesn't require rewriting every Subtask row — you change one row (the Epic) and the hierarchy inherits it.

### 4. Test Data is the exception
Unlike planning artifacts, **Test Data** is environment-specific:
- QA credentials ≠ UAT credentials
- QA database seeds ≠ Prod seeds

So `test_data_sets` owns `environment_id` (persisted when created) but NOT `sprint_id` (datasets aren't sprint-scoped; they're long-lived fixtures).

### 5. Ad-hoc Scripts (URL/repo) have no sprint
A Script generated from a **URL** / **repository** / **CSV upload** (without linking to a Requirement) carries:
- `requirement_id` = NULL
- `sprint_id` = NULL (nothing to inherit)

These scripts still work; they're just not sprint-filterable. If you need them sprint-scoped, create a Requirement first and generate from there.

---

## Schema Implementation

### Tables with context columns

**Environment-linked** (`ENV_LINKED_TABLES`):
- `test_executions`, `healing_actions`, `rca_analyses` (runtime)
- `test_data_sets` (env-specific fixtures)

**Sprint-linked** (`SPRINT_LINKED_TABLES`):
- `test_executions`, `healing_actions`, `rca_analyses` (runtime)
- `requirements` (RTM root)
- `test_requirements` (coverage root)

**Back-compat columns** (exist but are NOT auto-stamped):
- `requirements.environment_id` (always NULL)
- `generated_scripts.environment_id` (always NULL)
- `generated_scripts.sprint_id` (always NULL)

These back-compat columns exist so the persistence layer can write explicit NULLs without breaking on a fresh install. They have no trigger — the artifact doesn't own the value.

### Triggers

**Auto-stamp current sprint** (`assign_current_sprint`):
- `test_executions`, `healing_actions`, `rca_analyses` ✅
- `requirements`, `test_requirements` ✅
- `generated_scripts` ❌ (trigger dropped in Sprint 2)

**Auto-stamp default environment** (`assign_default_environment`):
- `test_executions`, `healing_actions`, `rca_analyses` ✅
- `test_data_sets` ✅
- `requirements`, `generated_scripts` ❌ (triggers dropped in Sprint 2)

---

## Code Paths

### Create flows that stamp context

| Flow | Route | DB Function | Stamps |
|------|-------|-------------|--------|
| Manual Requirement | `POST /api/requirements` | `createRequirement()` | `sprint_id` ← context; `environment_id` ← NULL |
| Jira Import | `POST /api/requirements/jira/import` | `createRequirement()` | `sprint_id` ← context; `environment_id` ← NULL |
| Generate Test Cases | `POST /api/test-coverage/generate` | `createTestRequirement()` | `sprint_id` ← context (root); scenarios/cases inherit |
| Generate Script | `POST /api/scripts/generate` | `logGeneratedScript()` | `requirement_id` ← link (inherits sprint); `environment_id` ← NULL, `sprint_id` ← NULL |
| Create Test Data | `POST /api/test-data` | `createTestDataSet()` | `environment_id` ← context; legacy `environment` enum also set |
| Test Execution | `POST /api/executions` | `logTestExecution()` | `environment_id` + `sprint_id` ← trigger (or explicit) |
| Healing | healing worker | `logHealingAction()` | `environment_id` + `sprint_id` ← trigger (or explicit) |
| RCA | healing worker | `logRCAAnalysis()` | `environment_id` + `sprint_id` ← trigger (or explicit) |

---

## Future-Proofing

When adding a **new import source** (Azure DevOps, Linear, etc.) or a **new artifact type**:

1. **Ask:** is this artifact environment-specific or environment-independent?
   - **Independent** (planning): stamp `sprint_id`, leave `environment_id` NULL
   - **Specific** (runtime or data): stamp both `environment_id` + `sprint_id`

2. **Ask:** does this artifact have children?
   - **Yes**: only the ROOT owns context; children reference the root via FK (no own columns)
   - **No**: the artifact owns its own context

3. **Update this table** — document the new artifact's ownership so future maintainers know the rule.

---

## Why This Matters

**Without documented ownership:**
- A new developer sees `requirements.environment_id` is nullable and assumes a bug → "fixes" it by adding a trigger → silently breaks the env-independent design.
- Someone wonders why RTM Coverage dashboard shows duplicates → traces to every test case carrying its own `sprint_id` → realizes the denormalization sync is broken.

**With documented ownership:**
- Grep for "Why doesn't Script have sprint_id?" → lands here → sees "inherits via requirement link" → moves on.
- Adding a new artifact → consults this table → picks the right ownership model from day one.

---

## Related PRs
- **Sprint 1** (context READ/filter): [#305 backend](https://github.com/PrasanthLevelUp/levelup-ai-qa-agent/pull/305), [#156 dashboard](https://github.com/PrasanthLevelUp/levelup-ai-qa-dashboard/pull/156)
- **Sprint 2** (context WRITE/creation): [#306 backend](https://github.com/PrasanthLevelUp/levelup-ai-qa-agent/pull/306), [#157 dashboard](https://github.com/PrasanthLevelUp/levelup-ai-qa-dashboard/pull/157)
