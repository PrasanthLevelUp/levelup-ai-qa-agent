# PX-1A — Dataset Usage Fix

**Philosophy:** Datasets assist, they don't dominate.

---

## Root Cause

`pickDataset()` had two issues:
1. **Always fell back to `datasets[0]`** even when no terms matched
2. **All scenarios inherited requirement context** → SQL/XSS matched "employee" → `new_employee`

## The Fix

### Change 1: Require at least one matching term
```typescript
// BEFORE: let bestScore = -1;  // Auto-picked datasets[0]
// AFTER:
let bestScore = 0;  // Require at least 1 matching term
```

### Change 2: Weight dataset name matches higher
```typescript
// Name matches score 2× higher than key matches
if (t && datasetName.includes(t)) score += 2;
else if (t && keys.includes(t)) score += 1;
```

### Change 3: Only positive scenarios inherit requirement context
```typescript
const isPositiveCreate = scenario.coverageType === 'positive' && 
  /create|add|new|register|submit/i.test(scenario.title);
const requirementContext = isPositiveCreate ? (input?.title ?? '') : '';
```

### Change 4: Make dataset usage transparent
```typescript
// Users see exactly where values come from:
const testData = dataset?.name
  ? `✓ Dataset: ${dataset.name} (keys: ...)`
  : 'Generated inline values (no matching dataset).';
```

---

## Proof (Add New Employee requirement)

| Scenario | Test Data Field | Correct? |
|---|---|---|
| **Positive** "Create a record with valid data" | `✓ Dataset: new_employee (keys: firstName, lastName)` | ✅ |
| **Duplicate** "Re-submitting does not create duplicate" | `✓ Dataset: duplicate_employee (keys: firstName, lastName)` | ✅ |
| **SQL** "SQL-injection input is rejected" | `Generated inline values (no matching dataset).` | ✅ |
| **XSS** "XSS payload is escaped" | `Generated inline values (no matching dataset).` | ✅ |
| **Whitespace** "Whitespace-only fields rejected" | `Generated inline values (no matching dataset).` | ✅ |
| **Boundary** "Field length boundaries" | `Generated inline values (no matching dataset).` | ✅ |

---

## Product Rules Implemented

✅ **Datasets assist, they don't dominate**  
✅ **Dataset usage is visible** (transparency builds trust)  
✅ **Deterministic tie-breaking** (first dataset wins ties)  
✅ **Works with meaningless dataset names** (Dataset_A → falls back to inline values)

---

## Matching Strategy (documented in code)

**LEXICAL, not semantic:**
- Dataset name matches score 2× higher than key matches
- Requires at least 1 term overlap to select a dataset
- When multiple datasets tie, picks the first in upload order (deterministic)
- When no dataset matches, returns undefined → inline values are generated

**INTENTIONALLY OUT OF SCOPE** (future improvement):
- Semantic matching (e.g. "Employee_Master" ≈ "Add Employee")
- Domain-aware matching (e.g. HR domain → prefer HR-related datasets)
- Multi-word compound matching (e.g. "new employee" as a phrase)

---

## Files Changed

`src/engines/scenario-builder.ts`:
- `pickDataset()` — require ≥1 term match, weight name matches 2×, document lexical strategy
- Dataset term matching — positive scenarios inherit requirement context only
- Test Data field — transparent wording shows dataset vs inline

## Tests

- `scenario-builder.test.ts` — 28/28 pass ✅
- `tsc --noEmit` — clean ✅
- Gate 0 proof — all scenarios match correctly ✅

