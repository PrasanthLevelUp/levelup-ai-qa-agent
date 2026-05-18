/**
 * Release Risk Engine
 * Computes a composite release risk score by aggregating multiple quality signals:
 * - Healing success/failure rate
 * - Flaky test prevalence
 * - RCA severity distribution
 * - Confidence levels
 * - Module instability
 * - Trend direction (improving vs degrading)
 *
 * Score: 0 (safe) to 100 (high risk)
 * Grade: A (0-20), B (21-40), C (41-60), D (61-80), F (81-100)
 */

import { logger } from '../utils/logger';

const MOD = 'release-risk-engine';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface RiskSignal {
  name: string;
  category: 'healing' | 'flaky' | 'rca' | 'confidence' | 'stability' | 'trend';
  score: number;       // 0-100 contribution
  weight: number;      // 0-1 weight factor
  value: string;       // human-readable value
  status: 'good' | 'warning' | 'critical';
  detail: string;
}

export interface RiskArea {
  module: string;
  riskScore: number;
  failureCount: number;
  flakyCount: number;
  healingFailures: number;
  criticalRCAs: number;
}

export interface ReleaseRiskResult {
  overallScore: number;           // 0-100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  recommendation: string;
  signals: RiskSignal[];
  riskAreas: RiskArea[];
  summary: string;
  assessedAt: string;
}

/* -------------------------------------------------------------------------- */
/*  Signal Weights (total = 1.0)                                              */
/* -------------------------------------------------------------------------- */

const WEIGHTS = {
  healingFailureRate:   0.20,
  flakyRate:            0.18,
  rcaSeverity:          0.18,
  confidenceLevel:      0.12,
  unhealedFailures:     0.15,
  trendDirection:       0.17,
};

/* -------------------------------------------------------------------------- */
/*  Risk Scoring Functions                                                    */
/* -------------------------------------------------------------------------- */

function scoreToStatus(score: number): 'good' | 'warning' | 'critical' {
  if (score <= 30) return 'good';
  if (score <= 60) return 'warning';
  return 'critical';
}

function gradeFromScore(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score <= 20) return 'A';
  if (score <= 40) return 'B';
  if (score <= 60) return 'C';
  if (score <= 80) return 'D';
  return 'F';
}

function recommendationFromGrade(grade: string, topRisks: string[]): string {
  const riskList = topRisks.length > 0 ? ` Top risk areas: ${topRisks.join(', ')}.` : '';
  switch (grade) {
    case 'A': return `Release looks safe. All quality signals are healthy.${riskList}`;
    case 'B': return `Release is generally safe with minor concerns. Review flagged areas before proceeding.${riskList}`;
    case 'C': return `Moderate risk detected. Address warning signals before release.${riskList}`;
    case 'D': return `High risk. Significant quality issues detected. Strongly recommend fixing critical signals before release.${riskList}`;
    case 'F': return `Critical risk. Do NOT release. Multiple critical quality failures detected.${riskList}`;
    default: return `Unable to assess. Insufficient data.${riskList}`;
  }
}

/* -------------------------------------------------------------------------- */
/*  Main Engine                                                               */
/* -------------------------------------------------------------------------- */

export interface RiskInputData {
  // Healing signals
  totalHealings: number;
  failedHealings: number;
  lowConfidenceHealings: number; // confidence < 0.5
  avgConfidence: number;

  // Test execution signals
  totalExecutions: number;
  failedExecutions: number;
  unhealedFailures: number;  // attempted but not succeeded

  // Flaky signals
  flakyCount: number;
  totalRCAs: number;

  // RCA severity
  criticalRCAs: number;
  highRCAs: number;
  mediumRCAs: number;

  // Trend (recent 7 days vs previous 7 days)
  recentFailureRate: number;   // 0-1
  previousFailureRate: number; // 0-1

  // Module breakdown
  moduleStats: Array<{
    module: string;
    failures: number;
    flakyCount: number;
    healingFailures: number;
    criticalRCAs: number;
  }>;
}

