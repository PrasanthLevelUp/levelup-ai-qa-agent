/**
 * Template & Export Type Definitions
 *
 * Shared interfaces for the test-case export pipeline.
 * Covers template schemas, export options, and DB row shapes.
 */

/* ========================================================================== */
/*  Template Column Definition                                                */
/* ========================================================================== */

/** A single column in a template schema. */
export interface TemplateColumn {
  /** Machine key — maps to TestCaseTemplateV1 fields */
  key: string;
  /** Human-readable header shown in exports */
  label: string;
  /** Excel column width (character units) */
  width: number;
  /** Whether the column is mandatory when importing */
  required: boolean;
  /** Default value when source data is missing */
  defaultValue?: string;
}

/* ========================================================================== */
/*  Template Row — one row per test case                                      */
/* ========================================================================== */

/** Flat row that maps 1-to-1 with an exported spreadsheet row. */
export interface TestCaseTemplateV1 {
  testCaseId: string;
  scenario: string;
  priority: string;
  category: string;
  preconditions: string;
  testSteps: string;
  expectedResult: string;
  testData: string;
  coverageType: string;
  tags: string;
  automationStatus: string;
  createdAt: string;
}

/* ========================================================================== */
/*  Export Options                                                            */
/* ========================================================================== */

export type ExportFormat = 'xlsx' | 'csv';

export interface ExportOptions {
  format: ExportFormat;
  /** Include coverage-gap scenarios in the export */
  includeGaps: boolean;
  /** Template version to use (default: latest active) */
  templateVersion?: string;
  /** Optional column subset — when omitted, all columns are exported */
  columns?: string[];
  /** Attach a metadata / summary sheet (Excel only) */
  includeMetadata?: boolean;
}

/* ========================================================================== */
/*  Export Result                                                             */
/* ========================================================================== */

/** Returned by ExportService after a successful export. */
export interface ExportResult {
  /** In-memory buffer of the generated file */
  buffer: Buffer;
  /** Suggested download filename */
  filename: string;
  /** MIME content-type */
  contentType: string;
  /** Total scenario rows included */
  totalScenarios: number;
  /** Subset that are coverage-gap rows */
  includedGaps: number;
  /** Wall-clock ms spent generating the file */
  exportTimeMs: number;
}

/* ========================================================================== */
/*  DB Row Shapes                                                            */
/* ========================================================================== */

/** Row returned from test_case_export_history. */
export interface ExportHistoryRow {
  id: number;
  company_id: number;
  project_id: number | null;
  user_id: number | null;
  requirement_id: number;
  format: ExportFormat;
  total_scenarios: number;
  included_gaps: number;
  file_size_bytes: number;
  export_time_ms: number;
  created_at: string;
}

/** Row returned from test_case_template_versions. */
export interface TemplateVersionRow {
  id: number;
  version: string;
  schema: TemplateColumn[];
  is_active: boolean;
  created_at: string;
}

/* ========================================================================== */
/*  Internal — scenario row from DB (used by ExportService.transform)         */
/* ========================================================================== */

/** Shape coming out of the generated_test_scenarios + generated_test_cases join. */
export interface ScenarioWithCases {
  scenario_id: number;
  scenario: string;
  coverage_type: string;
  priority: string;
  risk_area: string;
  cases: TestCaseRow[];
}

export interface TestCaseRow {
  id: number;
  title: string;
  preconditions: string | null;
  steps: string[];
  expected_result: string;
  test_data: string | null;
  priority: string;
  severity: string;
  tags: string[];
  automation_ready: boolean;
  automation_complexity: string;
  created_at: string;
}
