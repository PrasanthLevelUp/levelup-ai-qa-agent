/**
 * HTML Report Generator — creates a comprehensive healing report.
 *
 * CLI: ts-node src/reports/html-report.ts <report-data.json> <output.html>
 */

import * as fs from 'fs';
import { logger } from '../utils/logger';

const MOD = 'html-report';

// ─── Types ─────────────────────────────────────────────────────

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
}

export interface ReportData {
  timestamp: string;
  commitSha: string;
  prUrl?: string;
  siteUrl: string;
  repo: string;
  totalTests: number;
  passed: number;
  failed: number;
  healed: number;
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

// ─── Report Generation ─────────────────────────────────────────

export function generateReport(data: ReportData, outputPath: string): void {
  const ts = data.timestamp;
  const totalTokens = data.healings.reduce((s, h) => s + h.aiTokensUsed, 0);
  const ruleBased = data.healings.filter(h => h.strategy === 'rule_based').length;
  const dbPattern = data.healings.filter(h => h.strategy === 'database_pattern').length;
  const aiReason = data.healings.filter(h => h.strategy === 'ai_reasoning').length;

  const testRows = data.tests.map(t => {
    const cls = t.status === 'passed' ? 'pass' : (t.healed ? 'healed' : 'fail');
    const label = t.healed ? '🔧 healed' : t.status;
    return `<tr class="${cls}">
      <td>${esc(t.testName)}</td><td>${label}</td>
      <td>${t.durationMs}ms</td><td>${esc(t.error.slice(0, 120))}</td></tr>`;
  }).join('\n');

  const healRows = data.healings.map(h => `<tr>
    <td>${esc(h.testName)}</td>
    <td><code>${esc(h.failedLocator)}</code></td>
    <td><code>${esc(h.healedLocator)}</code></td>
    <td>${h.strategy.replace('_', ' ')}</td>
    <td>${h.aiTokensUsed}</td>
    <td>${h.success ? '✅' : '❌'}</td></tr>`).join('\n');

  const hist = data.historicalStats;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Self-Healing Report — ${ts}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f23;color:#e0e0e0;padding:24px}
  .container{max-width:1200px;margin:0 auto}
  h1{color:#00d4ff;border-bottom:2px solid #00d4ff;padding-bottom:12px;margin-bottom:24px;font-size:1.8em}
  h2{color:#ffcc00;margin:28px 0 12px;font-size:1.3em}
  .meta{color:#888;font-size:.85em;margin-bottom:20px}
  .meta a{color:#00d4ff}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0}
  .card{background:#1a1a3e;border-radius:10px;padding:18px;text-align:center;border:1px solid #2a2a5e}
  .card .num{font-size:2.2em;font-weight:700}
  .card .lbl{color:#888;margin-top:4px;font-size:.85em}
  .card.pass .num{color:#27ae60} .card.fail .num{color:#e74c3c}
  .card.heal .num{color:#f39c12} .card.token .num{color:#3498db}
  .strat{display:flex;gap:12px;margin:12px 0}
  .strat-item{background:#1a1a3e;padding:14px;border-radius:8px;flex:1;text-align:center;border:1px solid #2a2a5e}
  .strat-item .cnt{font-size:1.6em;font-weight:700;color:#00d4ff}
  table{width:100%;border-collapse:collapse;background:#1a1a3e;border-radius:10px;overflow:hidden;margin:10px 0 20px;border:1px solid #2a2a5e}
  th{background:#0d0d2b;color:#00d4ff;padding:10px 14px;text-align:left;font-size:.85em;text-transform:uppercase;letter-spacing:.5px}
  td{padding:8px 14px;border-bottom:1px solid #2a2a5e;font-size:.9em}
  tr.pass td:nth-child(2){color:#27ae60;font-weight:600}
  tr.fail td:nth-child(2){color:#e74c3c;font-weight:600}
  tr.healed td:nth-child(2){color:#f39c12;font-weight:600}
  code{background:#0d0d2b;padding:2px 6px;border-radius:3px;font-size:.82em;color:#ff79c6}
  .footer{color:#555;font-size:.8em;margin-top:32px;padding-top:16px;border-top:1px solid #2a2a5e}
</style>
</head>
<body>
<div class="container">
  <h1>🔧 Self-Healing Test Report</h1>
  <div class="meta">
    <strong>Generated:</strong> ${esc(ts)} &nbsp;|&nbsp;
    <strong>Commit:</strong> <code>${esc(data.commitSha)}</code>
    ${data.prUrl ? `&nbsp;|&nbsp; <a href="${esc(data.prUrl)}" target="_blank">View PR</a>` : ''}
  </div>

  <div class="cards">
    <div class="card pass"><div class="num">${data.passed}</div><div class="lbl">Passed</div></div>
    <div class="card fail"><div class="num">${data.failed}</div><div class="lbl">Failed</div></div>
    <div class="card heal"><div class="num">${data.healed}</div><div class="lbl">Healed</div></div>
    <div class="card token"><div class="num">${totalTokens}</div><div class="lbl">AI Tokens</div></div>
  </div>

  <h2>📊 Healing Strategy Breakdown</h2>
  <div class="strat">
    <div class="strat-item"><div class="cnt">${ruleBased}</div><div class="lbl">Rule-Based (0 tokens)</div></div>
    <div class="strat-item"><div class="cnt">${dbPattern}</div><div class="lbl">DB Pattern (0 tokens)</div></div>
    <div class="strat-item"><div class="cnt">${aiReason}</div><div class="lbl">AI Reasoning (${totalTokens} tokens)</div></div>
  </div>

  <h2>🧪 Test Results</h2>
  <table>
    <tr><th>Test</th><th>Status</th><th>Duration</th><th>Error</th></tr>
    ${testRows || '<tr><td colspan="4">All tests passed ✅</td></tr>'}
  </table>

  ${healRows ? `<h2>🔧 Healing Actions</h2>
  <table>
    <tr><th>Test</th><th>Failed Locator</th><th>Healed Locator</th><th>Strategy</th><th>Tokens</th><th>Result</th></tr>
    ${healRows}
  </table>` : ''}

  <h2>📈 Historical Performance</h2>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Total Executions</td><td>${hist.total_executions}</td></tr>
    <tr><td>Total Healings</td><td>${hist.total_healings}</td></tr>
    <tr><td>Healing Success Rate</td><td>${hist.success_rate}</td></tr>
    <tr><td>AI Tokens Used (all time)</td><td>${hist.total_tokens}</td></tr>
    <tr><td>Tokens Saved by Rule/DB</td><td>${hist.tokens_saved}</td></tr>
    <tr><td>Learned Patterns</td><td>${hist.learned_patterns}</td></tr>
  </table>

  <div class="footer">
    LevelUp AI QA Agent &nbsp;|&nbsp; Target: ${esc(data.siteUrl)} &nbsp;|&nbsp; Repo: ${esc(data.repo)}
  </div>
</div>
</body>
</html>`;

  const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
  if (dir) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf-8');
  logger.info(MOD, `Report generated: ${outputPath}`);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// CLI mode
if (require.main === module) {
  const dataFile = process.argv[2];
  const outFile = process.argv[3];
  if (!dataFile || !outFile) {
    console.error('Usage: html-report.ts <report-data.json> <output.html>');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as ReportData;
  generateReport(data, outFile);
}
