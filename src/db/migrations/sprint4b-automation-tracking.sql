-- =====================================================================
-- Sprint 4B — Test-Case Automation Tracking (DOCUMENTATION MIRROR)
-- =====================================================================
-- Human-readable mirror of the canonical, executable statements added to
-- `src/db/rtm-schema.ts` (RTM_STATEMENTS, "Sprint 4B" block). The TypeScript
-- module is what actually runs at startup (initSchema) and on demand
-- (runRTMMigration). `tsc` does NOT copy .sql files into dist/, so this file is
-- for manual operations / review only. Keep it in sync with rtm-schema.ts.
--
-- Goal: track which `generated_test_cases` rows have an automated script.
--   * is_automated              BOOLEAN  — flag, defaults to false
--   * last_automated_script_id  INTEGER  — FK-ish pointer to generated_scripts.id
--   * last_automated_at         TIMESTAMPTZ — when it was last automated
--
-- Backward compatible: every statement is additive and idempotent (guarded DO
-- blocks / IF NOT EXISTS). Legacy rows default to is_automated=false; the
-- backfill flips any test case that already has a (non-deleted) generated
-- script, choosing the most recent script per case (DISTINCT ON).
-- =====================================================================

-- 1. is_automated flag ------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'generated_test_cases' AND column_name = 'is_automated'
  ) THEN
    ALTER TABLE generated_test_cases ADD COLUMN is_automated BOOLEAN DEFAULT false;
  END IF;
END $$;

-- 2. last_automated_script_id (points at generated_scripts.id) --------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'generated_test_cases' AND column_name = 'last_automated_script_id'
  ) THEN
    ALTER TABLE generated_test_cases ADD COLUMN last_automated_script_id INTEGER;
  END IF;
END $$;

-- 3. last_automated_at timestamp --------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'generated_test_cases' AND column_name = 'last_automated_at'
  ) THEN
    ALTER TABLE generated_test_cases ADD COLUMN last_automated_at TIMESTAMPTZ;
  END IF;
END $$;

-- 4. Partial index for fast "automated" filters / counts --------------
CREATE INDEX IF NOT EXISTS idx_gtc_is_automated
  ON generated_test_cases(is_automated) WHERE is_automated = true;

-- 5. Backfill existing rows -------------------------------------------
-- Any test case with a non-deleted generated script is automated. Pick the
-- latest script per test case so the pointer/timestamp are unambiguous.
-- Only touches still-not-automated rows, so it is safe to re-run.
UPDATE generated_test_cases tc
SET is_automated = true,
    last_automated_script_id = sub.script_id,
    last_automated_at = sub.created_at
FROM (
  SELECT DISTINCT ON (gs.test_case_id)
         gs.test_case_id,
         gs.id          AS script_id,
         gs.created_at  AS created_at
  FROM generated_scripts gs
  WHERE gs.test_case_id IS NOT NULL AND gs.deleted_at IS NULL
  ORDER BY gs.test_case_id, gs.created_at DESC, gs.id DESC
) sub
WHERE tc.id = sub.test_case_id
  AND COALESCE(tc.is_automated, false) = false;
