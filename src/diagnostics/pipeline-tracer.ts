/**
 * Pipeline Behavioral Tracer — regression investigation instrumentation
 * 
 * This module instruments the healing pipeline to log input/output/duration/
 * decision/reason at each stage, enabling behavioral bisect investigation.
 * 
 * Usage: Import and call trace functions at stage boundaries.
 * 
 * DO NOT MERGE - DIAGNOSTIC ONLY
 */

import { logger } from '../utils/logger';

const MOD = 'pipeline-tracer';

interface StageTrace {
  stage: string;
  input: any;
  output: any;
  decision?: string;
  reason?: string;
  durationMs: number;
  timestamp: string;
}

const traces: StageTrace[] = [];

export function traceStage<T>(
  stage: string,
  input: any,
  fn: () => T,
  extractDecision?: (result: T) => { decision?: string; reason?: string }
): T {
  const start = Date.now();
  const timestamp = new Date().toISOString();
  
  try {
    const output = fn();
    const durationMs = Date.now() - start;
    
    const decision = extractDecision?.(output);
    
    const trace: StageTrace = {
      stage,
      input: sanitizeForLog(input),
      output: sanitizeForLog(output),
      decision: decision?.decision,
      reason: decision?.reason,
      durationMs,
      timestamp,
    };
    
    traces.push(trace);
    
    logger.info(MOD, `STAGE: ${stage}`, {
      durationMs,
      decision: decision?.decision,
      reason: decision?.reason,
      inputKeys: typeof input === 'object' ? Object.keys(input) : typeof input,
      outputKeys: typeof output === 'object' ? Object.keys(output as any) : typeof output,
    });
    
    return output;
  } catch (error) {
    const durationMs = Date.now() - start;
    logger.error(MOD, `STAGE: ${stage} FAILED`, {
      durationMs,
      error: (error as Error).message,
      stack: (error as Error).stack,
    });
    throw error;
  }
}

export async function traceStageAsync<T>(
  stage: string,
  input: any,
  fn: () => Promise<T>,
  extractDecision?: (result: T) => { decision?: string; reason?: string }
): Promise<T> {
  const start = Date.now();
  const timestamp = new Date().toISOString();
  
  try {
    const output = await fn();
    const durationMs = Date.now() - start;
    
    const decision = extractDecision?.(output);
    
    const trace: StageTrace = {
      stage,
      input: sanitizeForLog(input),
      output: sanitizeForLog(output),
      decision: decision?.decision,
      reason: decision?.reason,
      durationMs,
      timestamp,
    };
    
    traces.push(trace);
    
    logger.info(MOD, `STAGE: ${stage}`, {
      durationMs,
      decision: decision?.decision,
      reason: decision?.reason,
      inputKeys: typeof input === 'object' ? Object.keys(input) : typeof input,
      outputKeys: typeof output === 'object' ? Object.keys(output as any) : typeof output,
    });
    
    return output;
  } catch (error) {
    const durationMs = Date.now() - start;
    logger.error(MOD, `STAGE: ${stage} FAILED`, {
      durationMs,
      error: (error as Error).message,
      stack: (error as Error).stack,
    });
    throw error;
  }
}

function sanitizeForLog(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj.length > 200 ? obj.slice(0, 200) + '...' : obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return { _type: 'array', length: obj.length, sample: obj.slice(0, 2) };
  if (typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, val] of Object.entries(obj)) {
      if (key === 'stdout' || key === 'stderr' || key === 'content') {
        sanitized[key] = typeof val === 'string' ? `<${val.length} bytes>` : val;
      } else {
        sanitized[key] = val;
      }
    }
    return sanitized;
  }
  return String(obj);
}

export function getTraces(): StageTrace[] {
  return [...traces];
}

export function clearTraces(): void {
  traces.length = 0;
}

export function dumpTraces(): void {
  logger.info(MOD, '========== PIPELINE TRACE DUMP ==========');
  traces.forEach((t, i) => {
    logger.info(MOD, `[${i + 1}] ${t.stage}`, {
      timestamp: t.timestamp,
      durationMs: t.durationMs,
      decision: t.decision,
      reason: t.reason,
      input: t.input,
      output: t.output,
    });
  });
  logger.info(MOD, '========================================');
}
