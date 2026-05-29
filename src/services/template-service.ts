/**
 * Template Service — Manages template versions and generates sample templates.
 *
 * Provides sample Excel / CSV files that show end-users the expected column
 * layout before they upload or review exports.
 */

import { logger } from '../utils/logger';
import {
  ExportFormat,
  TemplateColumn,
  TestCaseTemplateV1,
  TemplateVersionRow,
} from '../types/template';
import { DEFAULT_COLUMNS, exportToExcel, exportToCSV } from './export-service';
import { getActiveTemplateVersion } from '../db/postgres';

const MOD = 'template-service';

/* ========================================================================== */
/*  Sample / demo data used in generated sample templates                     */
/* ========================================================================== */

const SAMPLE_ROWS: TestCaseTemplateV1[] = [
  {
    testCaseId: 'TC-0001',
    scenario: 'Verify successful login with valid credentials',
    priority: 'P1',
    category: 'functional',
    preconditions: 'User account exists and is active',
    testSteps: '1. Open login page\n2. Enter valid username\n3. Enter valid password\n4. Click Login button',
    expectedResult: 'User is redirected to the dashboard',
    testData: 'username: testuser@example.com, password: ••••',
    coverageType: 'functional',
    tags: 'login, authentication, smoke',
    automationStatus: 'Ready',
    createdAt: new Date().toISOString(),
  },
  {
    testCaseId: 'TC-0002',
    scenario: 'Verify error message for invalid credentials',
    priority: 'P1',
    category: 'negative',
    preconditions: 'Login page is accessible',
    testSteps: '1. Open login page\n2. Enter invalid username\n3. Enter invalid password\n4. Click Login button',
    expectedResult: 'Error message "Invalid credentials" is displayed',
    testData: 'username: bad@example.com, password: wrong',
    coverageType: 'negative',
    tags: 'login, negative, validation',
    automationStatus: 'Ready',
    createdAt: new Date().toISOString(),
  },
  {
    testCaseId: 'TC-0003',
    scenario: 'Verify session timeout after inactivity',
    priority: 'P2',
    category: 'security',
    preconditions: 'User is logged in',
    testSteps: '1. Log in successfully\n2. Wait for session timeout period\n3. Attempt to access a protected page',
    expectedResult: 'User is redirected to the login page with a timeout message',
    testData: 'timeout: 30 minutes',
    coverageType: 'coverage_gap',
    tags: 'session, security, timeout',
    automationStatus: 'Manual',
    createdAt: new Date().toISOString(),
  },
];

/* ========================================================================== */
/*  Public API                                                                */
/* ========================================================================== */

/**
 * Generate a sample template file (Excel or CSV) with demo data.
 *
 * Used by the "Download Template" button so users can see the expected format.
 */
export async function generateSampleTemplate(
  format: ExportFormat = 'xlsx',
): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  logger.info(MOD, 'Generating sample template', { format });

  // Try to load active template columns from DB, fall back to defaults
  let columns: TemplateColumn[] = DEFAULT_COLUMNS;
  try {
    const active = await getActiveTemplateVersion();
    if (active && Array.isArray(active.schema)) {
      columns = active.schema;
    }
  } catch (err) {
    logger.warn(MOD, 'Could not load active template version; using defaults', { error: String(err) });
  }

  if (format === 'xlsx') {
    const buffer = await exportToExcel(SAMPLE_ROWS, columns);
    return {
      buffer,
      filename: `test-case-template-sample.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  const buffer = await exportToCSV(SAMPLE_ROWS, columns);
  return {
    buffer,
    filename: `test-case-template-sample.csv`,
    contentType: 'text/csv; charset=utf-8',
  };
}

/**
 * Retrieve the currently active template version from DB.
 *
 * Returns null when no version exists yet (first-run scenario).
 */
export async function getActiveTemplate(): Promise<TemplateVersionRow | null> {
  try {
    return await getActiveTemplateVersion();
  } catch (err) {
    logger.error(MOD, 'Failed to fetch active template version', { error: String(err) });
    return null;
  }
}
