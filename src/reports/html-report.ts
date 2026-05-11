/**
 * HTML report generator for refined orchestrator flow.
 */

import * as fs from 'fs';
import { logger } from '../utils/logger';

const MOD = 'html-report';

export interface ReportTest {
  testName: string;
  status: string;
  durationMs: number;
  error: string;
  healed: boolean;
}

export interface ReportHealing {
  testName: string;
  failedLocator: string;
  healedLocator: string;
  strategy: string;
  aiTokensUsed: number;
  success: boolean;
  confidence: number;
  validated: boolean;
  validationReason?: string;
  patchPath?: string;
}

export interface ReportData {
  timestamp: string;
  commitSha: string;
  repo: string;
  siteUrl: string;
  totalTests: number;
  passed: number;
  failed: number;
  healed: number;
  validationRejected: number;
  patchesGenerated: number;
  totalTokensUsed: number;
  tests: ReportTest[];
  healings: ReportHealing[];
  historicalStats: {
    total_executions: number;
    total_healings: number;
    success_rate: string;
    total_tokens: number;
    tokens_saved: string;
    learned_patterns: number;
    strategy_breakdown: { rule_based: number; database_pattern: number; ai_reasoning: number };
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;');
}

export function generateReport(data: ReportData, outputPath: string): void {
  const healRows = data.healings.map((h) => `
    <tr>
      <td>${esc(h.testName)}</td>
      <td><code>${esc(h.failedLocator)}</code></td>
      <td><code>${esc(h.healedLocator)}</code></td>
      <td>${esc(h.strategy)}</td>
      <td>${h.aiTokensUsed}</td>
      <td>${h.confidence.toFixed(2)}</td>
      <td>${h.validated ? '✅' : '❌'}</td>
      <td>${h.success ? '✅' : '❌'}</td>
      <td>${esc(h.patchPath || '-')}</td>
    </tr>
  `).join('');

  const testRows = data.tests.map((t) => `
    <tr>
      <td>${esc(t.testName)}</td>
      <td>${esc(t.status)}</td>
      <td>${t.durationMs}</td>
      <td>${t.healed ? '✅' : '—'}</td>
      <td>${esc(t.error.slice(0, 160))}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Refined AI QA Agent Report</title>
<style>
body { font-family: Arial, sans-serif; margin: 24px; color: #1f2937; }
h1, h2 { margin-bottom: 8px; }
.cards { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 12px; margin: 16px 0; }
.card { border: 1px solid #d1d5db; border-radius: 10px; padding: 12px; }
.card h3 { margin: 0; font-size: 13px; color: #4b5563; }
.card .v { font-size: 24px; font-weight: bold; margin-top: 6px; }
table { width: 100%; border-collapse: collapse; margin-top: 10px; }
th, td { border: 1px solid #e5e7eb; padding: 8px; font-size: 13px; text-align: left; vertical-align: top; }
th { background: #f3f4f6; }
code { background: #f9fafb; padding: 2px 4px; border-radius: 4px; }
.meta { color: #6b7280; margin-bottom: 16px; }
</style>
</head>
<body>
  <h1>🔧 Refined AI QA Agent Report</h1>
  <div class="meta">
    <strong>Timestamp:</strong> ${esc(data.timestamp)}<br/>
    <strong>Repo:</strong> ${esc(data.repo)}<br/>
    <strong>Site:</strong> ${esc(data.siteUrl)}<br/>
    <strong>Commit:</strong> <code>${esc(data.commitSha)}</code>
  </div>

  <div class="cards">
    <div class="card"><h3>Passed</h3><div class="v">${data.passed}</div></div>
    <div class="card"><h3>Failed</h3><div class="v">${data.failed}</div></div>
    <div class="card"><h3>Healed</h3><div class="v">${data.healed}</div></div>
    <div class="card"><h3>Validation Rejected</h3><div class="v">${data.validationRejected}</div></div>
    <div class="card"><h3>Patches Generated</h3><div class="v">${data.patchesGenerated}</div></div>
  </div>

  <div class="cards">
    <div class="card"><h3>Total AI Tokens</h3><div class="v">${data.totalTokensUsed}</div></div>
    <div class="card"><h3>Historical Success</h3><div class="v">${esc(data.historicalStats.success_rate)}</div></div>
    <div class="card"><h3>Rule-Based</h3><div class="v">${data.historicalStats.strategy_breakdown.rule_based}</div></div>
    <div class="card"><h3>Pattern</h3><div class="v">${data.historicalStats.strategy_breakdown.database_pattern}</div></div>
    <div class="card"><h3>AI</h3><div class="v">${data.historicalStats.strategy_breakdown.ai_reasoning}</div></div>
  </div>

  <h2>Test Results</h2>
  <table>
    <tr><th>Test</th><th>Status</th><th>Duration(ms)</th><th>Healed</th><th>Error</th></tr>
    ${testRows || '<tr><td colspan="5">No test rows</td></tr>'}
  </table>

  <h2>Healing Actions</h2>
  <table>
    <tr><th>Test</th><th>Failed Locator</th><th>Healed Locator</th><th>Strategy</th><th>Tokens</th><th>Confidence</th><th>Validated</th><th>Success</th><th>Patch</th></tr>
    ${healRows || '<tr><td colspan="9">No healing actions</td></tr>'}
  </table>
</body>
</html>`;

  fs.mkdirSync(outputPath.substring(0, outputPath.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf-8');
  logger.info(MOD, 'Report generated', { outputPath });
}
