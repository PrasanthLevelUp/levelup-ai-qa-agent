/**
 * SprintService — Phase 1 Foundation
 * ==================================
 * Business-logic layer over the `project_sprints` schema: current-sprint
 * resolution, progress computation, sprint roll-over (create-next), completion
 * and metrics aggregation.
 */

import { getPool } from '../db/postgres';
import {
  listSprints,
  getSprint,
  getCurrentSprint,
  createSprint,
  completeSprint as dbCompleteSprint,
  activateSprint,
  getSprintMetrics,
  type ProjectSprint,
} from '../db/postgres';
import { logger } from '../utils/logger';

const MOD = 'sprint-service';

export interface SprintProgress {
  sprintId: number;
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  totalDays: number | null;
  elapsedDays: number | null;
  remainingDays: number | null;
  percentComplete: number | null;
  isOverdue: boolean;
}

interface ProjectSprintSettings {
  sprintDurationWeeks: number;
  autoCreateSprints: boolean;
  sprintNamingPattern: string;
}

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

export class SprintService {
  async getCurrentSprint(projectId: number): Promise<ProjectSprint | null> {
    return getCurrentSprint(projectId);
  }

  async listSprints(projectId: number, opts: { status?: string; limit?: number } = {}): Promise<ProjectSprint[]> {
    return listSprints(projectId, opts);
  }

  async getSprintMetrics(sprintId: number, projectId: number) {
    return getSprintMetrics(sprintId, projectId);
  }

  /** Compute time-based progress for a sprint. */
  computeProgress(sprint: ProjectSprint): SprintProgress {
    const base: SprintProgress = {
      sprintId: sprint.id,
      name: sprint.name,
      status: sprint.status,
      startDate: sprint.start_date,
      endDate: sprint.end_date,
      totalDays: null,
      elapsedDays: null,
      remainingDays: null,
      percentComplete: null,
      isOverdue: false,
    };
    if (!sprint.start_date || !sprint.end_date) return base;
    const start = new Date(sprint.start_date);
    const end = new Date(sprint.end_date);
    const today = new Date();
    const totalDays = Math.max(1, daysBetween(start, end));
    const elapsed = Math.min(totalDays, Math.max(0, daysBetween(start, today)));
    const remaining = Math.max(0, daysBetween(today, end));
    const percent = Math.min(100, Math.max(0, Math.round((elapsed / totalDays) * 100)));
    return {
      ...base,
      totalDays,
      elapsedDays: elapsed,
      remainingDays: remaining,
      percentComplete: percent,
      isOverdue: today > end && sprint.status !== 'completed',
    };
  }

  async getSprintProgress(projectId: number, sprintId?: number): Promise<SprintProgress | null> {
    const sprint = sprintId ? await getSprint(sprintId, projectId) : await getCurrentSprint(projectId);
    if (!sprint) return null;
    return this.computeProgress(sprint);
  }

  /** Read project-level sprint settings with sensible defaults. */
  async getProjectSprintSettings(projectId: number): Promise<ProjectSprintSettings> {
    const defaults: ProjectSprintSettings = {
      sprintDurationWeeks: 2,
      autoCreateSprints: false,
      sprintNamingPattern: 'Sprint {n}',
    };
    try {
      const { rows } = await getPool().query(
        `SELECT sprint_duration_weeks, auto_create_sprints, sprint_naming_pattern
           FROM projects WHERE id = $1`,
        [projectId],
      );
      const r = rows[0];
      if (!r) return defaults;
      return {
        sprintDurationWeeks: r.sprint_duration_weeks ?? defaults.sprintDurationWeeks,
        autoCreateSprints: r.auto_create_sprints ?? defaults.autoCreateSprints,
        sprintNamingPattern: r.sprint_naming_pattern ?? defaults.sprintNamingPattern,
      };
    } catch (err: any) {
      logger.warn(MOD, 'Failed to read project sprint settings, using defaults', { projectId, error: err?.message });
      return defaults;
    }
  }

  /**
   * Create the next sprint for a project. Computes start/end dates from the
   * previous sprint (or today) using the configured duration, derives the name
   * from the naming pattern, and optionally activates it as the current sprint.
   */
  async createNextSprint(
    projectId: number,
    opts: { companyId?: number | null; createdBy?: number | null; activate?: boolean } = {},
  ): Promise<ProjectSprint> {
    const settings = await this.getProjectSprintSettings(projectId);
    const all = await listSprints(projectId, {});
    const durationDays = Math.max(1, settings.sprintDurationWeeks * 7);

    // Determine the next start date: day after the latest end date, else today.
    let start = new Date();
    const withEnd = all.filter((s) => s.end_date).sort((a, b) => (a.end_date! < b.end_date! ? 1 : -1));
    if (withEnd.length > 0) {
      const lastEnd = new Date(withEnd[0]!.end_date!);
      const candidate = new Date(lastEnd);
      candidate.setDate(candidate.getDate() + 1);
      if (candidate > start) start = candidate;
    }
    const end = new Date(start);
    end.setDate(end.getDate() + durationDays - 1);

    // Derive the next index for the naming pattern.
    const nextIndex = all.length + 1;
    const name = settings.sprintNamingPattern.includes('{n}')
      ? settings.sprintNamingPattern.replace(/\{n\}/g, String(nextIndex))
      : `${settings.sprintNamingPattern} ${nextIndex}`;

    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const sprint = await createSprint({
      company_id: opts.companyId ?? null,
      project_id: projectId,
      name,
      sprint_type: 'standard',
      start_date: fmt(start),
      end_date: fmt(end),
      status: opts.activate ? 'active' : 'planned',
      is_current: opts.activate === true,
      created_by: opts.createdBy ?? null,
    });
    logger.info(MOD, 'Created next sprint', { projectId, sprintId: sprint.id, name });
    return sprint;
  }

  async activateSprint(sprintId: number, projectId: number): Promise<ProjectSprint | null> {
    return activateSprint(sprintId, projectId);
  }

  /**
   * Complete a sprint and, when the project has auto-create enabled, roll over
   * to a freshly created and activated next sprint.
   */
  async completeSprint(
    sprintId: number,
    projectId: number,
    opts: { companyId?: number | null; createdBy?: number | null } = {},
  ): Promise<{ completed: ProjectSprint | null; next: ProjectSprint | null }> {
    const completed = await dbCompleteSprint(sprintId, projectId);
    if (!completed) return { completed: null, next: null };
    let next: ProjectSprint | null = null;
    const settings = await this.getProjectSprintSettings(projectId);
    if (settings.autoCreateSprints) {
      try {
        next = await this.createNextSprint(projectId, { ...opts, activate: true });
      } catch (err: any) {
        logger.warn(MOD, 'Auto-create next sprint failed', { projectId, error: err?.message });
      }
    }
    return { completed, next };
  }
}

export const sprintService = new SprintService();
