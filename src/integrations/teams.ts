/**
 * Microsoft Teams Integration
 *
 * Sends formatted notifications to Teams channels via incoming webhooks.
 */

import { logger } from '../utils/logger';
import {
  getNotificationConfigByType,
  insertNotificationLog,
} from '../db/postgres';

const MOD = 'teams';

export interface TeamsConfig {
  webhookUrl: string;
}

/**
 * Send a test message to Teams.
 */
export async function sendTeamsTestMessage(
  webhookUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        '@type': 'MessageCard',
        '@context': 'http://schema.org/extensions',
        summary: 'LevelUp AI QA \u2014 Connection Test',
        themeColor: '10B981',
        sections: [
          {
            activityTitle: '\u2705 LevelUp AI QA Connected',
            activitySubtitle: 'Your Microsoft Teams integration is working.',
            facts: [{ name: 'Status', value: 'Connection verified' }],
          },
        ],
      }),
    });

    if (res.ok) {
      return { ok: true };
    }
    return { ok: false, error: `Teams returned ${res.status}: ${await res.text()}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
