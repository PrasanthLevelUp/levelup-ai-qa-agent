/**
 * Execution Provider factory — resolves an {@link ExecutionProvider} for a given
 * execution mode. The healing worker calls this once per job; everything below
 * the returned provider's {@link ExecutionResult} is source-agnostic.
 *
 * `local` is the default and the safe fallback for any unknown mode, so a job
 * with no execution mode behaves EXACTLY as it always has (zero regression).
 */
import type { ExecutionProvider, ExecutionSource } from '../execution-provider';
import { LocalExecutionProvider } from './local-execution-provider';
import { GitHubActionsExecutionProvider } from './github-actions-execution-provider';

export { LocalExecutionProvider } from './local-execution-provider';
export { GitHubActionsExecutionProvider } from './github-actions-execution-provider';
export * from './artifact-ingestion';
// Re-export the canonical execution result contract for convenient single-import.
export {
  assembleExecutionResult,
  ExecutionSetupError,
  type ExecutionResult,
  type ProviderInfo,
  type ExecutionRunMetadata,
  type ExecutionSetupStage,
} from '../execution-result';

/** Supported execution modes a job may request. */
export type ExecutionMode = 'local' | 'github_actions';

/**
 * Build the provider for an execution mode. Defaults to Local Runner — an
 * unset or unrecognized mode always returns the local provider so existing jobs
 * are completely unaffected.
 */
export function createExecutionProvider(mode?: ExecutionMode | string | null): ExecutionProvider {
  switch (mode) {
    case 'github_actions':
      return new GitHubActionsExecutionProvider();
    case 'local':
    default:
      return new LocalExecutionProvider();
  }
}

/** Map a provider mode to its canonical execution source label. */
export function modeToSource(mode?: ExecutionMode | string | null): ExecutionSource {
  return mode === 'github_actions' ? 'github_actions' : 'local';
}
