/**
 * EnvironmentService — Phase 1 Foundation
 * =======================================
 * Business-logic layer over the `project_environments` schema. Resolves the
 * effective environment / base URL for a request, validates environment access,
 * and runs lightweight health checks.
 *
 * Follows the repo service convention (cf. RtmService): a class with static-ish
 * helpers backed by the shared DB helpers in `db/postgres`.
 */

import {
  listEnvironments,
  getEnvironment,
  getDefaultEnvironment,
  getEnvironmentByName,
  type ProjectEnvironment,
} from '../db/postgres';
import { logger } from '../utils/logger';

const MOD = 'environment-service';

export interface HealthCheckResult {
  environmentId: number;
  baseUrl: string | null;
  status: 'healthy' | 'unhealthy' | 'unknown';
  httpStatus?: number;
  responseTimeMs?: number;
  checkedAt: string;
  error?: string;
}

export class EnvironmentService {
  /**
   * Resolve the base URL to use for a project, given an optional explicit
   * environment id. Falls back to the project's default environment.
   */
  async getEnvironmentUrl(projectId: number, environmentId?: number | null): Promise<string | null> {
    const env = await this.resolveEnvironment(projectId, environmentId);
    return env?.base_url ?? null;
  }

  /**
   * Resolve the effective environment for a request: the explicit one if valid,
   * otherwise the project default.
   */
  async resolveEnvironment(projectId: number, environmentId?: number | null): Promise<ProjectEnvironment | null> {
    if (environmentId) {
      const env = await getEnvironment(environmentId, projectId);
      if (env && env.is_active) return env;
    }
    return getDefaultEnvironment(projectId);
  }

  async getDefaultEnvironment(projectId: number): Promise<ProjectEnvironment | null> {
    return getDefaultEnvironment(projectId);
  }

  async getEnvironmentByName(projectId: number, name: string): Promise<ProjectEnvironment | null> {
    return getEnvironmentByName(projectId, name);
  }

  async listEnvironments(projectId: number, includeInactive = false): Promise<ProjectEnvironment[]> {
    return listEnvironments(projectId, { includeInactive });
  }

  /**
   * Validate that an environment id belongs to the given project and is active.
   * Returns the environment or null.
   */
  async validateEnvironment(environmentId: number, projectId: number): Promise<ProjectEnvironment | null> {
    const env = await getEnvironment(environmentId, projectId);
    if (!env || !env.is_active) return null;
    return env;
  }

  /**
   * Perform a lightweight HTTP health check against an environment's base URL.
   * Never throws — returns a structured result. Caller persists the outcome.
   */
  async healthCheck(env: ProjectEnvironment, timeoutMs = 8000): Promise<HealthCheckResult> {
    const checkedAt = new Date().toISOString();
    if (!env.base_url) {
      return { environmentId: env.id, baseUrl: null, status: 'unknown', checkedAt, error: 'No base URL configured' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      // HEAD first (cheap); some servers reject HEAD, so fall back to GET.
      let resp: Response;
      try {
        resp = await fetch(env.base_url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
        if (resp.status >= 400) {
          resp = await fetch(env.base_url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
        }
      } catch {
        resp = await fetch(env.base_url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
      }
      const responseTimeMs = Date.now() - startedAt;
      const status: HealthCheckResult['status'] = resp.status < 400 ? 'healthy' : 'unhealthy';
      return { environmentId: env.id, baseUrl: env.base_url, status, httpStatus: resp.status, responseTimeMs, checkedAt };
    } catch (err: any) {
      logger.warn(MOD, 'Health check failed', { environmentId: env.id, error: err?.message });
      return {
        environmentId: env.id,
        baseUrl: env.base_url,
        status: 'unhealthy',
        responseTimeMs: Date.now() - startedAt,
        checkedAt,
        error: err?.name === 'AbortError' ? 'Timed out' : err?.message || 'Request failed',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const environmentService = new EnvironmentService();
