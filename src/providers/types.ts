/**
 * Unified Failure Schema — the foundation of the Intelligence Layer.
 * Every provider adapter normalizes into this format.
 */

export interface UnifiedTestResult {
  testName: string;
  suiteName?: string;
  filePath?: string;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'flaky';
  duration?: number; // ms
  errorMessage?: string;
  errorPattern?: string;
  stackTrace?: string;
  failedLocator?: string;
  lineNumber?: number;
  failedLineCode?: string;
  url?: string; // page URL during failure
  screenshotUrl?: string;
  videoUrl?: string;
  traceUrl?: string;
  logs?: string;
  retries?: number;
  // Metadata
  browser?: string;
  os?: string;
  tags?: string[];
}

export interface IngestPayload {
  provider: ProviderType;
  repoUrl?: string;
  repoName?: string;
  branch?: string;
  commit?: string;
  buildId?: string;
  buildUrl?: string;
  triggerSource?: string; // 'ci', 'webhook', 'manual', 'api'
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  totalDuration?: number; // ms
  timestamp: string; // ISO 8601
  results: UnifiedTestResult[];
  rawPayload?: any; // original data for debugging
}

export type ProviderType =
  | 'playwright'
  | 'junit'
  | 'browserstack'
  | 'lambdatest'
  | 'cypress'
  | 'allure'
  | 'generic';

export interface ProviderAdapter {
  readonly providerType: ProviderType;
  /**
   * Check if this adapter can handle the given raw data.
   */
  canHandle(data: any): boolean;
  /**
   * Parse raw provider data into the unified format.
   */
  parse(data: any, meta?: Record<string, any>): IngestPayload;
}

/**
 * Ingestion record stored in DB for tracking.
 */
export interface IngestionRecord {
  id?: number;
  companyId: number;
  provider: ProviderType;
  buildId?: string;
  repoUrl?: string;
  branch?: string;
  commit?: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  status: 'received' | 'processing' | 'completed' | 'failed';
  healingJobId?: string;
  errorMessage?: string;
  createdAt?: string;
  completedAt?: string;
}
