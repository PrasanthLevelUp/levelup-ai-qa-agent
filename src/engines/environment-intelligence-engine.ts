/**
 * Environment Intelligence Engine
 *
 * Enhances RCA data with environment-aware analytics:
 * - Classification breakdown + trends
 * - Environment vs Application failure partitioning
 * - Failure pattern correlation (which classifications co-occur)
 * - Component failure heatmap
 * - Root cause evolution tracking
 * - Actionable environment intelligence insights
 *
 * Categories:
 * - Application: app_bug, selector_drift
 * - Environment: infra_issue, env_config, data_issue
 * - Test Quality: flaky_test
 * - Unknown: unknown
 */

import { logger } from '../utils/logger';

const MOD = 'environment-intelligence';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/** High-level failure domain */
export type FailureDomain = 'application' | 'environment' | 'test_quality' | 'unknown';

export interface ClassificationBreakdown {
  classification: string;
  count: number;
  percentage: number;
  domain: FailureDomain;
  avgConfidence: number;
  avgSeverityScore: number;
  healingRate: number;
}

export interface ClassificationTrendPoint {
  date: string;
  app_bug: number;
  infra_issue: number;
  flaky_test: number;
  env_config: number;
  data_issue: number;
  selector_drift: number;
  unknown: number;
}

export interface DomainSummary {
  domain: FailureDomain;
  count: number;
  percentage: number;
  classifications: string[];
  topAffectedComponent: string;
  avgConfidence: number;
  trend: 'improving' | 'stable' | 'degrading';
}

export interface ComponentHeatmapEntry {
  component: string;
  total: number;
  app_bug: number;
  infra_issue: number;
  flaky_test: number;
  env_config: number;
  data_issue: number;
  selector_drift: number;
  dominantClassification: string;
  severityScore: number;
}

export interface EnvironmentInsight {
  type: 'warning' | 'info' | 'success';
  title: string;
  description: string;
  classification: string;
  metric: string;
}

export interface EnvironmentIntelligenceReport {
  summary: {
    totalAnalyses: number;
    applicationFailures: number;
    environmentFailures: number;
    testQualityIssues: number;
    unknownFailures: number;
    environmentFailureRate: number;
    avgConfidence: number;
    dominantDomain: FailureDomain;
  };
  classificationBreakdown: ClassificationBreakdown[];
  domainSummaries: DomainSummary[];
  componentHeatmap: ComponentHeatmapEntry[];
  classificationTrend: ClassificationTrendPoint[];
  insights: EnvironmentInsight[];
  generatedAt: string;
  windowDays: number;
}

/* -------------------------------------------------------------------------- */
/*  Mappings                                                                  */
/* -------------------------------------------------------------------------- */

const CLASSIFICATION_DOMAIN_MAP: Record<string, FailureDomain> = {
  app_bug: 'application',
  selector_drift: 'application',
  infra_issue: 'environment',
  env_config: 'environment',
  data_issue: 'environment',
  flaky_test: 'test_quality',
  unknown: 'unknown',
};

const SEVERITY_SCORES: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function classificationToDomain(c: string): FailureDomain {
  return CLASSIFICATION_DOMAIN_MAP[c] || 'unknown';
}

/* -------------------------------------------------------------------------- */
/*  Input data (from DB queries)                                              */
/* -------------------------------------------------------------------------- */

export interface EnvIntelInput {
  classificationStats: Array<{
    classification: string;
    count: number;
    avg_confidence: number;
    healing_attempted: number;
    healing_succeeded: number;
    avg_severity: number;
  }>;
  componentStats: Array<{
    component: string;
    classification: string;
    count: number;
    avg_severity: number;
  }>;
  classificationTrend: ClassificationTrendPoint[];
  domainTrend: Array<{
    domain: FailureDomain;
    recent_count: number;
    older_count: number;
    top_component: string;
    avg_confidence: number;
  }>;
  totalAnalyses: number;
  windowDays: number;
}

/* -------------------------------------------------------------------------- */
/*  Main Generator                                                            */
/* -------------------------------------------------------------------------- */

