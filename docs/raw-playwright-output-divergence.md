# Raw Playwright Output Divergence — same broken locator, different outputs

**Scope:** RAW Playwright artifacts only (`test-results.json`, trace, stdout, stderr).
LevelUp processing deliberately ignored. Goal: explain why the *same* broken locator
(`#username`, which does not exist on SauceDemo — the real field is `#user-name` /
`[data-test="username"]`) yields *different* Playwright outputs, and name the root cause
to investigate next.

Test repo: `LevelUpAI_SauceDemo`. Broken locator lives in `pages/LoginPage.ts:6`
(`username = this.page.locator('#username')`), used at line 11 (`await
this.username.fill(user)`), driven by `tests/verify-successful-login-with-valid-credentials.spec.ts`.

---

## The three raw outcomes I reproduced (identical code, identical locator)

| | Run A — natural action timeout | Run B — killed mid-action (SIGINT / process-group kill) | Run C — aborted before action timeout (global/budget timeout) |
|---|---|---|---|
| How produced | `npx playwright test <spec>` (30s test timeout fires) | start run, `kill -INT -<pgid>` at 6s | `npx playwright test <spec> --global-timeout=8000` |
| `test-results.json` written? | ✅ yes | ❌ **no file at all** | ✅ yes |
| Failing test result status | `timedOut` | (none) | `skipped` / interrupted |
| Per-action error present? | ✅ `errors[1]` = `locator.fill ... waiting for locator('#username')` | — | ❌ none |
| `errors[].location` | ✅ `pages/LoginPage.ts:11` | — | ❌ none (only **top-level** `errors[]`) |
| Only error available | located action error | — | generic `"Timed out waiting 8s for the test suite to run"` (no location, no locator) |
| trace.zip produced? | ✅ yes | ❌ no | ❌ no |
| Locator recoverable from raw output? | ✅ **`#username`** | ❌ nothing to parse | ❌ nothing to parse |

### Run A raw (the GOOD shape — matches the on-disk captured CI run)
```
status: timedOut
errors[0].message: "Test timeout of 30000ms exceeded."        location: None
errors[1].message: "Error: locator.fill: ... waiting for locator('#username')"
errors[1].location: { file: pages/LoginPage.ts, line: 11, column: 25 }
```
stdout literally prints `- waiting for locator('#username')`. trace.zip attached.
**This is exactly the shape of the failing run already captured on disk**
(`test-results/.../error-context.md` shows the same located `waiting for locator('#username')`).

### Run B raw (kill mid-action)
```
(no test-results.json written — Playwright never finished the reporter)
stdout stops after "[1/1] ... Verify successful login"
```

### Run C raw (the BAD shape — reproduces the hallucination input)
```
failing test result -> status: skipped, error: None, errors: [], errorLocation: None
top-level errors: [
  "Timed out waiting 8s for the test suite to run",
  "Timed out waiting 8s for the teardown for test suite to run"
]
```
No per-test error, **no location anywhere**, no trace. The only signal is a generic
suite-level timeout string that never mentions `#username`.

---

## Why the same broken locator produces different outputs

A non-existent locator in Playwright is **not** an immediate error — `locator.fill()`
*waits*. The detailed, located error (`waiting for locator('#username')` + `location:
LoginPage.ts:11`) is only emitted **when the per-action / per-test timeout fires
naturally**. Everything downstream that can recover `#username` depends on that one
event happening.

So the divergence is entirely a function of **how the run ends**:

1. **Allowed to reach the 30s action/test timeout (Run A):** Playwright produces the
   rich located error + call log + trace. `#username` is in the raw output. This is the
   original CI execution's shape (proven by the on-disk `error-context.md`).

2. **Terminated before the action timeout fires (Runs B & C):** the wait is cut short,
   so Playwright never emits the located action error. You get either **no results file**
   (hard kill, Run B) or a **generic suite-level timeout with no location and no locator**
   (graceful global/budget abort, Run C). `#username` is absent from the raw output. This
   is the shape that starves extraction and lets the AI hallucinate.

**Same locator. The difference is timing of termination, not the locator and not the
healing pipeline.**

---

## Root cause to investigate next (raw-execution layer, NOT the healing pipeline)

The original CI failure is Run A (located, has `#username`). The hallucination came from
a **re-execution that ended like Run C/B**. The execution layer is what changes the
ending:

- `ExecutionEngine.runAsync` runs the rerun under a **budget-derived timeout**
  (`rerunTimeoutMs()` computed from remaining `HEALING_JOB_BUDGET_MS` /
  `HEALING_PER_TEST_BUDGET_MS`) and **kills the process group** (`process.kill(-pid)`) on
  timeout. When the remaining budget is smaller than the test's own 30s action timeout,
  the rerun is killed **before** Playwright emits the located error → Run B (no file) or
  Run C (generic, no-location) shape → `failed_locator = null` → AI hallucination.
- A grep-only / different rerun target (whole-suite) can also change which timeout fires
  first and whether a per-action error is ever produced.

> **Investigate:** the relationship between `rerunTimeoutMs()` (budget-derived) and the
> test repo's own action/test timeout (30s here). Whenever rerun timeout ≤ action
> timeout, the rerun cannot produce a located locator error — guaranteeing the
> no-location / no-file shape. Confirm with the failing job's actual rerun timeout and
> exit signal.

### To close the last 1%
The single field that distinguishes the two shapes in the failing job's raw
`test-results.json`:
```
.suites[].specs[].tests[].results[].errors[].location   # present = Run A ; absent (only top-level errors[]) = Run C
```
Plus the rerun's exit signal (clean exit vs SIGKILL/SIGTERM) and the effective rerun
timeout vs the repo's 30s action timeout.

---

## Reproduction commands (exact)
```bash
cd LevelUpAI_SauceDemo
# Run A — GOOD shape (located #username, trace, status timedOut)
npx playwright test tests/verify-successful-login-with-valid-credentials.spec.ts

# Run B — killed mid-action (no results file)
setsid npx playwright test tests/verify-successful-login-with-valid-credentials.spec.ts & \
  PGID=$!; sleep 6; kill -INT -$PGID

# Run C — BAD shape (generic suite timeout, no location, no locator, no trace)
npx playwright test tests/verify-successful-login-with-valid-credentials.spec.ts --global-timeout=8000
```
