/**
 * ROI / Maintenance Cost Engine
 *
 * Calculates return on investment and maintenance cost savings from:
 * - Time saved by auto-healing (vs manual debugging)
 * - Token cost efficiency (rule/pattern vs AI)
 * - PR automation savings
 * - Pattern reuse savings
 * - Flaky test reduction impact
 * - Maintenance hours avoided
 *
 * Industry benchmarks used:
 * - Manual locator fix: ~30 min avg
 * - Manual flaky investigation: ~45 min avg
 * - Manual PR creation: ~20 min avg
 * - Engineer hourly rate: $75 (configurable)
 * - AI token cost per healing: ~$0.02 avg
 */

import { logger } from '../utils/logger';

const MOD = 'roi-engine';

/* -------------------------------------------------------------------------- */
/*  Config — industry benchmarks                                              */
/* -------------------------------------------------------------------------- */

const DEFAULTS = {
  manualFixMinutes: 30,         // Avg time to manually debug + fix a locator
  manualFlakyMinutes: 45,       // Avg time to investigate a flaky test
  manualPRMinutes: 20,          // Avg time to create a fix PR manually
  manualPatternMinutes: 15,     // Avg time to document a reusable pattern
  hourlyRate: 75,               // Engineer hourly rate in USD
  aiCostPerHealing: 0.02,       // Avg AI token cost per healing attempt
  rulePatternTokensSaved: 500,  // Estimated tokens saved per rule/pattern heal
  tokenCostPer1k: 0.003,        // Cost per 1k tokens (gpt-4o-mini)
};

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ROIMetrics {
  // Time savings
  totalHoursSaved: number;
  healingHoursSaved: number;
  flakyInvestigationHoursSaved: number;
  prAutomationHoursSaved: number;
  patternReuseHoursSaved: number;

  // Cost savings
  totalCostSaved: number;
  laborCostSaved: number;
  tokenCostActual: number;
  tokenCostTheoretical: number;
  tokenCostSaved: number;
  netROI: number;
  roiPercentage: number;

  // Efficiency metrics
  avgCostPerHeal: number;
  manualCostPerFix: number;
  costReductionPercent: number;
  healingsPerDay: number;

  // Volume metrics
  totalHealings: number;
  successfulHealings: number;
  failedHealings: number;
  successRate: number;
  prsGenerated: number;
  prsMerged: number;
  patternsLearned: number;
  patternReuses: number;
  flakyTestsDetected: number;

  // Strategy breakdown
  strategyBreakdown: {
    rule_based: number;
    database_pattern: number;
    ai_reasoning: number;
    other: number;
  };
  zeroTokenHealings: number;
  zeroTokenPercent: number;

  // Maintenance cost projection
  monthlyMaintenanceSaved: number;
  yearlyMaintenanceSaved: number;
  maintenanceReductionPercent: number;
}

export interface ROITrendPoint {
  date: string;
  healings: number;
  hoursSaved: number;
  costSaved: number;
  tokenCost: number;
}

export interface ROICategoryBreakdown {
  category: string;
  hoursSaved: number;
  costSaved: number;
  count: number;
}

export interface ROIReport {
  metrics: ROIMetrics;
  trend: ROITrendPoint[];
  categoryBreakdown: ROICategoryBreakdown[];
  generatedAt: string;
  windowDays: number;
}

/* -------------------------------------------------------------------------- */
/*  Input data                                                                */
/* -------------------------------------------------------------------------- */

export interface ROIInputData {
  // Healing data
  totalHealings: number;
  successfulHealings: number;
  totalTokensUsed: number;
  strategyBreakdown: Record<string, number>;

  // PR data
  prsGenerated: number;
  prsMerged: number;

  // Pattern data
  patternsLearned: number;
  totalPatternUsages: number;

  // Flaky data
  flakyTestCount: number;

  // Token cost data
  totalTokenCostUsd: number;

  // Time data
  windowDays: number;
  dailyTrend: Array<{
    date: string;
    healings: number;
    tokens_used: number;
    token_cost: number;
  }>;
}

/* -------------------------------------------------------------------------- */
/*  Main Calculator                                                           */
/* -------------------------------------------------------------------------- */

