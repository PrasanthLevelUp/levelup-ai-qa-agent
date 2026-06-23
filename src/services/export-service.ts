/**
 * Export Service
 * Handles conversion of test scenarios and cases to various export formats.
 *
 * Supported formats:
 * - Excel (.xlsx) — Full-featured with styling, metadata sheets, and auto-filters
 * - CSV (.csv) — Simple comma-separated format for universal compatibility
 * - Jira (.xlsx) — Pre-formatted columns matching Jira test management import
 * - TestRail (.xlsx) — Pre-formatted columns matching TestRail CSV/Excel import
 *
 * @example
 * const service = new ExportService();
 * const buffer = await service.exportToExcel(scenarios, testCases, requirement, options);
 */

import ExcelJS from 'exceljs';
import { format as csvFormat } from 'fast-csv';
import { logger } from '../utils/logger';

const MOD = 'ExportService';

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface ExportOptions {
  format: 'excel' | 'csv' | 'jira' | 'testrail';
  includeGaps: boolean;
  includeMetadata: boolean;
  scenarioIds?: number[];
}

export interface ScenarioRow {
  id: number;
  requirement_id: number;
  scenario: string;
  coverage_type: string;
  priority: string;
  risk_area?: string;
  company_id?: number;
  created_at: string;
  case_count?: number;
}

export interface TestCaseRow {
  id: number;
  scenario_id: number;
  title: string;
  preconditions?: string;
  steps: any; // JSONB — string[] or object[]
  expected_result: string;
  test_data?: string;
  priority: string;
  severity: string;
  tags: any; // JSONB — string[]
  automation_ready: boolean;
  automation_complexity?: string;
  selector_availability?: string;
  company_id?: number;
  created_at: string;
  // source provenance — which intelligence grounded this case
  source?: string;
  source_evidence?: string;
  // joined fields
  scenario?: string;
  coverage_type?: string;
}

export interface RequirementInfo {
  id: number;
  title: string;
  description: string;
  module?: string;
  risk_level?: string;
  created_at: string;
}

/* -------------------------------------------------------------------------- */
/*  Color palette                                                              */
/* -------------------------------------------------------------------------- */

const COLORS = {
  headerBg: 'FF1E1B4B',      // deep violet
  headerFont: 'FFFFFFFF',    // white
  p0Bg: 'FFFEE2E2',          // red tint
  p1Bg: 'FFFEF3C7',          // amber tint
  p2Bg: 'FFE0F2FE',          // blue tint
  p3Bg: 'FFF0FDF4',          // green tint
  gapBg: 'FFFFF7ED',         // orange tint (coverage gap)
  borderColor: 'FFE2E8F0',
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: COLORS.p0Bg,
  P1: COLORS.p1Bg,
  P2: COLORS.p2Bg,
  P3: COLORS.p3Bg,
};

/* -------------------------------------------------------------------------- */
/*  ExportService                                                              */
/* -------------------------------------------------------------------------- */

export class ExportService {

  /* ── Excel export ──────────────────────────────────────────────────────── */
  async exportToExcel(
    testCases: TestCaseRow[],
    requirement: RequirementInfo,
    options: ExportOptions,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'LevelUp AI QA Platform';
    workbook.created = new Date();

    // ── Main sheet: Test Cases ──
    const ws = workbook.addWorksheet('Test Cases', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    if (options.format === 'jira') {
      this.buildJiraSheet(ws, testCases);
    } else if (options.format === 'testrail') {
      this.buildTestRailSheet(ws, testCases);
    } else {
      this.buildStandardSheet(ws, testCases, requirement);
    }

    // ── Metadata sheet (optional) ──
    if (options.includeMetadata && options.format === 'excel') {
      const meta = workbook.addWorksheet('Metadata');
      this.buildMetadataSheet(meta, requirement, testCases);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    logger.info(MOD, 'Excel export generated', {
      format: options.format,
      testCases: testCases.length,
      sizeBytes: buffer.byteLength,
    });
    return Buffer.from(buffer);
  }

  /* ── CSV export ────────────────────────────────────────────────────────── */
  async exportToCSV(
    testCases: TestCaseRow[],
    _options: ExportOptions,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const rows: any[] = [];
      const stream = csvFormat({ headers: true });

      stream.on('data', (chunk: Buffer) => rows.push(chunk));
      stream.on('end', () => {
        const csv = Buffer.concat(rows).toString('utf-8');
        logger.info(MOD, 'CSV export generated', { testCases: testCases.length, sizeBytes: csv.length });
        resolve(csv);
      });
      stream.on('error', reject);

      for (const tc of testCases) {
        stream.write({
          'ID': tc.id,
          'Title': tc.title,
          'Scenario': tc.scenario || '',
          'Coverage Type': tc.coverage_type || '',
          'Priority': tc.priority,
          'Severity': tc.severity,
          'Preconditions': tc.preconditions || '',
          'Steps': this.formatSteps(tc.steps),
          'Expected Result': tc.expected_result,
          'Test Data': tc.test_data || '',
          'Tags': this.formatTags(tc.tags),
          'Source': this.formatSource(tc.source),
          'Source Evidence': tc.source_evidence || '',
          'Automation Ready': tc.automation_ready ? 'Yes' : 'No',
          'Automation Complexity': tc.automation_complexity || '',
        });
      }
      stream.end();
    });
  }

