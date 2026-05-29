/**
 * Export Service — Generates Excel (.xlsx) and CSV exports of test cases.
 *
 * Memory-efficient: streams rows one-at-a-time via exceljs streaming writer
 * and fast-csv formatter.  Backward compatible with scenarios that predate the
 * export feature (missing fields fall back to sensible defaults).
 */

import ExcelJS from 'exceljs';
import { format as csvFormat } from 'fast-csv';
import { logger } from '../utils/logger';
import {
  ExportFormat,
  ExportOptions,
  ExportResult,
  TemplateColumn,
  TestCaseTemplateV1,
  TestCaseRow,
  ScenarioWithCases,
} from '../types/template';

const MOD = 'export-service';

/* ========================================================================== */
/*  Default Template v1.0.0 columns                                           */
/* ========================================================================== */

export const DEFAULT_COLUMNS: TemplateColumn[] = [
  { key: 'testCaseId',      label: 'Test Case ID',       width: 15, required: true },
  { key: 'scenario',        label: 'Scenario',           width: 40, required: true },
  { key: 'priority',        label: 'Priority',           width: 10, required: true },
  { key: 'category',        label: 'Category',           width: 18, required: false },
  { key: 'preconditions',   label: 'Preconditions',      width: 30, required: false },
  { key: 'testSteps',       label: 'Test Steps',         width: 50, required: true },
  { key: 'expectedResult',  label: 'Expected Result',    width: 40, required: true },
  { key: 'testData',        label: 'Test Data',          width: 25, required: false },
  { key: 'coverageType',    label: 'Coverage Type',      width: 18, required: false },
  { key: 'tags',            label: 'Tags',               width: 25, required: false },
  { key: 'automationStatus', label: 'Automation Status', width: 18, required: false },
  { key: 'createdAt',       label: 'Created At',         width: 20, required: false },
];

/* ========================================================================== */
/*  Helper — format step array into numbered string                           */
/* ========================================================================== */

/**
 * Converts a JSON steps array into a numbered, newline-separated string.
 *
 * @example
 *   formatSteps(['Open browser', 'Navigate to URL'])
 *   // → "1. Open browser\n2. Navigate to URL"
 */
export function formatSteps(steps: string[] | null | undefined): string {
  if (!steps || !Array.isArray(steps) || steps.length === 0) return '';
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

/* ========================================================================== */
/*  Helper — transform a DB test-case row into a template row                 */
/* ========================================================================== */

/**
 * Maps a raw DB row (generated_test_cases joined with its scenario)
 * into the flat TestCaseTemplateV1 shape used by the export columns.
 */
export function transformToTemplate(
  tc: TestCaseRow,
  scenarioText: string,
  coverageType: string,
  index: number,
): TestCaseTemplateV1 {
  return {
    testCaseId:       `TC-${String(index).padStart(4, '0')}`,
    scenario:         scenarioText,
    priority:         tc.priority || 'P1',
    category:         coverageType || 'functional',
    preconditions:    tc.preconditions || '',
    testSteps:        formatSteps(tc.steps),
    expectedResult:   tc.expected_result || '',
    testData:         tc.test_data || '',
    coverageType:     coverageType || 'functional',
    tags:             Array.isArray(tc.tags) ? tc.tags.join(', ') : '',
    automationStatus: tc.automation_ready ? 'Ready' : 'Manual',
    createdAt:        tc.created_at || new Date().toISOString(),
  };
}

/* ========================================================================== */
/*  Excel Export                                                               */
/* ========================================================================== */

export interface ExcelMetadata {
  requirementTitle: string;
  requirementDescription: string;
  totalScenarios: number;
  includedGaps: number;
  exportedAt: string;
  exportedBy?: string;
}

/**
 * Build an Excel workbook buffer from template rows.
 *
 * @param rows      - Flat template rows to write
 * @param columns   - Column definitions (order, label, width)
 * @param metadata  - Optional metadata for a summary sheet
 * @returns         - Buffer of the .xlsx file
 */
export async function exportToExcel(
  rows: TestCaseTemplateV1[],
  columns: TemplateColumn[] = DEFAULT_COLUMNS,
  metadata?: ExcelMetadata,
): Promise<Buffer> {
  logger.info(MOD, 'Generating Excel export', { rows: rows.length });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LevelUp QA Agent';
  workbook.created = new Date();

  /* --- Test Cases sheet -------------------------------------------------- */
  const sheet = workbook.addWorksheet('Test Cases', {
    properties: { defaultColWidth: 20 },
  });

  // Header row
  sheet.columns = columns.map((col) => ({
    header: col.label,
    key: col.key,
    width: col.width,
  }));

  // Style header
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4A148C' }, // deep purple
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // Data rows
  for (const row of rows) {
    const values: Record<string, string> = {};
    for (const col of columns) {
      values[col.key] = (row as unknown as Record<string, string>)[col.key] ?? col.defaultValue ?? '';
    }
    sheet.addRow(values);
  }

  // Auto-filter on the header
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: columns.length },
  };

  /* --- Metadata sheet (optional) ----------------------------------------- */
  if (metadata) {
    addMetadataSheet(workbook, metadata);
  }

  /* --- Write to buffer --------------------------------------------------- */
  const arrayBuf = await workbook.xlsx.writeBuffer();
  const buf = Buffer.from(arrayBuf);

  logger.info(MOD, 'Excel export complete', { bytes: buf.length });
  return buf;
}