export function calculateROI(input: ROIInputData): ROIReport {
  const cfg = DEFAULTS;
  const failedHealings = input.totalHealings - input.successfulHealings;

  // Strategy breakdown
  const ruleBased = input.strategyBreakdown['rule_based'] || 0;
  const dbPattern = input.strategyBreakdown['database_pattern'] || 0;
  const aiReasoning = input.strategyBreakdown['ai_reasoning'] || 0;
  const other = input.totalHealings - ruleBased - dbPattern - aiReasoning;
  const zeroTokenHealings = ruleBased + dbPattern;
  const zeroTokenPercent = input.totalHealings > 0
    ? Math.round((zeroTokenHealings / input.totalHealings) * 1000) / 10
    : 0;

  // Time savings
  const healingHoursSaved = (input.successfulHealings * cfg.manualFixMinutes) / 60;
  const flakyInvestigationHoursSaved = (input.flakyTestCount * cfg.manualFlakyMinutes) / 60;
  const prAutomationHoursSaved = (input.prsGenerated * cfg.manualPRMinutes) / 60;
  const patternReuseHoursSaved = (input.totalPatternUsages * cfg.manualPatternMinutes) / 60;
  const totalHoursSaved = healingHoursSaved + flakyInvestigationHoursSaved + prAutomationHoursSaved + patternReuseHoursSaved;

  // Cost savings
  const laborCostSaved = totalHoursSaved * cfg.hourlyRate;
  const tokenCostActual = input.totalTokenCostUsd;
  // Theoretical cost if all healings used AI
  const tokenCostTheoretical = input.totalHealings * cfg.aiCostPerHealing;
  const tokenCostSaved = Math.max(0, tokenCostTheoretical - tokenCostActual);
  const totalCostSaved = laborCostSaved + tokenCostSaved;
  const netROI = totalCostSaved - tokenCostActual;
  const roiPercentage = tokenCostActual > 0 ? Math.round((netROI / tokenCostActual) * 100) : (totalCostSaved > 0 ? 9999 : 0);

  // Efficiency
  const avgCostPerHeal = input.successfulHealings > 0 ? tokenCostActual / input.successfulHealings : 0;
  const manualCostPerFix = (cfg.manualFixMinutes / 60) * cfg.hourlyRate;
  const costReductionPercent = manualCostPerFix > 0
    ? Math.round(((manualCostPerFix - avgCostPerHeal) / manualCostPerFix) * 1000) / 10
    : 0;
  const healingsPerDay = input.windowDays > 0 ? Math.round((input.totalHealings / input.windowDays) * 10) / 10 : 0;

  // Maintenance projection
  const dailySaved = input.windowDays > 0 ? totalCostSaved / input.windowDays : 0;
  const monthlyMaintenanceSaved = Math.round(dailySaved * 30);
  const yearlyMaintenanceSaved = Math.round(dailySaved * 365);
  const maintenanceReductionPercent = costReductionPercent;

  const metrics: ROIMetrics = {
    totalHoursSaved: Math.round(totalHoursSaved * 10) / 10,
    healingHoursSaved: Math.round(healingHoursSaved * 10) / 10,
    flakyInvestigationHoursSaved: Math.round(flakyInvestigationHoursSaved * 10) / 10,
    prAutomationHoursSaved: Math.round(prAutomationHoursSaved * 10) / 10,
    patternReuseHoursSaved: Math.round(patternReuseHoursSaved * 10) / 10,
    totalCostSaved: Math.round(totalCostSaved * 100) / 100,
    laborCostSaved: Math.round(laborCostSaved * 100) / 100,
    tokenCostActual: Math.round(tokenCostActual * 100) / 100,
    tokenCostTheoretical: Math.round(tokenCostTheoretical * 100) / 100,
    tokenCostSaved: Math.round(tokenCostSaved * 100) / 100,
    netROI: Math.round(netROI * 100) / 100,
    roiPercentage: Math.min(roiPercentage, 99999),
    avgCostPerHeal: Math.round(avgCostPerHeal * 10000) / 10000,
    manualCostPerFix: Math.round(manualCostPerFix * 100) / 100,
    costReductionPercent,
    healingsPerDay,
    totalHealings: input.totalHealings,
    successfulHealings: input.successfulHealings,
    failedHealings,
    successRate: input.totalHealings > 0 ? Math.round((input.successfulHealings / input.totalHealings) * 1000) / 10 : 0,
    prsGenerated: input.prsGenerated,
    prsMerged: input.prsMerged,
    patternsLearned: input.patternsLearned,
    patternReuses: input.totalPatternUsages,
    flakyTestsDetected: input.flakyTestCount,
    strategyBreakdown: { rule_based: ruleBased, database_pattern: dbPattern, ai_reasoning: aiReasoning, other: Math.max(0, other) },
    zeroTokenHealings,
    zeroTokenPercent,
    monthlyMaintenanceSaved,
    yearlyMaintenanceSaved,
    maintenanceReductionPercent,
  };

  // Trend
  const trend: ROITrendPoint[] = input.dailyTrend.map(d => ({
    date: d.date,
    healings: d.healings,
    hoursSaved: Math.round((d.healings * cfg.manualFixMinutes / 60) * 10) / 10,
    costSaved: Math.round(d.healings * manualCostPerFix * 100) / 100,
    tokenCost: Math.round(d.token_cost * 100) / 100,
  }));

  // Category breakdown
  const categoryBreakdown: ROICategoryBreakdown[] = [
    { category: 'Auto-Healing', hoursSaved: metrics.healingHoursSaved, costSaved: Math.round(healingHoursSaved * cfg.hourlyRate * 100) / 100, count: input.successfulHealings },
    { category: 'Flaky Investigation', hoursSaved: metrics.flakyInvestigationHoursSaved, costSaved: Math.round(flakyInvestigationHoursSaved * cfg.hourlyRate * 100) / 100, count: input.flakyTestCount },
    { category: 'PR Automation', hoursSaved: metrics.prAutomationHoursSaved, costSaved: Math.round(prAutomationHoursSaved * cfg.hourlyRate * 100) / 100, count: input.prsGenerated },
    { category: 'Pattern Reuse', hoursSaved: metrics.patternReuseHoursSaved, costSaved: Math.round(patternReuseHoursSaved * cfg.hourlyRate * 100) / 100, count: input.totalPatternUsages },
  ];

  logger.info(MOD, 'ROI report generated', {
    totalHoursSaved: metrics.totalHoursSaved,
    totalCostSaved: metrics.totalCostSaved,
    roiPercentage: metrics.roiPercentage,
    windowDays: input.windowDays,
  });

  return {
    metrics,
    trend,
    categoryBreakdown,
    generatedAt: new Date().toISOString(),
    windowDays: input.windowDays,
  };
}