  /* ── Private: Standard Excel sheet ─────────────────────────────────────── */
  private buildStandardSheet(ws: ExcelJS.Worksheet, testCases: TestCaseRow[], req: RequirementInfo) {
    const columns: Partial<ExcelJS.Column>[] = [
      { header: '#', key: 'num', width: 5 },
      { header: 'Title', key: 'title', width: 45 },
      { header: 'Scenario', key: 'scenario', width: 35 },
      { header: 'Coverage Type', key: 'coverage_type', width: 16 },
      { header: 'Priority', key: 'priority', width: 10 },
      { header: 'Severity', key: 'severity', width: 12 },
      { header: 'Preconditions', key: 'preconditions', width: 30 },
      { header: 'Steps', key: 'steps', width: 55 },
      { header: 'Expected Result', key: 'expected_result', width: 40 },
      { header: 'Test Data', key: 'test_data', width: 25 },
      { header: 'Tags', key: 'tags', width: 20 },
      { header: 'Source', key: 'source', width: 18 },
      { header: 'Source Evidence', key: 'source_evidence', width: 40 },
      { header: 'Automation Ready', key: 'automation_ready', width: 16 },
      { header: 'Complexity', key: 'automation_complexity', width: 14 },
    ];
    ws.columns = columns;

    // Style header row
    this.styleHeaderRow(ws);

    // Data rows
    testCases.forEach((tc, idx) => {
      const row = ws.addRow({
        num: idx + 1,
        title: tc.title,
        scenario: tc.scenario || '',
        coverage_type: tc.coverage_type || '',
        priority: tc.priority,
        severity: tc.severity,
        preconditions: tc.preconditions || '',
        steps: this.formatSteps(tc.steps),
        expected_result: tc.expected_result,
        test_data: tc.test_data || '',
        tags: this.formatTags(tc.tags),
        source: this.formatSource(tc.source),
        source_evidence: tc.source_evidence || '',
        automation_ready: tc.automation_ready ? '✅ Yes' : '❌ No',
        automation_complexity: tc.automation_complexity || '',
      });

      // Priority coloring
      const bgColor = PRIORITY_COLORS[tc.priority];
      if (bgColor) {
        row.getCell('priority').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
      }

      // Wrap text for long cells
      row.getCell('steps').alignment = { wrapText: true, vertical: 'top' };
      row.getCell('expected_result').alignment = { wrapText: true, vertical: 'top' };
      row.getCell('preconditions').alignment = { wrapText: true, vertical: 'top' };
      row.getCell('source_evidence').alignment = { wrapText: true, vertical: 'top' };
    });

    // Auto-filter (two extra columns — Source, Source Evidence — extend the range to O)
    ws.autoFilter = { from: 'A1', to: `O${testCases.length + 1}` };
  }

  /* ── Private: Jira format sheet ────────────────────────────────────────── */
  private buildJiraSheet(ws: ExcelJS.Worksheet, testCases: TestCaseRow[]) {
    ws.columns = [
      { header: 'Summary', key: 'summary', width: 50 },
      { header: 'Description', key: 'description', width: 60 },
      { header: 'Priority', key: 'priority', width: 10 },
      { header: 'Labels', key: 'labels', width: 25 },
      { header: 'Component/s', key: 'component', width: 20 },
      { header: 'Issue Type', key: 'issue_type', width: 12 },
    ];
    this.styleHeaderRow(ws);

    for (const tc of testCases) {
      const desc = [
        tc.preconditions ? `*Preconditions:*\n${tc.preconditions}\n\n` : '',
        `*Steps:*\n${this.formatSteps(tc.steps)}\n\n`,
        `*Expected Result:*\n${tc.expected_result}`,
        tc.test_data ? `\n\n*Test Data:*\n${tc.test_data}` : '',
      ].join('');

      ws.addRow({
        summary: `[TC] ${tc.title}`,
        description: desc,
        priority: this.mapJiraPriority(tc.priority),
        labels: this.formatTags(tc.tags),
        component: tc.coverage_type || '',
        issue_type: 'Test',
      });
    }
  }