export function computeReleaseRisk(data: RiskInputData): ReleaseRiskResult {
  const signals: RiskSignal[] = [];

  // 1. Healing Failure Rate
  const healingFailureRate = data.totalHealings > 0
    ? data.failedHealings / data.totalHealings
    : 0;
  const healingScore = Math.min(100, healingFailureRate * 200); // 50% failure = 100 risk
  signals.push({
    name: 'Healing Failure Rate',
    category: 'healing',
    score: Math.round(healingScore),
    weight: WEIGHTS.healingFailureRate,
    value: data.totalHealings > 0 ? `${(healingFailureRate * 100).toFixed(1)}%` : 'N/A',
    status: scoreToStatus(healingScore),
    detail: `${data.failedHealings} of ${data.totalHealings} healings failed`,
  });

  // 2. Flaky Test Rate
  const flakyRate = data.totalRCAs > 0 ? data.flakyCount / data.totalRCAs : 0;
  const flakyScore = Math.min(100, flakyRate * 250); // 40% flaky = 100 risk
  signals.push({
    name: 'Flaky Test Rate',
    category: 'flaky',
    score: Math.round(flakyScore),
    weight: WEIGHTS.flakyRate,
    value: data.totalRCAs > 0 ? `${(flakyRate * 100).toFixed(1)}%` : 'N/A',
    status: scoreToStatus(flakyScore),
    detail: `${data.flakyCount} flaky tests out of ${data.totalRCAs} RCA analyses`,
  });

  // 3. RCA Severity (critical + high as % of total)
  const severeRate = data.totalRCAs > 0
    ? (data.criticalRCAs + data.highRCAs) / data.totalRCAs
    : 0;
  const criticalBoost = data.criticalRCAs > 0 ? 20 : 0; // Extra penalty for any criticals
  const rcaScore = Math.min(100, severeRate * 200 + criticalBoost);
  signals.push({
    name: 'RCA Severity',
    category: 'rca',
    score: Math.round(rcaScore),
    weight: WEIGHTS.rcaSeverity,
    value: `${data.criticalRCAs} critical, ${data.highRCAs} high`,
    status: scoreToStatus(rcaScore),
    detail: `${data.criticalRCAs} critical + ${data.highRCAs} high severity out of ${data.totalRCAs} total RCAs`,
  });

  // 4. Confidence Level (inverse — low confidence = high risk)
  const confScore = data.totalHealings > 0
    ? Math.min(100, (1 - data.avgConfidence) * 120) // avg conf 0.3 → risk 84
    : 0;
  signals.push({
    name: 'Confidence Level',
    category: 'confidence',
    score: Math.round(confScore),
    weight: WEIGHTS.confidenceLevel,
    value: data.totalHealings > 0 ? `${(data.avgConfidence * 100).toFixed(1)}%` : 'N/A',
    status: scoreToStatus(confScore),
    detail: `${data.lowConfidenceHealings} healings below 50% confidence`,
  });

  // 5. Unhealed Failures
  const unhealedRate = data.totalExecutions > 0
    ? data.unhealedFailures / data.totalExecutions
    : 0;
  const unhealedScore = Math.min(100, unhealedRate * 333); // 30% unhealed = 100 risk
  signals.push({
    name: 'Unhealed Failures',
    category: 'stability',
    score: Math.round(unhealedScore),
    weight: WEIGHTS.unhealedFailures,
    value: data.totalExecutions > 0 ? `${data.unhealedFailures} tests` : 'N/A',
    status: scoreToStatus(unhealedScore),
    detail: `${data.unhealedFailures} of ${data.totalExecutions} tests failed and could not be healed`,
  });

  // 6. Trend Direction
  let trendScore = 0;
  let trendDetail = 'Stable';
  if (data.previousFailureRate > 0) {
    const change = data.recentFailureRate - data.previousFailureRate;
    const changeRatio = change / data.previousFailureRate;
    if (changeRatio > 0) {
      // Deteriorating
      trendScore = Math.min(100, changeRatio * 200); // 50% worse = 100
      trendDetail = `Failure rate increased by ${(changeRatio * 100).toFixed(0)}%`;
    } else {
      // Improving
      trendScore = Math.max(0, 20 + changeRatio * 100); // Improving still gets a small base risk
      trendDetail = `Failure rate decreased by ${(Math.abs(changeRatio) * 100).toFixed(0)}%`;
    }
  } else if (data.recentFailureRate > 0) {
    trendScore = 50; // No history to compare
    trendDetail = 'No previous data for trend comparison';
  }
  signals.push({
    name: 'Trend Direction',
    category: 'trend',
    score: Math.round(trendScore),
    weight: WEIGHTS.trendDirection,
    value: trendDetail,
    status: scoreToStatus(trendScore),
    detail: `Recent 7d failure rate: ${(data.recentFailureRate * 100).toFixed(1)}% vs previous 7d: ${(data.previousFailureRate * 100).toFixed(1)}%`,
  });

  // Compute weighted overall score
  const overallScore = Math.round(
    signals.reduce((sum, s) => sum + s.score * s.weight, 0)
  );

  // Module risk areas
  const riskAreas: RiskArea[] = data.moduleStats
    .map((m) => {
      const moduleRisk = Math.min(100,
        m.failures * 10 +
        m.flakyCount * 15 +
        m.healingFailures * 20 +
        m.criticalRCAs * 30
      );
      return {
        module: m.module || 'unknown',
        riskScore: moduleRisk,
        failureCount: m.failures,
        flakyCount: m.flakyCount,
        healingFailures: m.healingFailures,
        criticalRCAs: m.criticalRCAs,
      };
    })
    .filter(a => a.riskScore > 0)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 10);

  const grade = gradeFromScore(overallScore);
  const topRisks = riskAreas.slice(0, 3).map(a => a.module);
  const recommendation = recommendationFromGrade(grade, topRisks);

  // Build summary
  const criticalSignals = signals.filter(s => s.status === 'critical');
  const warningSignals = signals.filter(s => s.status === 'warning');
  const summary = criticalSignals.length > 0
    ? `${criticalSignals.length} critical signal${criticalSignals.length > 1 ? 's' : ''} detected: ${criticalSignals.map(s => s.name).join(', ')}. ${warningSignals.length} warning${warningSignals.length !== 1 ? 's' : ''}.`
    : warningSignals.length > 0
    ? `No critical issues. ${warningSignals.length} warning signal${warningSignals.length > 1 ? 's' : ''}: ${warningSignals.map(s => s.name).join(', ')}.`
    : 'All quality signals are healthy. Release is safe to proceed.';

  logger.info(MOD, 'Risk assessment computed', { overallScore, grade, signalCount: signals.length, riskAreaCount: riskAreas.length });

  return {
    overallScore,
    grade,
    recommendation,
    signals,
    riskAreas,
    summary,
    assessedAt: new Date().toISOString(),
  };
}
