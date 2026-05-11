/**
 * File utilities — read, write, backup, restore test files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

const MOD = 'file-utils';

export function readJSON<T = unknown>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

export function writeJSON(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  logger.debug(MOD, `Wrote JSON: ${filePath}`);
}

export function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function backupFile(filePath: string): string {
  const backupPath = filePath + '.bak';
  fs.copyFileSync(filePath, backupPath);
  logger.info(MOD, `Backed up: ${filePath} → ${backupPath}`);
  return backupPath;
}

export function restoreFile(filePath: string): boolean {
  const backupPath = filePath + '.bak';
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, filePath);
    fs.unlinkSync(backupPath);
    logger.info(MOD, `Restored: ${backupPath} → ${filePath}`);
    return true;
  }
  logger.warn(MOD, `No backup found: ${backupPath}`);
  return false;
}

export function cleanupBackup(filePath: string): void {
  const backupPath = filePath + '.bak';
  if (fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
  }
}