  /* ── Private: TestRail format sheet ────────────────────────────────────── */
  private buildTestRailSheet(ws: ExcelJS.Worksheet, testCases: TestCaseRow[]) {
    ws.columns = [
      { header: 'Title', key: 'title', width: 50 },
      { header: 'Section', key: 'section', width: 25 },
      { header: 'Type', key: 'type', width: 15 },
      { header: 'Priority', key: 'priority', width: 12 },
      { header: 'Preconditions', key: 'preconditions', width: 35 },
      { header: 'Steps', key: 'steps', width: 55 },
      { header: 'Expected Result', key: 'expected', width: 40 },
      { header: 'Automation Type', key: 'automation', width: 18 },
    ];
    this.styleHeaderRow(ws);

    for (const tc of testCases) {
      ws.addRow({
        title: tc.title,
        section: tc.scenario || tc.coverage_type || 'General',
        type: 'Functional',
        priority: this.mapTestRailPriority(tc.priority),
        preconditions: tc.preconditions || '',
        steps: this.formatSteps(tc.steps),
        expected: tc.expected_result,
        automation: tc.automation_ready ? 'Automated' : 'None',
      });
    }
  }

  /* ── Private: Metadata sheet ───────────────────────────────────────────── */
  private buildMetadataSheet(ws: ExcelJS.Worksheet, req: RequirementInfo, testCases: TestCaseRow[]) {
    ws.columns = [
      { header: 'Property', key: 'property', width: 25 },
      { header: 'Value', key: 'value', width: 55 },
    ];
    this.styleHeaderRow(ws);

    const meta = [
      ['Requirement Title', req.title],
      ['Requirement ID', `#${req.id}`],
      ['Description', req.description],
      ['Module', req.module || 'N/A'],
      ['Risk Level', req.risk_level || 'N/A'],
      ['Created', new Date(req.created_at).toLocaleDateString()],
      ['Export Date', new Date().toISOString()],
      ['Total Test Cases', String(testCases.length)],
      ['Unique Coverage Types', String(new Set(testCases.map(tc => tc.coverage_type)).size)],
      ['Automation Ready', String(testCases.filter(tc => tc.automation_ready).length)],
      ['Generated By', 'LevelUp AI QA Platform'],
    ];

    for (const [prop, val] of meta) {
      ws.addRow({ property: prop, value: val });
    }
  }

  /* ── Helpers ───────────────────────────────────────────────────────────── */

  private styleHeaderRow(ws: ExcelJS.Worksheet) {
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: COLORS.headerFont }, size: 11 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.border = {
        bottom: { style: 'thin', color: { argb: COLORS.borderColor } },
      };
    });
  }

  private formatSteps(steps: any): string {
    if (!steps) return '';
    const arr = typeof steps === 'string' ? JSON.parse(steps) : steps;
    if (!Array.isArray(arr)) return String(steps);
    return arr.map((s: any, i: number) => {
      if (typeof s === 'string') return `${i + 1}. ${s}`;
      if (s.action) return `${i + 1}. ${s.action}${s.expected ? ` → ${s.expected}` : ''}`;
      return `${i + 1}. ${JSON.stringify(s)}`;
    }).join('\n');
  }

  private formatTags(tags: any): string {
    if (!tags) return '';
    const arr = typeof tags === 'string' ? JSON.parse(tags) : tags;
    return Array.isArray(arr) ? arr.join(', ') : '';
  }

  // Human-readable source provenance for the export. Mirrors the UI labels so
  // an exported sheet reads the same as the on-screen badges. Empty when the
  // case predates source tagging (legacy rows).
  private formatSource(source?: string): string {
    if (!source) return '';
    const map: Record<string, string> = {
      requirement: 'Requirement',
      knowledge: 'App Knowledge',
      test_data: 'Test Data',
      app_profile: 'App Profile',
      gap_analysis: 'Gap Analysis',
      assumption: '⚠ Assumption-Based',
    };
    return map[source] || source;
  }

  private mapJiraPriority(p: string): string {
    const map: Record<string, string> = { P0: 'Highest', P1: 'High', P2: 'Medium', P3: 'Low' };
    return map[p] || 'Medium';
  }

  private mapTestRailPriority(p: string): string {
    const map: Record<string, string> = { P0: 'Critical', P1: 'High', P2: 'Medium', P3: 'Low' };
    return map[p] || 'Medium';
  }
}
