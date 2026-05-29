-- Migration: Add Test Case Export Features
-- Date: 2026-05-29
-- Description: Adds export history tracking, template versioning, and coverage gap preferences
-- NOTE: This SQL is applied inline via src/db/postgres.ts initializeDatabase().
--       This file is for documentation / manual apply only.

-- 1. Add coverage gap preferences to test_requirements
ALTER TABLE test_requirements
  ADD COLUMN IF NOT EXISTS coverage_gaps_included BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS export_preferences JSONB DEFAULT '{}';

-- 2. Create export history table
CREATE TABLE IF NOT EXISTS test_case_export_history (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL,
  requirement_id INTEGER REFERENCES test_requirements(id) ON DELETE SET NULL,
  format VARCHAR(50) NOT NULL,           -- 'excel', 'csv', 'jira', 'testrail'
  total_scenarios INTEGER DEFAULT 0,
  included_gaps BOOLEAN DEFAULT false,
  file_size_bytes BIGINT DEFAULT 0,
  export_time_ms INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create template versions table
CREATE TABLE IF NOT EXISTS test_case_template_versions (
  id SERIAL PRIMARY KEY,
  version VARCHAR(20) NOT NULL UNIQUE,
  schema JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Seed v1.0.0 template schema
INSERT INTO test_case_template_versions (version, schema, is_active)
VALUES (
  '1.0.0',
  '{
    "version": "1.0.0",
    "columns": [
      {"key": "testCaseId", "header": "TC ID", "width": 15, "required": true},
      {"key": "scenario", "header": "Scenario", "width": 40, "required": true},
      {"key": "priority", "header": "Priority", "width": 12, "required": true},
      {"key": "category", "header": "Category", "width": 20, "required": true},
      {"key": "preconditions", "header": "Preconditions", "width": 30},
      {"key": "testSteps", "header": "Test Steps", "width": 50, "required": true},
      {"key": "expectedResult", "header": "Expected Result", "width": 40, "required": true},
      {"key": "testData", "header": "Test Data", "width": 30},
      {"key": "coverageType", "header": "Coverage Type", "width": 15, "required": true},
      {"key": "tags", "header": "Tags", "width": 20},
      {"key": "automationStatus", "header": "Automation Status", "width": 18},
      {"key": "createdAt", "header": "Created", "width": 20}
    ]
  }'::jsonb,
  true
)
ON CONFLICT (version) DO NOTHING;

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_export_history_company ON test_case_export_history(company_id);
CREATE INDEX IF NOT EXISTS idx_export_history_project ON test_case_export_history(project_id);
CREATE INDEX IF NOT EXISTS idx_export_history_created ON test_case_export_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_history_user ON test_case_export_history(user_id);
