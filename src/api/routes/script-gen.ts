/**
 * Script Generation API Routes
 *
 * POST /api/scripts/generate          — Generate test scripts for a URL
 * GET  /api/scripts/recent             — List recent generations
 * GET  /api/scripts/:id                — Get specific generated script
 * POST /api/scripts/:id/review         — Trigger AI review on existing generation
 * POST /api/scripts/:id/export         — Export as project directory
 */

import { Router, type Request, type Response } from 'express';
import {
  logGeneratedScript,
  getGeneratedScript,
  getRecentScripts,
  updateScriptReview,
  logDomSnapshot,
  logSelectorScores,
  logWorkflowMaps,
  logProjectExport,
} from '../../db/postgres';
import { ScriptGenEngine, type GenerationConfig, type GenerationResult, type GeneratedFile } from '../../script-gen/script-gen-engine';
import { AIReviewEngine } from '../../script-gen/ai-review-engine';
import { ValidationRunner } from '../../script-gen/validation-runner';
import { ProjectExportEngine } from '../../script-gen/project-export-engine';
import * as path from 'path';
import * as os from 'os';

export function createScriptGenRouter(): Router {
  const router = Router();

  /* ── Generate Test Scripts ──────────────────────────────── */
  router.post('/generate', async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
      const {
        url,
        instructions,
        testTypes,
        credentials,
        includeNegativeTests,
        followLinks,
        maxPages,
      } = req.body;

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, error: 'url is required' });
      }

      console.log(`[ScriptGen] Starting generation for: ${url}`);

      const config: GenerationConfig = {
        url,
        instructions: instructions || undefined,
        testTypes: testTypes || ['smoke', 'functional'],
        credentials: credentials || undefined,
        includeNegativeTests: includeNegativeTests ?? true,
        followLinks: followLinks ?? false,
        maxPages: maxPages ?? 3,
      };

      const engine = new ScriptGenEngine();
      const result: GenerationResult = await engine.generate(config);

      const generationTimeMs = Date.now() - startTime;

      // Run validation
      const validator = new ValidationRunner();
      const validationReport = validator.validate(result.generatedFiles, result.testPlan);

      // Determine validation status
      const validationStatus = validationReport.overallScore >= 80 ? 'passed' : 'needs_review';

      // Persist to DB
      const scriptId = await logGeneratedScript({
        url: config.url,
        page_type: result.testPlan?.pageType || 'unknown',
        workflow_graph: null,
        instructions: config.instructions,
        script_content: result.generatedFiles.map((f: GeneratedFile) => `// === ${f.path} ===\n${f.content}`).join('\n\n'),
        test_plan: result.testPlan,
        validation_status: validationStatus,
        reliability_score: validationReport.overallScore,
        tokens_used: result.stats.tokensUsed,
        model: result.stats.model,
        generation_time_ms: generationTimeMs,
        files_generated: result.generatedFiles.map((f: GeneratedFile) => ({ path: f.path, size: f.content.length, type: f.type })),
        negative_tests_included: config.includeNegativeTests,
      });

      console.log(`[ScriptGen] ✅ Generation complete — ID ${scriptId}, ${result.generatedFiles.length} files, ${generationTimeMs}ms`);

      res.json({
        success: true,
        data: {
          id: scriptId,
          url: config.url,
          filesGenerated: result.generatedFiles.length,
          files: result.generatedFiles.map((f: GeneratedFile) => ({ path: f.path, size: f.content.length, type: f.type })),
          testPlan: result.testPlan,
          validationReport,
          stats: result.stats,
          generationTimeMs,
          errors: result.errors,
        },
      });
    } catch (err: any) {
      console.error('[ScriptGen] Generation error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Recent Generations ─────────────────────────────────── */
  router.get('/recent', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const scripts = await getRecentScripts(limit);
      res.json({ success: true, data: scripts, count: scripts.length });
    } catch (err: any) {
      console.error('[ScriptGen] recent error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Get Specific Script ────────────────────────────────── */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script ID' });
      }
      const script = await getGeneratedScript(id);
      if (!script) {
        return res.status(404).json({ success: false, error: 'Script not found' });
      }
      res.json({ success: true, data: script });
    } catch (err: any) {
      console.error('[ScriptGen] get error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── AI Review ──────────────────────────────────────────── */
  router.post('/:id/review', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script ID' });
      }

      const script = await getGeneratedScript(id);
      if (!script) {
        return res.status(404).json({ success: false, error: 'Script not found' });
      }

      if (!script.files_generated) {
        return res.status(400).json({ success: false, error: 'No files to review' });
      }

      console.log(`[ScriptGen] Running AI review on script #${id}`);

      // Reconstruct GeneratedFile[] from stored data
      const filesInfo = script.files_generated as Array<{ path: string; size: number; type: string }>;
      const scriptContent = script.script_content || '';
      const chunks = scriptContent.split('\n// === ').filter(Boolean);
      const generatedFiles: GeneratedFile[] = chunks.map((chunk: string, i: number) => {
        const firstNewline = chunk.indexOf('\n');
        const filePath = chunk.substring(0, firstNewline).replace(' ===', '').trim();
        const content = chunk.substring(firstNewline + 1);
        const fileType = (filesInfo[i]?.type || 'test') as GeneratedFile['type'];
        return { path: filePath, content, type: fileType };
      });

      const reviewer = new AIReviewEngine();
      const reviewResult = await reviewer.review(generatedFiles, script.test_plan || undefined);

      // Persist review results
      await updateScriptReview(id, reviewResult.score, reviewResult.issues);

      res.json({
        success: true,
        data: {
          scriptId: id,
          score: reviewResult.score,
          criticalCount: reviewResult.criticalCount,
          warningCount: reviewResult.warningCount,
          infoCount: reviewResult.infoCount,
          issueCount: reviewResult.issues.length,
          issues: reviewResult.issues,
          reviewTimeMs: reviewResult.reviewTimeMs,
          tokensUsed: reviewResult.tokensUsed,
        },
      });
    } catch (err: any) {
      console.error('[ScriptGen] review error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Export Project ─────────────────────────────────────── */
  router.post('/:id/export', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script ID' });
      }

      const script = await getGeneratedScript(id);
      if (!script) {
        return res.status(404).json({ success: false, error: 'Script not found' });
      }

      if (!script.files_generated) {
        return res.status(400).json({ success: false, error: 'No files to export' });
      }

      console.log(`[ScriptGen] Exporting project for script #${id}`);

      // Reconstruct GeneratedFile[] from stored content
      const filesInfo = script.files_generated as Array<{ path: string; size: number; type: string }>;
      const scriptContent = script.script_content || '';
      const chunks = scriptContent.split('\n// === ').filter(Boolean);
      const generatedFiles: GeneratedFile[] = chunks.map((chunk: string, i: number) => {
        const firstNewline = chunk.indexOf('\n');
        const filePath = chunk.substring(0, firstNewline).replace(' ===', '').trim();
        const content = chunk.substring(firstNewline + 1);
        const fileType = (filesInfo[i]?.type || 'test') as GeneratedFile['type'];
        return { path: filePath, content, type: fileType };
      });

      const exporter = new ProjectExportEngine();
      const outputDir = path.join(os.tmpdir(), `levelup-export-${id}-${Date.now()}`);

      const fakeResult: GenerationResult = {
        testPlan: script.test_plan || { name: 'export', description: '', baseUrl: script.url, pageType: 'unknown', flows: [], fixtures: [], pageObjects: [], metadata: { generatedAt: '', crawlTimeMs: 0, totalElements: 0, selectorQuality: 0, model: 'unknown', tokensUsed: 0 } },
        generatedFiles,
        stats: {
          totalTests: 0,
          totalAssertions: 0,
          avgSelectorScore: 0,
          pageObjectsGenerated: 0,
          crawlTimeMs: 0,
          generationTimeMs: 0,
          tokensUsed: 0,
          model: 'unknown',
        },
        errors: [],
      };

      const exportResult = exporter.exportProject(fakeResult, outputDir);

      // Persist export
      await logProjectExport({
        script_id: id,
        project_dir: exportResult.projectDir,
        file_count: exportResult.fileCount,
        total_size: exportResult.totalSize,
        structure: exportResult.structure,
      });

      res.json({
        success: true,
        data: {
          scriptId: id,
          projectDir: exportResult.projectDir,
          fileCount: exportResult.fileCount,
          totalSize: exportResult.totalSize,
          structure: exportResult.structure,
        },
      });
    } catch (err: any) {
      console.error('[ScriptGen] export error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
