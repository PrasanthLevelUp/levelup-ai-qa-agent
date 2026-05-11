/**
 * Rerun Engine — isolated test re-execution to verify fixes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExecutionEngine } from '../core/execution-engine';
import { logger } from '../utils/logger';

const MOD = 'rerun-engine';

export interface RerunResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class RerunEngine {
  /**
   * Re-run a specific test with an applied fix.
   * Backs up original, applies fix, runs test, and handles rollback.
   */
  async rerunTest(
    testFilePath: string,
    testRepoPath: string,
    fixedContent: string,
  ): Promise<RerunResult> {
    const backupPath = testFilePath + '.rerun-bak';
    const originalContent = fs.readFileSync(testFilePath, 'utf-8');

    try {
      // Backup original
      fs.writeFileSync(backupPath, originalContent, 'utf-8');

      // Apply fix
      fs.writeFileSync(testFilePath, fixedContent, 'utf-8');

      // Run only the specific test file
      const relativeTestFile = path.relative(
        path.join(testRepoPath, 'tests'),
        testFilePath,
      );

      logger.info(MOD, 'Re-running test with fix applied', {
        testFile: relativeTestFile,
      });

      const result = ExecutionEngine.run(testRepoPath, relativeTestFile);

      const passed = result.exitCode === 0;

      logger.info(MOD, 'Rerun complete', {
        passed,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });

      return {
        passed,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      };
    } catch (error) {
      logger.error(MOD, 'Rerun failed with exception', {
        error: (error as Error).message,
      });

      return {
        passed: false,
        exitCode: 1,
        stdout: '',
        stderr: (error as Error).message,
        durationMs: 0,
      };
    } finally {
      // Cleanup backup (the caller decides whether to keep the fix or restore)
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
    }
  }

  /**
   * Verify if a fix worked based on rerun results.
   */
  verifyFix(result: RerunResult): { success: boolean; message: string } {
    if (result.passed) {
      return { success: true, message: 'Test passed after fix applied' };
    }
    return {
      success: false,
      message: `Test still failing (exit code: ${result.exitCode})`,
    };
  }

  /**
   * Rollback changes by restoring the original file.
   */
  cleanup(testFilePath: string, originalContent: string): void {
    fs.writeFileSync(testFilePath, originalContent, 'utf-8');
    logger.info(MOD, 'Rolled back to original', { testFilePath });
  }
}