export function generateEnvironmentIntelligence(input: EnvIntelInput): EnvironmentIntelligenceReport {
  const { classificationStats, componentStats, classificationTrend, domainTrend, totalAnalyses, windowDays } = input;

  // 1. Classification breakdown
  const classificationBreakdown: ClassificationBreakdown[] = classificationStats.map(cs => ({
    classification: cs.classification,
    count: cs.count,
    percentage: totalAnalyses > 0 ? Math.round((cs.count / totalAnalyses) * 1000) / 10 : 0,
    domain: classificationToDomain(cs.classification),
    avgConfidence: Math.round(cs.avg_confidence * 100) / 100,
    avgSeverityScore: Math.round(cs.avg_severity * 10) / 10,
    healingRate: cs.healing_attempted > 0
      ? Math.round((cs.healing_succeeded / cs.healing_attempted) * 1000) / 10
      : 0,
  }));

  // 2. Domain summaries
  const domainGroups: Record<FailureDomain, { count: number; classifications: Set<string> }> = {
    application: { count: 0, classifications: new Set() },
    environment: { count: 0, classifications: new Set() },
    test_quality: { count: 0, classifications: new Set() },
    unknown: { count: 0, classifications: new Set() },
  };

  for (const cs of classificationStats) {
    const domain = classificationToDomain(cs.classification);
    domainGroups[domain].count += cs.count;
    domainGroups[domain].classifications.add(cs.classification);
  }

  const domainSummaries: DomainSummary[] = domainTrend.map(dt => {
    const grp = domainGroups[dt.domain];
    let trend: 'improving' | 'stable' | 'degrading' = 'stable';
    if (dt.older_count > 0) {
      const ratio = dt.recent_count / dt.older_count;
      if (ratio < 0.7) trend = 'improving';
      else if (ratio > 1.3) trend = 'degrading';
    } else if (dt.recent_count > 0) {
      trend = 'degrading';
    }

    return {
      domain: dt.domain,
      count: grp.count,
      percentage: totalAnalyses > 0 ? Math.round((grp.count / totalAnalyses) * 1000) / 10 : 0,
      classifications: Array.from(grp.classifications),
      topAffectedComponent: dt.top_component || 'N/A',
      avgConfidence: Math.round(dt.avg_confidence * 100) / 100,
      trend,
    };
  });

  // Fill missing domains
  for (const domain of ['application', 'environment', 'test_quality', 'unknown'] as FailureDomain[]) {
    if (!domainSummaries.find(d => d.domain === domain)) {
      const grp = domainGroups[domain];
      domainSummaries.push({
        domain,
        count: grp.count,
        percentage: totalAnalyses > 0 ? Math.round((grp.count / totalAnalyses) * 1000) / 10 : 0,
        classifications: Array.from(grp.classifications),
        topAffectedComponent: 'N/A',
        avgConfidence: 0,
        trend: 'stable',
      });
    }
  }

  // 3. Component heatmap
  const compMap = new Map<string, ComponentHeatmapEntry>();
  for (const cs of componentStats) {
    if (!compMap.has(cs.component)) {
      compMap.set(cs.component, {
        component: cs.component,
        total: 0,
        app_bug: 0,
        infra_issue: 0,
        flaky_test: 0,
        env_config: 0,
        data_issue: 0,
        selector_drift: 0,
        dominantClassification: 'unknown',
        severityScore: 0,
      });
    }
    const entry = compMap.get(cs.component)!;
    entry.total += cs.count;
    entry.severityScore += cs.avg_severity * cs.count;
    if (cs.classification in entry) {
      (entry as any)[cs.classification] += cs.count;
    }
  }

  const componentHeatmap = Array.from(compMap.values()).map(entry => {
    entry.severityScore = entry.total > 0 ? Math.round((entry.severityScore / entry.total) * 10) / 10 : 0;
    // Find dominant classification
    const classFields = ['app_bug', 'infra_issue', 'flaky_test', 'env_config', 'data_issue', 'selector_drift'] as const;
    let maxCount = 0;
    for (const f of classFields) {
      if (entry[f] > maxCount) {
        maxCount = entry[f];
        entry.dominantClassification = f;
      }
    }
    return entry;
  }).sort((a, b) => b.total - a.total).slice(0, 15);

  // 4. Summary counts
  const applicationFailures = domainGroups.application.count;
  const environmentFailures = domainGroups.environment.count;
  const testQualityIssues = domainGroups.test_quality.count;
  const unknownFailures = domainGroups.unknown.count;
  const environmentFailureRate = totalAnalyses > 0
    ? Math.round((environmentFailures / totalAnalyses) * 1000) / 10
    : 0;

  const overallAvgConfidence = classificationStats.length > 0
    ? Math.round(
        (classificationStats.reduce((s, cs) => s + cs.avg_confidence * cs.count, 0) / Math.max(totalAnalyses, 1)) * 100
      ) / 100
    : 0;

  const dominantDomain: FailureDomain = [
    { d: 'application' as FailureDomain, c: applicationFailures },
    { d: 'environment' as FailureDomain, c: environmentFailures },
    { d: 'test_quality' as FailureDomain, c: testQualityIssues },
  ].sort((a, b) => b.c - a.c)[0]?.d || 'unknown';

  // 5. Generate insights
  const insights = generateInsights({
    classificationBreakdown,
    domainSummaries,
    componentHeatmap,
    environmentFailureRate,
    totalAnalyses,
  });

  logger.info(MOD, 'Environment intelligence report generated', {
    totalAnalyses,
    applicationFailures,
    environmentFailures,
    testQualityIssues,
    insightCount: insights.length,
  });

  return {
    summary: {
      totalAnalyses,
      applicationFailures,
      environmentFailures,
      testQualityIssues,
      unknownFailures,
      environmentFailureRate,
      avgConfidence: overallAvgConfidence,
      dominantDomain,
    },
    classificationBreakdown,
    domainSummaries,
    componentHeatmap,
    classificationTrend,
    insights,
    generatedAt: new Date().toISOString(),
    windowDays,
  };
}

