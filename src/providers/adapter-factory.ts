/**
 * Provider Adapter Factory
 * Routes incoming data to the correct adapter based on format detection.
 */

import type { ProviderAdapter, ProviderType, IngestPayload } from './types';
import { PlaywrightAdapter } from './playwright.adapter';
import { JUnitAdapter } from './junit.adapter';
import { logger } from '../utils/logger';

const MOD = 'adapter-factory';

// Registry of all adapters
const adapters: ProviderAdapter[] = [
  new PlaywrightAdapter(),
  new JUnitAdapter(),
];

/**
 * Auto-detect provider and parse data.
 */
export function autoDetectAndParse(data: any, meta?: Record<string, any>): IngestPayload {
  for (const adapter of adapters) {
    if (adapter.canHandle(data)) {
      logger.info(MOD, `Auto-detected provider: ${adapter.providerType}`);
      return adapter.parse(data, meta);
    }
  }
  throw new Error('Unable to detect report format. Supported: Playwright JSON, JUnit XML');
}

/**
 * Parse data with a specific provider.
 */
export function parseWithProvider(provider: ProviderType, data: any, meta?: Record<string, any>): IngestPayload {
  const adapter = adapters.find(a => a.providerType === provider);
  if (!adapter) {
    throw new Error(`Unsupported provider: ${provider}. Supported: ${adapters.map(a => a.providerType).join(', ')}`);
  }
  return adapter.parse(data, meta);
}

/**
 * Get list of supported providers.
 */
export function getSupportedProviders(): ProviderType[] {
  return adapters.map(a => a.providerType);
}
