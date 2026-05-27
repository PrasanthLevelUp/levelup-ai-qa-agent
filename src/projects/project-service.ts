/**
 * Project Service — Enterprise multi-project isolation layer.
 *
 * Provides:
 *  - CRUD with company-scoped access control
 *  - Repository linking/unlinking
 *  - Project access validation
 *  - Cross-project knowledge sharing config
 *  - Data migration for existing records
 *  - Project summary statistics
 */

import { logger } from '../utils/logger';
import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  addRepository,
  listRepositories,
  getRepository,
  deleteRepository,
  validateProjectAccess,
  getProjectStats,
  migrateDataToDefaultProjects,
} from '../db/postgres';

const MOD = 'ProjectService';

export interface ProjectCreateInput {
  companyId: number;
  name: string;
  description?: string;
}

export interface ProjectUpdateInput {
  name?: string;
  description?: string;
  is_active?: boolean;
  release_cycle_type?: string;
  release_cycle_days?: number;
  overview_default_range?: string;
}

export interface RepositoryLinkInput {
  projectId: number;
  companyId: number;
  name: string;
  url: string;
  branch?: string;
  type?: string;
}

export class ProjectService {
  // ─── CRUD ──────────────────────────────────────────────────────

  async create(input: ProjectCreateInput) {
    const { companyId, name, description } = input;
    if (!name || name.trim().length === 0) {
      throw new Error('Project name is required');
    }
    const project = await createProject({
      company_id: companyId,
      name: name.trim(),
      description: description || undefined,
    });
    logger.info(MOD, 'Project created', { projectId: project.id, name: project.name, companyId });
    return project;
  }

  async list(companyId: number) {
    return listProjects(companyId);
  }

  async get(projectId: number, companyId: number) {
    const project = await getProject(projectId, companyId);
    if (!project) return null;
    const repos = await listRepositories(projectId, companyId);
    const stats = await getProjectStats(projectId, companyId);
    return { ...project, repositories: repos, stats };
  }

  async update(projectId: number, companyId: number, updates: ProjectUpdateInput) {
    return updateProject(projectId, companyId, updates);
  }

  async archive(projectId: number, companyId: number) {
    return deleteProject(projectId, companyId);
  }

  // ─── Access Validation ─────────────────────────────────────────

  /**
   * Validate that a project exists, is active, and belongs to the company.
   * Returns the project row or null if access denied.
   */
  async validateAccess(projectId: number, companyId: number) {
    return validateProjectAccess(projectId, companyId);
  }

  /**
   * Resolve project for a request: validates projectId against companyId.
   * If no projectId provided, returns undefined (backward compat: no project filter).
   * If projectId provided but invalid, throws.
   */
  async resolveProjectContext(projectId: number | undefined, companyId: number): Promise<number | undefined> {
    if (!projectId) return undefined;
    const project = await validateProjectAccess(projectId, companyId);
    if (!project) {
      throw new Error(`Project ${projectId} not found or access denied`);
    }
    return projectId;
  }

  // ─── Repository Linking ────────────────────────────────────────

  async linkRepository(input: RepositoryLinkInput) {
    const { projectId, companyId, name, url, branch, type } = input;
    // Validate project access first
    const project = await validateProjectAccess(projectId, companyId);
    if (!project) throw new Error('Project not found or access denied');

    return addRepository({
      project_id: projectId,
      company_id: companyId,
      name: name.trim(),
      url: url.trim(),
      branch: branch || 'main',
      type: type || 'web',
    });
  }

  async unlinkRepository(repoId: number, companyId: number) {
    return deleteRepository(repoId, companyId);
  }

  async getRepositories(projectId: number, companyId: number) {
    return listRepositories(projectId, companyId);
  }

  // ─── Statistics ────────────────────────────────────────────────

  async getStats(projectId: number, companyId: number) {
    return getProjectStats(projectId, companyId);
  }

  // ─── Migration ─────────────────────────────────────────────────

  /**
   * Migrate all orphaned data (project_id IS NULL) to default projects.
   * Safe to run multiple times (idempotent).
   */
  async migrateExistingData() {
    logger.info(MOD, 'Starting data migration to default projects');
    const result = await migrateDataToDefaultProjects();
    logger.info(MOD, 'Migration complete', result);
    return result;
  }
}
