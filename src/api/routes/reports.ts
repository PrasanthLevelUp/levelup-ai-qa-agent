/**
 * GET /api/reports/:jobId — Get healing report (JSON or HTML)
 */

import { Router, type Request, type Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { JobQueue } from '../queue/job-queue';
import { getHistoricalStats } from '../../db/postgres';

const router = Router();

export function createReportsRouter(jobQueue: JobQueue): Router {
  // JSON report
  router.get('/:jobId', async (req: Request, res: Response) => {
    const jobId = req.params['jobId'] as string;
    const job = jobQueue.getJob(jobId);

    if (!job) {
      res.status(404).json({ error: 'Not Found', message: `Job not found: ${jobId}` });
      return;
    }

    if (job.status !== 'completed' && job.status !== 'failed') {
      res.json({
        jobId: job.id,
        status: job.status,
        message: 'Job is still in progress. Check back later.',
        progress: job.progress,
      });
      return;
    }

    const cid = (req as any).companyId;
    const stats = await getHistoricalStats(cid);

    res.json({
      jobId: job.id,
      repository: job.repositoryId,
      status: job.status,
      testResults: job.result?.testResults ?? {},
      healingActions: job.result?.healingActions ?? [],
      summary: {
        totalTests: job.result?.totalTests ?? 0,
        failed: job.result?.failed ?? 0,
        healed: job.result?.healed ?? 0,
        strategy: job.result?.strategy ?? 'none',
        tokensUsed: job.result?.tokensUsed ?? 0,
      },
      historicalStats: stats,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: job.error,
    });
  });

  // HTML report
  router.get('/:jobId/html', (req: Request, res: Response) => {
    const jobId = req.params['jobId'] as string;
    const job = jobQueue.getJob(jobId);

    if (!job) {
      res.status(404).json({ error: 'Not Found', message: `Job not found: ${jobId}` });
      return;
    }

    // Check if an HTML report file was generated
    const reportDir = process.env['REPORT_DIR'] || '/home/ubuntu/healing_reports';
    const htmlReportPath = job.result?.reportPath;

    if (htmlReportPath && fs.existsSync(htmlReportPath)) {
      const html = fs.readFileSync(htmlReportPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
      return;
    }

    // Fallback: check for latest report
    const latestReportData = path.join(reportDir, 'latest-report-data.json');
    if (fs.existsSync(latestReportData)) {
      // Generate simple HTML from data
      const data = JSON.parse(fs.readFileSync(latestReportData, 'utf-8'));
      res.setHeader('Content-Type', 'text/html');
      res.send(generateSimpleHtml(data, jobId));
      return;
    }

    res.status(404).json({
      error: 'Not Found',
      message: 'HTML report not available yet.',
    });
  });

  return router;
}

function generateSimpleHtml(data: any, jobId: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Healing Report - ${jobId}</title>
<style>
body{font-family:Arial,sans-serif;margin:24px;color:#1f2937}
h1{color:#2563eb}
.card{display:inline-block;border:1px solid #d1d5db;border-radius:8px;padding:12px 20px;margin:6px;text-align:center}
.card h3{margin:0;font-size:12px;color:#6b7280}.card .v{font-size:22px;font-weight:bold}
table{width:100%;border-collapse:collapse;margin-top:16px}
th,td{border:1px solid #e5e7eb;padding:8px;font-size:13px;text-align:left}
th{background:#f3f4f6}
</style></head>
<body>
<h1>🔧 Healing Report — ${jobId}</h1>
<p><strong>Timestamp:</strong> ${data.timestamp || 'N/A'}</p>
<p><strong>Repository:</strong> ${data.repo || 'N/A'}</p>
<div>
  <div class="card"><h3>Total Tests</h3><div class="v">${data.totalTests || 0}</div></div>
  <div class="card"><h3>Passed</h3><div class="v">${data.passed || 0}</div></div>
  <div class="card"><h3>Failed</h3><div class="v">${data.failed || 0}</div></div>
  <div class="card"><h3>Healed</h3><div class="v">${data.healed || 0}</div></div>
</div>
</body></html>`;
}
