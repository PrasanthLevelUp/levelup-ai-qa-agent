/**
 * Release Signoff Engine
 * Aggregates quality signals into a structured release signoff report.
 * Generates both a data-rich structured report and an AI-powered executive summary.
 *
 * Sections:
 * 1. Executive Summary (AI-generated narrative)
 * 2. Risk Assessment (from Release Risk Engine)
 * 3. Test Health Overview
 * 4. Healing Performance
 * 5. Flaky Test Analysis
 * 6. Module Health
 * 7. Signoff Recommendation
 */

import { logger } from '../utils/logger';
import { computeReleaseRisk, type ReleaseRiskResult, type RiskInputData } from './release-risk-engine';

const MOD = 'release-signoff-engine';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface SignoffSection {
  title: string;
  status: 'pass' | 'warn' | 'fail';
  items: Array<{ label: string; value: string; status?: 'good' | 'warning' | 'critical' }>;
}

export type SignoffDecision = 'APPROVE' | 'REVIEW_REQUIRED' | 'REJECT';

export interface SignoffReport {
  decision: SignoffDecision;
  decisionReason: string;
  riskAssessment: ReleaseRiskResult;
  sections: SignoffSection[];
  executiveSummary: string;
  generatedAt: string;
  windowDays: number;
  // Raw data for AI narrative generation
  rawData: SignoffRawData;
}

export interface SignoffRawData {
  totalExecutions: number;
  passedExecutions: number;
  failedExecutions: number;
  passRate: number;
  totalHealings: number;
  successfulHealings: number;
  healingSuccessRate: number;
  flakyTestCount: number;
  topFlakyTests: Array<{ name: string; count: number; rate: number }>;
  criticalRCAs: number;
  highRCAs: number;
  learnedPatterns: number;
  patternUsages: number;
  avgConfidence: number;
  tokensSaved: number;
  riskScore: number;
  grade: string;
  riskAreas: Array<{ module: string; score: number }>;
}

/* -------------------------------------------------------------------------- */
/*  Signoff Logic                                                             */
/* -------------------------------------------------------------------------- */

function decideSignoff(risk: ReleaseRiskResult, raw: SignoffRawData): { decision: SignoffDecision; reason: string } {
  // F grade = hard reject
  if (risk.grade === 'F') {
    return { decision: 'REJECT', reason: 'Critical quality failures detected. Multiple risk signals are in critical state. Release is unsafe.' };
  }

  // D grade = reject unless very few tests
  if (risk.grade === 'D') {
    return { decision: 'REJECT', reason: 'High risk detected across multiple quality signals. Address critical issues before releasing.' };
  }

  // C grade = review required
  if (risk.grade === 'C') {
    return { decision: 'REVIEW_REQUIRED', reason: 'Moderate risk detected. Review flagged areas carefully before approving release.' };
  }

  // B grade with any critical signals = review
  if (risk.grade === 'B' && risk.signals.some(s => s.status === 'critical')) {
    return { decision: 'REVIEW_REQUIRED', reason: 'Generally safe, but one or more signals are in critical state. Review before proceeding.' };
  }

  // Pass rate below 70% = review
  if (raw.passRate < 0.7 && raw.totalExecutions > 0) {
    return { decision: 'REVIEW_REQUIRED', reason: `Pass rate is ${(raw.passRate * 100).toFixed(1)}%, below the 70% threshold. Investigate failures.` };
  }

  // A or B grade = approve
  return { decision: 'APPROVE', reason: 'All quality signals are within safe thresholds. Release is recommended.' };
}

