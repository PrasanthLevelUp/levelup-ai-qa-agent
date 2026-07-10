# Sprint 2D Intelligence Removal Checklist

**Goal:** Transform Script Generation from "intelligent planner" → "deterministic adapter"

**Definition of Done:** If I completely remove the original requirement text, Script Generation still produces the same Playwright script because everything it needs already exists in the Scenario Graph.

---

## 🎯 Current State (Post-2D.1)

✅ **Sprint 2D.1 Complete**
- Script Gen now consumes `ScenarioSemantics` when available
- Stable `scenarioId`-based matching (no more title fragility)
- Credentials derived from `variableUnderTest` + `variation` (bypassing ScenarioIntelligence for graph-backed cases)
- 4/4 unit tests passing

**BUT:** ScenarioIntelligence still exists, and Script Gen still has ~1000+ lines of embedded business logic for non-graph cases.

---

## 📋 Remaining Duplicate Intelligence (by Sprint)

### **Sprint 2D.2: Consume `execution.resolvedDataset` ⭐⭐⭐⭐⭐**

**Current Problem:** Script Gen still extracts credential values from step text and dataset names.

**What to Remove:**
- [ ] `extractCredentialsFromSteps()` in `script-gen-engine.ts` (~L2055-2085)
- [ ] Dataset name parsing: `'users'.split('.')[0]` logic
- [ ] Regex-based credential extraction from step descriptions
- [ ] `looksLikeCredential()` heuristic (L2065-2072)
- [ ] Special character literal extraction from steps (used in `scenario-intelligence/detection.ts:32`)

