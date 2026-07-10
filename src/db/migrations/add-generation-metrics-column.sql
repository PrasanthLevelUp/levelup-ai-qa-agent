-- =====================================================================
-- Generation Cost Tracker — Add ai_metrics JSONB column
-- =====================================================================
-- Adds structured AI generation telemetry captured from the provider's own
-- `usage` object (never estimated). Stores { llmCalls, promptTokens,
-- completionTokens, totalTokens, durationMs, cacheHit, provider, model }.
--
-- `null` totals = provider returned no usage (unknown); `0` + cacheHit = a
-- genuine deterministic/cached run (no LLM call). This replaces the misleading
-- bare `tokens_used: 0` with an honest "Deterministic" UI badge.
--
-- Named `ai_metrics` (not `generation_metrics`) to accommodate future
-- telemetry beyond tokens: retries, latency, promptVersion, reasoningTime, etc.
--
-- Idempotent: safe to run multiple times.
-- =====================================================================

-- Add ai_metrics JSONB column to generated_scripts if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'generated_scripts'
      AND column_name = 'ai_metrics'
  ) THEN
    ALTER TABLE generated_scripts
    ADD COLUMN ai_metrics JSONB DEFAULT NULL;
    
    COMMENT ON COLUMN generated_scripts.ai_metrics IS
      'Structured AI generation telemetry: { llmCalls, promptTokens, completionTokens, totalTokens, durationMs, cacheHit, provider, model }. null = not yet captured; 0 tokens + cacheHit = deterministic. Generic name allows future fields (retries, latency, reasoningTime).';
  END IF;
END $$;
