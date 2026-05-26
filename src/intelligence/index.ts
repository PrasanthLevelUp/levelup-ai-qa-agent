/**
 * Application Intelligence Module
 *
 * Three-layer architecture:
 * 1. Profile Service + Crawl Orchestrator (Phase 1 — implemented)
 * 2. Self-Healing Selector Engine (Phase 2 — foundation)
 * 3. Pattern Recognition / Knowledge Graph (Phase 3 — foundation)
 */

export { ProfileService } from './profile-service';
export type { ProfileStatus, ProfileStatusResult, SaveProfileInput } from './profile-service';

export { CrawlOrchestrator } from './crawl-orchestrator';
export type { CrawlDecision, OrchestratorConfig } from './crawl-orchestrator';

export { SelectorHealingEngine } from './healing-engine';
export type {
  BrokenSelectorResult,
  SelectorAlternative,
  SelectorStrategy,
  HealingAnalysis,
  HealingSuggestion,
} from './healing-engine';

export { PatternMatcher } from './pattern-matcher';
export type { PatternType, DetectedPattern, PatternMatch } from './pattern-matcher';
