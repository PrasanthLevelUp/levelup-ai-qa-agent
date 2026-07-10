-- =====================================================================
-- Generation Cost Tracker — Add generation_metrics JSONB column
-- =====================================================================
-- Adds structured token/usage telemetry captured from the provider's own
-- `usage` object (never estimated). Stores { llmCalls, promptTokens,
-- completionTokens, totalTokens, durationMs, cacheHit, provider, model }.
--
-- `null` totals = provider returned no usage (unknown); `0` + cacheHit = a
-- genuine deterministic/cached run (no LLM call). This replaces the misleading
-- bare `tokens_used: 0` with an honest "Deterministic" UI badge.
--
-- Idempotent: safe to run multiple times.
-- =====================================================================

-- Add generation_metrics JSONB column to generated_scripts if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'generated_scripts'
      AND column_name = 'generation_metrics'
  ) THEN
    ALTER TABLE generated_scripts
    ADD COLUMN generation_metrics JSONB DEFAULT NULL;
    
    COMMENT ON COLUMN generated_scripts.generation_metrics IS
      'Structured token/usage telemetry: { llmCalls, promptTokens, completionTokens, totalTokens, durationMs, cacheHit, provider, model }. null = not yet captured; 0 tokens + cacheHit = deterministic.';
  END IF;
END $$;

-- Optional: create a GIN index for fast JSON queries (if needed later)
CREATE INDEX IF NOT EXISTS idx_generated_scripts_generation_metrics
  ON generated_scripts USING GIN (generation_metrics);