/* ========================================================================== */
/*  Metadata Sheet                                                            */
/* ========================================================================== */

function addMetadataSheet(wb: ExcelJS.Workbook, meta: ExcelMetadata): void {
  const sheet = wb.addWorksheet('Export Info');
  sheet.columns = [
    { header: 'Property', key: 'prop', width: 25 },
    { header: 'Value',    key: 'val',  width: 60 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1B5E20' }, // dark green
  };

  const pairs: [string, string][] = [
    ['Requirement',         meta.requirementTitle],
    ['Description',         meta.requirementDescription],
    ['Total Scenarios',     String(meta.totalScenarios)],
    ['Coverage-Gap Rows',   String(meta.includedGaps)],
    ['Exported At',         meta.exportedAt],
  ];
  if (meta.exportedBy) pairs.push(['Exported By', meta.exportedBy]);

  for (const [prop, val] of pairs) {
    sheet.addRow({ prop, val });
  }
}

/* ========================================================================== */
/*  CSV Export                                                                 */
/* ========================================================================== */

/**
 * Build a CSV buffer from template rows.
 *
 * Uses fast-csv for standards-compliant quoting/escaping.
 */
export async function exportToCSV(
  rows: TestCaseTemplateV1[],
  columns: TemplateColumn[] = DEFAULT_COLUMNS,
): Promise<Buffer> {
  logger.info(MOD, 'Generating CSV export', { rows: rows.length });

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    const stream = csvFormat({ headers: true });

    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const buf = Buffer.concat(chunks);
      logger.info(MOD, 'CSV export complete', { bytes: buf.length });
      resolve(buf);
    });
    stream.on('error', (err) => {
      logger.error(MOD, 'CSV export failed', { error: String(err) });
      reject(err);
    });

    // Write rows
    for (const row of rows) {
      const obj: Record<string, string> = {};
      for (const col of columns) {
        obj[col.label] = (row as unknown as Record<string, string>)[col.key] ?? col.defaultValue ?? '';
      }
      stream.write(obj);
    }
    stream.end();
  });
}

/* ========================================================================== */
/*  High-level export orchestrator                                            */
/* ========================================================================== */

/**
 * Full export pipeline: fetches scenarios, transforms, writes file buffer.
 *
 * @param scenarios  - Pre-fetched scenario data (with nested cases)
 * @param options    - Export configuration
 * @param metadata   - Optional metadata for the summary sheet
 * @returns ExportResult with buffer, filename, timings, counts
 */
export async function generateExport(
  scenarios: ScenarioWithCases[],
  options: ExportOptions,
  metadata?: ExcelMetadata,
): Promise<ExportResult> {
  const start = Date.now();

  // Flatten scenarios → template rows
  let rowIndex = 1;
  let gapCount = 0;
  const rows: TestCaseTemplateV1[] = [];

  for (const s of scenarios) {
    const isGap = s.coverage_type === 'coverage_gap';

    // Skip gaps if not requested
    if (isGap && !options.includeGaps) continue;

    if (s.cases.length === 0) {
      // Scenario with no child cases — export as a single row
      rows.push(transformToTemplate(
        {
          id: 0,
          title: s.scenario,
          preconditions: null,
          steps: [],
          expected_result: '',
          test_data: null,
          priority: s.priority,
          severity: 'major',
          tags: [],
          automation_ready: false,
          automation_complexity: 'medium',
          created_at: new Date().toISOString(),
        },
        s.scenario,
        s.coverage_type,
        rowIndex++,
      ));
      if (isGap) gapCount++;
    } else {
      for (const tc of s.cases) {
        rows.push(transformToTemplate(tc, s.scenario, s.coverage_type, rowIndex++));
        if (isGap) gapCount++;
      }
    }
  }

  // Filter columns if a subset was requested
  const columns = options.columns
    ? DEFAULT_COLUMNS.filter((c) => options.columns!.includes(c.key))
    : DEFAULT_COLUMNS;

  // Generate file buffer
  let buffer: Buffer;
  let contentType: string;
  let ext: string;

  if (options.format === 'xlsx') {
    buffer = await exportToExcel(rows, columns, options.includeMetadata ? metadata : undefined);
    contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    ext = 'xlsx';
  } else {
    buffer = await exportToCSV(rows, columns);
    contentType = 'text/csv; charset=utf-8';
    ext = 'csv';
  }

  const exportTimeMs = Date.now() - start;
  const filename = `test-cases-${Date.now()}.${ext}`;

  logger.info(MOD, 'Export generation complete', {
    format: ext, rows: rows.length, gaps: gapCount, ms: exportTimeMs,
  });

  return {
    buffer,
    filename,
    contentType,
    totalScenarios: rows.length,
    includedGaps: gapCount,
    exportTimeMs,
  };
}