function buildSections(risk: ReleaseRiskResult, raw: SignoffRawData): SignoffSection[] {
  const sections: SignoffSection[] = [];

  // Test Health
  const passRateStatus = raw.passRate >= 0.9 ? 'good' : raw.passRate >= 0.7 ? 'warning' : 'critical';
  sections.push({
    title: 'Test Health',
    status: passRateStatus === 'good' ? 'pass' : passRateStatus === 'warning' ? 'warn' : 'fail',
    items: [
      { label: 'Total Test Runs', value: raw.totalExecutions.toLocaleString(), status: 'good' },
      { label: 'Passed', value: raw.passedExecutions.toLocaleString(), status: 'good' },
      { label: 'Failed', value: raw.failedExecutions.toLocaleString(), status: raw.failedExecutions > 0 ? 'warning' : 'good' },
      { label: 'Pass Rate', value: `${(raw.passRate * 100).toFixed(1)}%`, status: passRateStatus },
    ],
  });

  // Healing Performance
  const healStatus = raw.healingSuccessRate >= 0.8 ? 'good' : raw.healingSuccessRate >= 0.5 ? 'warning' : 'critical';
  sections.push({
    title: 'Healing Performance',
    status: healStatus === 'good' ? 'pass' : healStatus === 'warning' ? 'warn' : 'fail',
    items: [
      { label: 'Total Healings', value: raw.totalHealings.toLocaleString() },
      { label: 'Successful', value: raw.successfulHealings.toLocaleString(), status: 'good' },
      { label: 'Success Rate', value: `${(raw.healingSuccessRate * 100).toFixed(1)}%`, status: healStatus },
      { label: 'Avg Confidence', value: `${(raw.avgConfidence * 100).toFixed(1)}%`, status: raw.avgConfidence >= 0.7 ? 'good' : 'warning' },
    ],
  });

  // Flaky Analysis
  const flakyStatus = raw.flakyTestCount === 0 ? 'good' : raw.flakyTestCount <= 3 ? 'warning' : 'critical';
  sections.push({
    title: 'Flaky Test Analysis',
    status: flakyStatus === 'good' ? 'pass' : flakyStatus === 'warning' ? 'warn' : 'fail',
    items: [
      { label: 'Flaky Tests Detected', value: raw.flakyTestCount.toString(), status: flakyStatus },
      ...raw.topFlakyTests.slice(0, 3).map(t => ({
        label: t.name,
        value: `${t.count} occurrences (${(t.rate * 100).toFixed(0)}% rate)`,
        status: t.rate > 0.5 ? 'critical' as const : 'warning' as const,
      })),
    ],
  });

  // RCA Summary
  const rcaStatus = raw.criticalRCAs === 0 ? (raw.highRCAs <= 2 ? 'good' : 'warning') : 'critical';
  sections.push({
    title: 'Root Cause Analysis',
    status: rcaStatus === 'good' ? 'pass' : rcaStatus === 'warning' ? 'warn' : 'fail',
    items: [
      { label: 'Critical Severity', value: raw.criticalRCAs.toString(), status: raw.criticalRCAs > 0 ? 'critical' : 'good' },
      { label: 'High Severity', value: raw.highRCAs.toString(), status: raw.highRCAs > 2 ? 'warning' : 'good' },
    ],
  });

  // Learning & Intelligence
  sections.push({
    title: 'Learning & Intelligence',
    status: 'pass',
    items: [
      { label: 'Learned Patterns', value: raw.learnedPatterns.toLocaleString(), status: 'good' },
      { label: 'Pattern Usages', value: raw.patternUsages.toLocaleString(), status: 'good' },
      { label: 'Est. Tokens Saved', value: raw.tokensSaved.toLocaleString(), status: 'good' },
    ],
  });

  // Risk Areas
  if (raw.riskAreas.length > 0) {
    sections.push({
      title: 'High-Risk Modules',
      status: raw.riskAreas.some(a => a.score >= 70) ? 'fail' : raw.riskAreas.some(a => a.score >= 40) ? 'warn' : 'pass',
      items: raw.riskAreas.slice(0, 5).map(a => ({
        label: a.module,
        value: `Risk Score: ${a.score}`,
        status: a.score >= 70 ? 'critical' as const : a.score >= 40 ? 'warning' as const : 'good' as const,
      })),
    });
  }

  return sections;
}

