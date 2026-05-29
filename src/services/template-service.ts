/**
 * Template Service
 * Generates sample test case templates for download in Excel and CSV formats.
 */

import ExcelJS from 'exceljs';
import { format as csvFormat } from '@fast-csv/format';

const SAMPLE_DATA = [
  {
    scenario: 'User Login with Valid Credentials',
    coverageType: 'Functional',
    priority: 'High',
    riskArea: 'Authentication',
    title: 'Verify successful login with valid email and password',
    preconditions: 'User account exists and is active',
    steps: [
      { step: 1, action: 'Navigate to login page', expected: 'Login form is displayed' },
      { step: 2, action: 'Enter valid email', expected: 'Email field accepts input' },
      { step: 3, action: 'Enter valid password', expected: 'Password field accepts input (masked)' },
      { step: 4, action: 'Click Login button', expected: 'User is redirected to dashboard' },
    ],
    expectedResult: 'User is authenticated and redirected to the main dashboard',
    testData: 'Email: test@example.com, Password: Test@1234',
    severity: 'Critical',
    tags: ['login', 'authentication', 'smoke'],
    automationReady: true,
  },
  {
    scenario: 'User Login with Invalid Credentials',
    coverageType: 'Negative',
    priority: 'High',
    riskArea: 'Authentication',
    title: 'Verify error message for invalid password',
    preconditions: 'User account exists and is active',
    steps: [
      { step: 1, action: 'Navigate to login page', expected: 'Login form is displayed' },
      { step: 2, action: 'Enter valid email', expected: 'Email field accepts input' },
      { step: 3, action: 'Enter invalid password', expected: 'Password field accepts input' },
      { step: 4, action: 'Click Login button', expected: 'Error message is displayed' },
    ],
    expectedResult: 'Error message "Invalid credentials" is displayed, user remains on login page',
    testData: 'Email: test@example.com, Password: WrongPass',
    severity: 'Major',
    tags: ['login', 'negative', 'security'],
    automationReady: true,
  },
  {
    scenario: 'Search Functionality',
    coverageType: 'Functional',
    priority: 'Medium',
    riskArea: 'Search',
    title: 'Verify search returns relevant results',
    preconditions: 'User is logged in, test data exists in the system',
    steps: [
      { step: 1, action: 'Click on search bar', expected: 'Search bar is focused' },
      { step: 2, action: 'Type search keyword', expected: 'Search suggestions appear' },
      { step: 3, action: 'Press Enter', expected: 'Search results page loads' },
    ],
    expectedResult: 'Results matching the search keyword are displayed with relevant ranking',
    testData: 'Search keyword: "test report"',
    severity: 'Major',
    tags: ['search', 'functional'],
    automationReady: false,
  },
];

const STANDARD_HEADERS = [
  'Scenario',
  'Coverage Type',
  'Priority',
  'Risk Area',
  'Test Case Title',
  'Preconditions',
  'Steps',
  'Expected Result',
  'Test Data',
  'Severity',
  'Tags',
  'Automation Ready',
];

export class TemplateService {
  /**
   * Generate a sample test case template in Excel format.
   */
  static async generateExcelTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'LevelUp AI QA Agent';
    workbook.created = new Date();

    // --- Test Cases Sheet ---
    const sheet = workbook.addWorksheet('Test Cases', {
      properties: { defaultColWidth: 20 },
    });

    // Header row
    sheet.addRow(STANDARD_HEADERS);
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF6D28D9' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.height = 30;

    // Sample data rows
    for (const item of SAMPLE_DATA) {
      const stepsText = item.steps
        .map((s) => `${s.step}. ${s.action} → ${s.expected}`)
        .join('\n');

      sheet.addRow([
        item.scenario,
        item.coverageType,
        item.priority,
        item.riskArea,
        item.title,
        item.preconditions,
        stepsText,
        item.expectedResult,
        item.testData,
        item.severity,
        item.tags.join(', '),
        item.automationReady ? 'Yes' : 'No',
      ]);
    }

    // Style data rows
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      row.alignment = { vertical: 'top', wrapText: true };
      row.height = 60;
    }

    // Column widths
    const widths = [30, 15, 12, 18, 35, 25, 50, 35, 25, 12, 25, 15];
    widths.forEach((w, i) => {
      sheet.getColumn(i + 1).width = w;
    });

    // Auto-filter
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: STANDARD_HEADERS.length },
    };

    // Freeze header
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    // --- Instructions Sheet ---
    const instrSheet = workbook.addWorksheet('Instructions');
    instrSheet.getColumn(1).width = 25;
    instrSheet.getColumn(2).width = 80;

    const instrTitle = instrSheet.addRow(['LevelUp AI QA Agent — Test Case Template']);
    instrTitle.font = { bold: true, size: 14, color: { argb: 'FF6D28D9' } };
    instrSheet.mergeCells('A1:B1');

    instrSheet.addRow([]);
    const instructions = [
      ['Column', 'Description'],
      ['Scenario', 'The test scenario name or group this test case belongs to'],
      ['Coverage Type', 'Type of coverage: Functional, Negative, Edge Case, Performance, Security, etc.'],
      ['Priority', 'Execution priority: Critical, High, Medium, Low'],
      ['Risk Area', 'The functional area or risk category being tested'],
      ['Test Case Title', 'A clear, descriptive title for the test case'],
      ['Preconditions', 'Any prerequisites that must be met before executing the test'],
      ['Steps', 'Numbered steps with actions and expected outcomes (use format: 1. Action → Expected)'],
      ['Expected Result', 'The overall expected outcome after completing all steps'],
      ['Test Data', 'Any specific data needed to execute the test'],
      ['Severity', 'Impact severity: Critical, Major, Minor, Trivial'],
      ['Tags', 'Comma-separated tags for categorization and filtering'],
      ['Automation Ready', 'Whether the test case is suitable for automation (Yes/No)'],
    ];

    for (const [col1, col2] of instructions) {
      const row = instrSheet.addRow([col1, col2]);
      if (col1 === 'Column') {
        row.font = { bold: true };
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE8E0F5' },
        };
      }
      row.alignment = { wrapText: true };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /**
   * Generate a sample test case template in CSV format.
   */
  static async generateCSVTemplate(): Promise<string> {
    return new Promise((resolve, reject) => {
      const rows: string[] = [];
      const stream = csvFormat({ headers: true });

      stream.on('data', (chunk: Buffer) => rows.push(chunk.toString()));
      stream.on('end', () => resolve(rows.join('')));
      stream.on('error', reject);

      for (const item of SAMPLE_DATA) {
        const stepsText = item.steps
          .map((s) => `${s.step}. ${s.action} -> ${s.expected}`)
          .join(' | ');

        stream.write({
          Scenario: item.scenario,
          'Coverage Type': item.coverageType,
          Priority: item.priority,
          'Risk Area': item.riskArea,
          'Test Case Title': item.title,
          Preconditions: item.preconditions,
          Steps: stepsText,
          'Expected Result': item.expectedResult,
          'Test Data': item.testData,
          Severity: item.severity,
          Tags: item.tags.join(', '),
          'Automation Ready': item.automationReady ? 'Yes' : 'No',
        });
      }

      stream.end();
    });
  }
}
