/**
 * Test Data Materializer
 *
 * Writes test data sets to `data/*.json` files in the repository. This enables:
 * 1. Framework Auditor to discover and catalog data files (populates `dataFiles`).
 * 2. Generated scripts to import/reference real data instead of hallucinating values.
 * 3. Human visibility — `data/` fixtures are part of the repo for review/version control.
 *
 * IMPORTANT — call this at dataset CREATE/UPDATE time only (materialize once per
 * change). Do NOT call it on every script-generation request: re-writing data/*.json
 * on each generation causes needless repo churn and diff noise. Script Generation
 * reads dataset METADATA from the DB (see getTestDataSetSummaries) and references the
 * already-materialized files; it must never trigger materialization itself.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { listTestDataSets, getTestDataRecords, type TestDataSet } from '../db/postgres';

export interface MaterializeResult {
  filesWritten: string[];
  errors: { dataset: string; error: string }[];
}

/**
 * Materialize all active test data sets for a project into `data/*.json` files.
 * 
 * @param repoPath - absolute path to the repository root
 * @param companyId - company scope
 * @param projectId - project scope (required)
 * @param environment - which environment's data to materialize (default: 'shared')
 * @returns list of written file paths and any errors
 */
export async function materializeTestData(
  repoPath: string,
  companyId: number,
  projectId: number,
  environment: string = 'shared',
): Promise<MaterializeResult> {
  const result: MaterializeResult = { filesWritten: [], errors: [] };

  try {
    // Fetch all active datasets for this project+environment.
    const datasets = await listTestDataSets(companyId, projectId, environment);
    if (datasets.length === 0) {
      return result;
    }

    // Ensure data/ directory exists.
    const dataDir = path.join(repoPath, 'data');
    await fs.mkdir(dataDir, { recursive: true });

    // Write each dataset as data/<name>.json.
    for (const dataset of datasets) {
      try {
        const records = await getTestDataRecords(dataset.id);
        // Transform records into a friendly JSON structure (array of objects keyed by 'key').
        const jsonData = records.map(rec => ({
          key: rec.key,
          value: rec.value_jsonb,
          tags: rec.tags || [],
        }));

        const filename = `${dataset.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
        const filepath = path.join(dataDir, filename);
        await fs.writeFile(filepath, JSON.stringify(jsonData, null, 2), 'utf-8');
        result.filesWritten.push(`data/${filename}`);
      } catch (err: any) {
        result.errors.push({
          dataset: dataset.name,
          error: err.message,
        });
      }
    }

    return result;
  } catch (err: any) {
    result.errors.push({
      dataset: 'ALL',
      error: `Failed to materialize test data: ${err.message}`,
    });
    return result;
  }
}

/**
 * Check if test data files exist in the repo (used by Framework Auditor).
 */
export async function hasTestDataFiles(repoPath: string): Promise<boolean> {
  try {
    const dataDir = path.join(repoPath, 'data');
    const stat = await fs.stat(dataDir);
    if (!stat.isDirectory()) return false;
    const files = await fs.readdir(dataDir);
    return files.some(f => f.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * List all test data JSON files in the repo's data/ folder.
 */
export async function listTestDataFiles(repoPath: string): Promise<string[]> {
  try {
    const dataDir = path.join(repoPath, 'data');
    const files = await fs.readdir(dataDir);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => `data/${f}`);
  } catch {
    return [];
  }
}