function buildExecutiveSummary(risk: ReleaseRiskResult, raw: SignoffRawData, decision: SignoffDecision): string {
  const lines: string[] = [];

  // Opening
  if (decision === 'APPROVE') {
    lines.push(`This release candidate meets quality standards with a Grade ${risk.grade} risk assessment (score: ${risk.overallScore}/100).`);
  } else if (decision === 'REVIEW_REQUIRED') {
    lines.push(`This release candidate requires review before approval. Risk assessment: Grade ${risk.grade} (score: ${risk.overallScore}/100).`);
  } else {
    lines.push(`This release candidate is NOT recommended for deployment. Risk assessment: Grade ${risk.grade} (score: ${risk.overallScore}/100).`);
  }

  // Test health
  if (raw.totalExecutions > 0) {
    lines.push(`Across ${raw.totalExecutions.toLocaleString()} test executions, ${(raw.passRate * 100).toFixed(1)}% passed successfully.`);
  }

  // Healing
  if (raw.totalHealings > 0) {
    lines.push(`The self-healing engine processed ${raw.totalHealings.toLocaleString()} healing attempts with a ${(raw.healingSuccessRate * 100).toFixed(1)}% success rate and average confidence of ${(raw.avgConfidence * 100).toFixed(1)}%.`);
  }

  // Flaky
  if (raw.flakyTestCount > 0) {
    lines.push(`${raw.flakyTestCount} flaky test${raw.flakyTestCount > 1 ? 's were' : ' was'} detected during the assessment window.`);
  } else {
    lines.push('No flaky tests were detected during the assessment window.');
  }

  // Critical issues
  if (raw.criticalRCAs > 0) {
    lines.push(`${raw.criticalRCAs} critical-severity root cause${raw.criticalRCAs > 1 ? 's were' : ' was'} identified and requires attention.`);
  }

  // Risk areas
  const criticalModules = raw.riskAreas.filter(a => a.score >= 70);
  if (criticalModules.length > 0) {
    lines.push(`High-risk modules: ${criticalModules.map(m => m.module).join(', ')}.`);
  }

  // Learning
  if (raw.learnedPatterns > 0) {
    lines.push(`The learning engine has accumulated ${raw.learnedPatterns.toLocaleString()} patterns with ${raw.patternUsages.toLocaleString()} total reuses.`);
  }

  return lines.join(' ');
}

/* -------------------------------------------------------------------------- */
/*  Main Generator                                                            */
/* -------------------------------------------------------------------------- */

export interface SignoffInputs {
  riskData: RiskInputData;
  flakyTests: Array<{ test_name: string; flaky_count: number; flaky_rate: number }>;
  learningStats: { totalPatterns: number; totalUsages: number; totalTokensSaved: number };
  windowDays: number;
}

export function generateSignoffReport(inputs: SignoffInputs): SignoffReport {
  // Compute risk assessment
  const riskAssessment = computeReleaseRisk(inputs.riskData);

  // Build raw data summary
  const rd = inputs.riskData;
  const passedExecutions = rd.totalExecutions - rd.failedExecutions;
  const passRate = rd.totalExecutions > 0 ? passedExecutions / rd.totalExecutions : 1;
  const healingSuccessRate = rd.totalHealings > 0
    ? (rd.totalHealings - rd.failedHealings) / rd.totalHealings
    : 1;

  const rawData: SignoffRawData = {
    totalExecutions: rd.totalExecutions,
    passedExecutions,
    failedExecutions: rd.failedExecutions,
    passRate,
    totalHealings: rd.totalHealings,
    successfulHealings: rd.totalHealings - rd.failedHealings,
    healingSuccessRate,
    flakyTestCount: rd.flakyCount,
    topFlakyTests: inputs.flakyTests.slice(0, 5).map(t => ({
      name: t.test_name,
      count: t.flaky_count,
      rate: t.flaky_rate,
    })),
    criticalRCAs: rd.criticalRCAs,
    highRCAs: rd.highRCAs,
    learnedPatterns: inputs.learningStats.totalPatterns,
    patternUsages: inputs.learningStats.totalUsages,
    avgConfidence: rd.avgConfidence,
    tokensSaved: inputs.learningStats.totalTokensSaved,
    riskScore: riskAssessment.overallScore,
    grade: riskAssessment.grade,
    riskAreas: riskAssessment.riskAreas.map(a => ({ module: a.module, score: a.riskScore })),
  };

  // Decide signoff
  const { decision, reason } = decideSignoff(riskAssessment, rawData);

  // Build sections
  const sections = buildSections(riskAssessment, rawData);

  // Generate executive summary
  const executiveSummary = buildExecutiveSummary(riskAssessment, rawData, decision);

  logger.info(MOD, 'Signoff report generated', { decision, grade: riskAssessment.grade, score: riskAssessment.overallScore });

  return {
    decision,
    decisionReason: reason,
    riskAssessment,
    sections,
    executiveSummary,
    generatedAt: new Date().toISOString(),
    windowDays: inputs.windowDays,
    rawData,
  };
}
