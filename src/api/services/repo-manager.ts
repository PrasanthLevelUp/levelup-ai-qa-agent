/**
 * Repository Manager — manages multi-repo configuration.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger';

const MOD = 'repo-manager';

export interface RepoConfig {
  id: string;
  name: string;
  url: string;
  branch: string;
  localPath?: string;
  enabled: boolean;
}

interface ReposFile {
  repositories: RepoConfig[];
}

const CONFIG_PATH = path.join(__dirname, '../../config/repos.json');

function loadConfig(): ReposFile {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { repositories: [] };
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as ReposFile;
}

function saveConfig(config: ReposFile): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export class RepoManager {
  listRepos(): RepoConfig[] {
    return loadConfig().repositories;
  }

  getRepo(id: string): RepoConfig | null {
    const config = loadConfig();
    return config.repositories.find((r) => r.id === id) ?? null;
  }

  /**
   * Find a repo by ID or URL.
   */
  findRepo(idOrUrl: string): RepoConfig | null {
    const config = loadConfig();
    return config.repositories.find(
      (r) => r.id === idOrUrl || r.url === idOrUrl || r.name === idOrUrl,
    ) ?? null;
  }

  addRepo(repo: Omit<RepoConfig, 'id'>): RepoConfig {
    const config = loadConfig();
    const nextId = `repo_${config.repositories.length + 1}`;
    const newRepo: RepoConfig = {
      id: nextId,
      ...repo,
    };
    config.repositories.push(newRepo);
    saveConfig(config);
    logger.info(MOD, 'Repository added', { id: nextId, name: repo.name });
    return newRepo;
  }

  updateRepo(id: string, updates: Partial<Omit<RepoConfig, 'id'>>): RepoConfig | null {
    const config = loadConfig();
    const idx = config.repositories.findIndex((r) => r.id === id);
    if (idx === -1) return null;

    config.repositories[idx] = { ...config.repositories[idx]!, ...updates };
    saveConfig(config);
    logger.info(MOD, 'Repository updated', { id });
    return config.repositories[idx]!;
  }

  removeRepo(id: string): boolean {
    const config = loadConfig();
    const idx = config.repositories.findIndex((r) => r.id === id);
    if (idx === -1) return false;

    config.repositories.splice(idx, 1);
    saveConfig(config);
    logger.info(MOD, 'Repository removed', { id });
    return true;
  }
}
