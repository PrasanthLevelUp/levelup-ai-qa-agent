/**
 * ContextService — Phase 1 Foundation
 * ===================================
 * Persists and resolves a user's per-project working context (selected
 * environment, sprint, time range). Provides a single `resolveContext` entry
 * point that fills sensible defaults (default environment + current sprint)
 * when the user hasn't made an explicit selection.
 */

import {
  getUserProjectContext,
  upsertUserProjectContext,
  getDefaultEnvironment,
  getCurrentSprint,
  getEnvironment,
  getSprint,
  type ProjectEnvironment,
  type ProjectSprint,
} from '../db/postgres';
import { logger } from '../utils/logger';

const MOD = 'context-service';

export interface ResolvedContext {
  projectId: number;
  environment: ProjectEnvironment | null;
  sprint: ProjectSprint | null;
  timeRange: string | null;
  timeRangeStart: string | null;
  timeRangeEnd: string | null;
  preferences: Record<string, any>;
}

export class ContextService {
  async getContext(userId: number, projectId: number): Promise<any | null> {
    return getUserProjectContext(userId, projectId);
  }

  async saveContext(data: {
    companyId?: number | null;
    userId: number;
    projectId: number;
    environmentId?: number | null;
    sprintId?: number | null;
    timeRange?: string | null;
    timeRangeStart?: string | null;
    timeRangeEnd?: string | null;
    preferences?: any;
  }): Promise<any> {
    return upsertUserProjectContext({
      company_id: data.companyId ?? null,
      user_id: data.userId,
      project_id: data.projectId,
      environment_id: data.environmentId ?? null,
      sprint_id: data.sprintId ?? null,
      time_range: data.timeRange ?? null,
      time_range_start: data.timeRangeStart ?? null,
      time_range_end: data.timeRangeEnd ?? null,
      preferences: data.preferences ?? null,
    });
  }

  /**
   * Resolve the effective context for a user+project: honour explicitly saved
   * selections (when still valid/active), otherwise fall back to the project
   * default environment and current sprint.
   */
  async resolveContext(userId: number, projectId: number): Promise<ResolvedContext> {
    const saved = await getUserProjectContext(userId, projectId).catch(() => null);

    let environment: ProjectEnvironment | null = null;
    if (saved?.environment_id) {
      environment = await getEnvironment(saved.environment_id, projectId).catch(() => null);
      if (environment && !environment.is_active) environment = null;
    }
    if (!environment) environment = await getDefaultEnvironment(projectId).catch(() => null);

    let sprint: ProjectSprint | null = null;
    if (saved?.sprint_id) {
      sprint = await getSprint(saved.sprint_id, projectId).catch(() => null);
    }
    if (!sprint) sprint = await getCurrentSprint(projectId).catch(() => null);

    return {
      projectId,
      environment,
      sprint,
      timeRange: saved?.time_range ?? null,
      timeRangeStart: saved?.time_range_start ?? null,
      timeRangeEnd: saved?.time_range_end ?? null,
      preferences: saved?.preferences ?? {},
    };
  }
}

export const contextService = new ContextService();
