/**
 * Diagnostic endpoint - DELETE THIS FILE AFTER TESTING
 * GET /api/diagnostic/providers - Check AI provider configuration
 */
import { Router, type Request, type Response } from 'express';
import { isAnthropicConfigured } from '../../ai/anthropic-client';

export function createDiagnosticRouter(): Router {
  const router = Router();

  router.get('/providers', (_req: Request, res: Response) => {
    const anthConfig = isAnthropicConfigured();
    
    res.json({
      anthropic: {
        configured: anthConfig,
        apiKeySet: !!process.env.ANTHROPIC_API_KEY,
        apiKeyLength: process.env.ANTHROPIC_API_KEY?.length || 0,
        scriptProvider: process.env.SCRIPT_PROVIDER || 'not set',
        testProvider: process.env.TEST_PROVIDER || 'not set',
        scriptModel: process.env.SCRIPT_MODEL || 'not set',
        testModel: process.env.TEST_MODEL || 'not set',
      },
      openai: {
        apiKeySet: !!process.env.OPENAI_API_KEY,
        apiKeyLength: process.env.OPENAI_API_KEY?.length || 0,
      },
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