/* -------------------------------------------------------------------------- */
/*  Insight Generation                                                        */
/* -------------------------------------------------------------------------- */

function generateInsights(data: {
  classificationBreakdown: ClassificationBreakdown[];
  domainSummaries: DomainSummary[];
  componentHeatmap: ComponentHeatmapEntry[];
  environmentFailureRate: number;
  totalAnalyses: number;
}): EnvironmentInsight[] {
  const insights: EnvironmentInsight[] = [];

  // Environment failure rate insight
  if (data.environmentFailureRate > 30) {
    insights.push({
      type: 'warning',
      title: 'High Environment Failure Rate',
      description: `${data.environmentFailureRate}% of failures are environment-related (infra, config, data). Consider stabilizing infrastructure and test environments.`,
      classification: 'env_config',
      metric: `${data.environmentFailureRate}%`,
    });
  } else if (data.environmentFailureRate < 10 && data.totalAnalyses > 10) {
    insights.push({
      type: 'success',
      title: 'Stable Test Environment',
      description: `Only ${data.environmentFailureRate}% of failures are environment-related. Your test infrastructure is well-maintained.`,
      classification: 'env_config',
      metric: `${data.environmentFailureRate}%`,
    });
  }

  // Degrading domain trends
  for (const ds of data.domainSummaries) {
    if (ds.trend === 'degrading' && ds.count > 3) {
      insights.push({
        type: 'warning',
        title: `${capitalize(ds.domain)} Failures Increasing`,
        description: `${capitalize(ds.domain)} failures are trending upward. Top affected: ${ds.topAffectedComponent}. Investigate recent changes.`,
        classification: ds.classifications[0] || 'unknown',
        metric: `${ds.count} failures`,
      });
    } else if (ds.trend === 'improving' && ds.count > 0) {
      insights.push({
        type: 'success',
        title: `${capitalize(ds.domain)} Failures Decreasing`,
        description: `${capitalize(ds.domain)} failures are trending downward. Stability improvements are working.`,
        classification: ds.classifications[0] || 'unknown',
        metric: `${ds.count} failures`,
      });
    }
  }

  // Selector drift concentration
  const selectorDrift = data.classificationBreakdown.find(c => c.classification === 'selector_drift');
  if (selectorDrift && selectorDrift.percentage > 25) {
    insights.push({
      type: 'warning',
      title: 'High Selector Drift',
      description: `${selectorDrift.percentage}% of failures are from selector drift. Consider adopting more stable locator strategies (data-testid, aria labels).`,
      classification: 'selector_drift',
      metric: `${selectorDrift.percentage}%`,
    });
  }

  // Flaky test prevalence
  const flaky = data.classificationBreakdown.find(c => c.classification === 'flaky_test');
  if (flaky && flaky.percentage > 20) {
    insights.push({
      type: 'warning',
      title: 'Flaky Test Prevalence',
      description: `${flaky.percentage}% of analysed failures are flaky tests. Prioritize stabilization to improve CI reliability.`,
      classification: 'flaky_test',
      metric: `${flaky.count} flaky`,
    });
  }

  // Component with mixed failure types = unstable
  for (const comp of data.componentHeatmap.slice(0, 5)) {
    const classTypes = ['app_bug', 'infra_issue', 'flaky_test', 'env_config', 'data_issue', 'selector_drift'] as const;
    const activeTypes = classTypes.filter(t => comp[t] > 0).length;
    if (activeTypes >= 3 && comp.total >= 5) {
      insights.push({
        type: 'warning',
        title: `${comp.component} — Multi-Type Failures`,
        description: `${comp.component} has ${activeTypes} different failure types across ${comp.total} failures. This component needs comprehensive attention.`,
        classification: comp.dominantClassification,
        metric: `${comp.total} failures`,
      });
    }
  }

  // Low-confidence analyses
  const lowConfidence = data.classificationBreakdown.filter(c => c.avgConfidence < 0.5 && c.count > 2);
  if (lowConfidence.length > 0) {
    insights.push({
      type: 'info',
      title: 'Low Confidence Analyses',
      description: `${lowConfidence.map(c => c.classification).join(', ')} classifications have low average confidence. More context may be needed for accurate analysis.`,
      classification: lowConfidence[0].classification,
      metric: `${lowConfidence.length} types`,
    });
  }

  return insights;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}