**What to Add:**
- [ ] Read username/password directly from `execution.resolvedDataset` on ScenarioNode
- [ ] Fallback: if no resolvedDataset, use empty strings or skip credential steps entirely (don't infer)

**Target Files:**
- `src/script-gen/script-gen-engine.ts` (credential derivation)
- `src/script-gen/scenario-intelligence/detection.ts` (`extractSpecialCharLiteral`)

**Test Coverage:**
- [ ] Unit test: Script Gen reads `resolvedDataset.username` + `resolvedDataset.password` from graph
- [ ] Unit test: No dataset → no credential fills (graceful degradation)

---

### **Sprint 2D.3: Deterministic Action Mapping ⭐⭐⭐⭐**

**Current Problem:** Script Gen uses regex to detect "login triad", "checkout flow", etc. and rewrites them.

**What to Remove:**
- [ ] **Login triad detection** (L3395-3577 in `script-gen-engine.ts`)
  - Regex: `/user-?name|username|login.*input/i`, `/password|\bpwd\b|\bpass\b/i`
  - Conditional: `if (loginMethod && userFillLine && passFillLine && hasLoginClick)`
  - Entire login PO replacement logic
- [ ] **Checkout detection** (L3610 in `script-gen-engine.ts`)
  - Regex: `/(checkout|#finish|#continue|place.?order|finish)/i`
  - Same pattern in `page-object-rewriter.ts:304`
- [ ] **Flow bucketing** (`inferFlowBucket()` L1880-1910)
  - Auth regex: `/\blog ?in\b|\bsign ?in\b|\blogin\b|credential|username|password/`
  - Returns `{key: 'login', label: 'Login'}` based on text matching
- [ ] **Action grounding by semantic regex** (L4094-4138)
  - Username field: `/user( ?name)?|email|login id/.test(t)`
  - Password field detection
  - Click login button: `/click.*(login|log in|sign in|submit)/`

**What to Replace With:**
- [ ] Read `step.action` from Scenario Graph (e.g., `{type: 'fill', target: 'username', value: '@dataset.username'}`)
- [ ] Map action → Playwright code deterministically (no regex, no detection)
- [ ] Structure: Graph has ordered steps → Script Gen emits them in order, 1:1

**Target Files:**
- `src/script-gen/script-gen-engine.ts` (L1880-1910, L3395-3577, L3610, L4094-4138)
- `src/script-gen/page-object-rewriter.ts` (L304)

**Test Coverage:**
- [ ] Unit test: Graph contains `{action: 'fill', field: 'username'}` → Script emits `await page.fill('#username', user.username)`
- [ ] Unit test: No regex matching, no PO detection — pure mapping

---

### **Sprint 2D.4: Assertions from `expectedBehavior` ⭐⭐⭐⭐**

**Current Problem:** Script Gen infers assertions from title, expected result text, URL patterns, etc.

**What to Remove:**
- [ ] **Assertion inference from title/steps** (L4299-4305)
  - `if (/login/.test(t)) await expect(page).toHaveURL(...)`
- [ ] **Coverage category inference** (L2259-2290 in `buildCoverageMetadata()`)
  - Regex: `/\bpositive\b|smoke|happy\s*path|\bsuccess\b/` → add 'Functional'
  - Currently has Sprint 2D.1 bypass for graph cases, but legacy path still exists
- [ ] **Error fragment inference** (L4427-4500 in `buildAssertion()`)
  - Calls `this.scenario.classify()` → transformer → `errorFragment()`
  - Has Sprint 2D.1 bypass when `semantics` available, but ScenarioIntelligence still active for legacy cases
- [ ] **Post-login assertion generation** (L5366-5369)
  - `if (step.description.toLowerCase().includes('login'))`
- [ ] **Hardcoded success indicators** (L4395-4401)
  - `if (!page.url().includes('/login'))` → assume success

**What to Replace With:**
- [ ] Read `expectedBehavior` from ScenarioNode
- [ ] Map each expected behavior → assertion (e.g., `{type: 'url', pattern: '/dashboard'}` → `await expect(page).toHaveURL(...)`)
- [ ] Read `expectedResults` array from ScenarioNode → generate multi-assertion chain

**Target Files:**
- `src/script-gen/script-gen-engine.ts` (L2259-2290, L4299-4305, L4427-4500, L5366-5369)

**Test Coverage:**
- [ ] Unit test: `expectedBehavior: {url: '/dashboard'}` → generates `toHaveURL` assertion
- [ ] Unit test: `expectedResults: [{type: 'error', text: 'Invalid credentials'}]` → generates `toContainText` assertion

---

### **Sprint 2D.5: Deterministic Script Structure ⭐⭐⭐**

**Current Problem:** Script structure varies based on inferred scenario type (login vs checkout vs normal).

**What to Remove:**
- [ ] **PO matching by scenario type** (L3167, L3395, L3756)
  - `if (usePO) importLine += loginPO.importPath`
  - `if (loginPO) { ... }` conditional logic
- [ ] **Flow-based PO selection** (happens in `applyPageObjectActions()`)
- [ ] **Scenario-aware step grouping** (login triad collapse, checkout grouping)

**What to Replace With:**
- [ ] Uniform script structure regardless of scenario type
- [ ] Steps from graph → code lines (1:1, no grouping, no collapsing)
- [ ] PO imports based on ACTUAL elements used, not inferred scenario type

**Target Files:**
- `src/script-gen/script-gen-engine.ts` (L3167, L3395, L3756, entire `applyPageObjectActions()`)

**Test Coverage:**
- [ ] Unit test: Two scenarios with same graph structure → identical script structure
- [ ] Unit test: Login scenario vs checkout scenario → both use same deterministic template

---

### **Sprint 2D.6: Remove Duplicate Intelligence ⭐⭐⭐⭐⭐**

**Current Problem:** ScenarioIntelligence module still exists with 7+ transformers that re-classify scenarios.

**What to DELETE ENTIRELY:**
- [ ] `src/script-gen/scenario-intelligence/` directory (entire module)
  - `index.ts` — `ScenarioIntelligence` class
  - `detection.ts` — `classifyScenario()`, `extractSpecialCharLiteral()`
  - `transformers/boundary-length.transformer.ts`
  - `transformers/empty-fields.transformer.ts`
  - `transformers/invalid-credentials.transformer.ts`
  - `transformers/normal.transformer.ts`
  - `transformers/special-characters.transformer.ts`
  - `transformers/whitespace.transformer.ts`
  - `types.ts`
- [ ] Remove `this.scenario = new ScenarioIntelligence()` from `script-gen-engine.ts:595`
- [ ] Remove import `ScenarioIntelligence` from `script-gen-engine.ts:44`
- [ ] Remove all calls to `this.scenario.classify()`
- [ ] Remove all transformer references

**Verification:**
- [ ] `grep -r "ScenarioIntelligence" src/` → 0 results
- [ ] `grep -r "scenario.classify" src/` → 0 results
- [ ] `grep -r "transformer" src/script-gen/` → 0 results (except type imports)
- [ ] ALL Script Gen logic reads ONLY from ScenarioNode fields (no inference, no classification)

**Test Coverage:**
- [ ] Architecture contract test: `script-gen-engine.ts` imports NO scenario-intelligence modules
- [ ] Architecture contract test: No regex-based scenario detection anywhere in `src/script-gen/`

---

## 🧹 Supporting Cleanup (Not Blockers, But Nice-to-Have)

- [ ] Remove auth-specific regex from `page-crawler.ts` (L309, L363) — page classification shouldn't be login-aware
- [ ] Remove login-specific logic from `auth-engine.ts` (if Script Gen no longer needs it)
- [ ] Remove `workflow-mapper.ts` login page detection (L94-95)
- [ ] Remove login-specific stopwords from credential validator (L2070)

---

## 📊 Progress Tracking

| Sprint | Status | Files Changed | Tests Added | Intelligence Removed |
|--------|--------|---------------|-------------|---------------------|
| 2D.1   | ✅ DONE | 4 | 4 | Semantics-based credentials (partial) |
| 2D.2   | 🔲 TODO | TBD | TBD | Dataset value extraction |
| 2D.3   | 🔲 TODO | TBD | TBD | Action detection regex |
| 2D.4   | 🔲 TODO | TBD | TBD | Assertion inference |
| 2D.5   | 🔲 TODO | TBD | TBD | Flow-based structure |
| 2D.6   | 🔲 TODO | TBD | TBD | ScenarioIntelligence module |

---

## ✅ Success Criteria (End of Sprint 2D)

**The Litmus Test:**
```typescript
// Remove this line from the entire codebase:
const requirement = tc.requirement; // ❌ NEVER READ

// Script Gen should work using ONLY:
const node = scenarioGraph.get(tc.scenarioId);
const script = generateScript({
  title: node.title,
  objective: node.objective,
  semantics: node.semantics,          // ← variableUnderTest + variation + expectedBehavior
  execution: node.execution,          // ← resolvedDataset
  expectedResults: node.expectedResults,
  steps: node.steps,                  // ← ordered action list with targets + values
});
```

**Verification:**
1. Remove `requirement` field from all test case projections
2. Run Script Generation
3. Generated scripts are IDENTICAL (or better)
4. Zero fallback to ScenarioIntelligence
5. Zero regex-based classification
6. `src/script-gen/scenario-intelligence/` directory deleted

---

**Next Step:** Start Sprint 2D.2 (consume `execution.resolvedDataset`)
