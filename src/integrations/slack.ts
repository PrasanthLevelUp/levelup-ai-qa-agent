/**
 * Slack Integration
 *
 * Sends formatted notifications to Slack channels.
 * Handles: heal success/fail, RCA findings, daily digests.
 */

import { logger } from '../utils/logger';
import {
  getNotificationConfigByType,
  insertNotificationLog,
} from '../db/postgres';

const MOD = 'slack';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface SlackConfig {
  botToken: string;
  channel: string;
  notifyHealSuccess?: string; // 'true' | 'false'
  notifyHealFailure?: string;
  notifyDailyDigest?: string;
}

export interface HealNotification {
  jobId: string;
  repoName: string;
  branch: string;
  status: 'completed' | 'failed';
  testsHealed?: number;
  testsFailed?: number;
  totalTests?: number;
  strategies?: Record<string, number>;
  commitSha?: string;
  prUrl?: string;
  errorMessage?: string;
  durationMs?: number;
}

export interface RcaNotification {
  testName: string;
  classification: string;
  severity: string;
  rootCause: string;
  suggestedFix: string;
  isFlaky: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Core send function                                                        */
/* -------------------------------------------------------------------------- */

async function sendSlackMessage(
  botToken: string,
  channel: string,
  blocks: any[],
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel,
        text, // fallback for notifications
        blocks,
      }),
    });

    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) {
      logger.error(MOD, 'Slack API error', { error: data.error, channel });
      return { ok: false, error: data.error };
    }

    logger.info(MOD, 'Message sent', { channel });
    return { ok: true };
  } catch (err) {
    logger.error(MOD, 'Failed to send Slack message', { error: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Send heal result notification.
 * Reads Slack config from DB; no-ops if Slack is not configured.
 */
export async function notifyHealResult(data: HealNotification): Promise<void> {
  const config = await getSlackConfig();
  if (!config) return;

  // Check user preferences
  if (data.status === 'completed' && config.notifyHealSuccess === 'false') return;
  if (data.status === 'failed' && config.notifyHealFailure === 'false') return;

  const isSuccess = data.status === 'completed';
  const emoji = isSuccess ? ':white_check_mark:' : ':x:';
  const statusText = isSuccess ? 'Healing Completed' : 'Healing Failed';
  const color = isSuccess ? '#10b981' : '#ef4444';
  const duration = data.durationMs ? `${(data.durationMs / 1000).toFixed(1)}s` : 'N/A';

  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} ${statusText}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Repository*\n${data.repoName}` },
        { type: 'mrkdwn', text: `*Branch*\n\`${data.branch}\`` },
        { type: 'mrkdwn', text: `*Job ID*\n\`${data.jobId}\`` },
        { type: 'mrkdwn', text: `*Duration*\n${duration}` },
      ],
    },
  ];

  if (isSuccess && data.testsHealed) {
    const strategyLines = data.strategies
      ? Object.entries(data.strategies)
          .map(([s, c]) => `• ${s}: ${c}`)
          .join('\n')
      : '';

    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tests Healed*\n${data.testsHealed}/${data.totalTests || '?'}` },
        { type: 'mrkdwn', text: `*Strategies Used*\n${strategyLines || 'N/A'}` },
      ],
    });
  }

  if (data.prUrl) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:git: *Pull Request:* <${data.prUrl}|View PR>` },
    });
  }

  if (data.commitSha) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Commit: \`${data.commitSha.slice(0, 8)}\`` },
      ],
    });
  }

  if (!isSuccess && data.errorMessage) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:*\n\`\`\`${data.errorMessage.slice(0, 500)}\`\`\``,
      },
    });
  }

  blocks.push({ type: 'divider' });

  const result = await sendSlackMessage(
    config.botToken,
    config.channel,
    blocks,
    `${emoji} ${statusText} — ${data.repoName} (${data.branch})`,
  );

  await insertNotificationLog({
    tool_type: 'slack',
    event_type: `heal_${data.status}`,
    channel: config.channel,
    message_preview: `${statusText} — ${data.repoName}`,
    status: result.ok ? 'sent' : 'failed',
    error: result.error,
    metadata: { jobId: data.jobId, repoName: data.repoName },
  });
}

/**
 * Send RCA notification.
 */
export async function notifyRca(data: RcaNotification): Promise<void> {
  const config = await getSlackConfig();
  if (!config) return;

  const severityEmoji: Record<string, string> = {
    critical: ':rotating_light:',
    high: ':warning:',
    medium: ':large_yellow_circle:',
    low: ':information_source:',
  };

  const emoji = severityEmoji[data.severity] || ':mag:';

  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} RCA: ${data.classification.replace(/_/g, ' ').toUpperCase()}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Test*\n${data.testName}` },
        { type: 'mrkdwn', text: `*Severity*\n${data.severity}` },
        { type: 'mrkdwn', text: `*Classification*\n${data.classification}` },
        { type: 'mrkdwn', text: `*Flaky*\n${data.isFlaky ? ':warning: Yes' : 'No'}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Root Cause*\n${data.rootCause.slice(0, 500)}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Suggested Fix*\n${data.suggestedFix.slice(0, 500)}` },
    },
    { type: 'divider' },
  ];

  const result = await sendSlackMessage(
    config.botToken,
    config.channel,
    blocks,
    `${emoji} RCA: ${data.classification} — ${data.testName}`,
  );

  await insertNotificationLog({
    tool_type: 'slack',
    event_type: 'rca',
    channel: config.channel,
    message_preview: `RCA: ${data.classification} — ${data.testName}`,
    status: result.ok ? 'sent' : 'failed',
    error: result.error,
    metadata: { testName: data.testName, classification: data.classification },
  });
}

/**
 * Send a custom/test message.
 */
export async function sendTestMessage(
  botToken: string,
  channel: string,
): Promise<{ ok: boolean; error?: string }> {
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: ':white_check_mark: LevelUp AI QA — Connection Test',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Your Slack integration is working! You will receive notifications for:\n• :wrench: Healing results (success/failure)\n• :mag: Root cause analysis findings\n• :chart_with_upwards_trend: Daily QA digest summaries',
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Connected at ${new Date().toISOString()}` },
      ],
    },
  ];

  return sendSlackMessage(
    botToken,
    channel,
    blocks,
    'LevelUp AI QA — Slack integration is working!',
  );
}

/* -------------------------------------------------------------------------- */
/*  Config helper                                                              */
/* -------------------------------------------------------------------------- */

async function getSlackConfig(): Promise<SlackConfig | null> {
  try {
    const cfg = await getNotificationConfigByType('slack');
    if (!cfg || cfg.status !== 'connected') return null;
    const c = cfg.config as unknown as SlackConfig;
    if (!c.botToken || !c.channel) return null;
    return c;
  } catch (err) {
    logger.error(MOD, 'Failed to load Slack config', { error: (err as Error).message });
    return null;
  }
}
