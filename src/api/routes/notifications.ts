/**
 * Notification Config API Routes
 *
 * CRUD for tool connections (Slack, Jira, Teams, GitHub).
 * Test endpoints for validating credentials.
 * All configs stored in Railway DB — dashboard proxies here.
 */

import { Router, type Request, type Response } from 'express';
import {
  getNotificationConfigs,
  upsertNotificationConfig,
  deleteNotificationConfig,
  updateNotificationTestResult,
  getNotificationLogs,
} from '../../db/postgres';
import { sendTestMessage as sendSlackTest } from '../../integrations/slack';
import { sendTeamsTestMessage } from '../../integrations/teams';
import { fetchProjects, fetchIssueTypes, type JiraConfig } from '../../integrations/jira';
import { logger } from '../../utils/logger';

const MOD = 'notifications-api';
const router = Router();

/* ------------------------------------------------------------------ */
/*  Sensitive field masking                                            */
/* ------------------------------------------------------------------ */

const SENSITIVE_KEYS: Record<string, string[]> = {
  slack: ['botToken'],
  jira: ['apiToken'],
  teams: ['webhookUrl'],
  github: ['token'],
  gitlab: ['token'],
};

function sanitizeConfig(toolType: string, config: Record<string, any>): Record<string, any> {
  if (!config) return {};
  const safe = { ...config };
  const keys = SENSITIVE_KEYS[toolType] || [];
  for (const key of keys) {
    if (safe[key] && typeof safe[key] === 'string') {
      const val = safe[key] as string;
      safe[key] = val.length > 8 ? val.slice(0, 4) + '\u2022\u2022\u2022\u2022' + val.slice(-4) : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    }
  }
  return safe;
}

/* ------------------------------------------------------------------ */
/*  GET /api/notifications/config                                      */
/* ------------------------------------------------------------------ */

router.get('/config', async (req: Request, res: Response) => {
  try {
    const cid = (req as any).companyId;
    const configs = await getNotificationConfigs(cid);
    const sanitized = configs.map((c) => ({
      ...c,
      config: sanitizeConfig(c.tool_type, c.config),
      // Map to camelCase for frontend consistency
      id: c.id,
      toolType: c.tool_type,
      displayName: c.display_name,
      status: c.status,
      connectedAt: c.connected_at,
      lastTestedAt: c.last_tested_at,
      lastTestResult: c.last_test_result,
    }));
    res.json({ success: true, data: sanitized });
  } catch (error) {
    logger.error(MOD, 'GET /config error', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to fetch configs' });
  }
});

/* ------------------------------------------------------------------ */
/*  POST /api/notifications/config                                     */
/* ------------------------------------------------------------------ */

router.post('/config', async (req: Request, res: Response) => {
  try {
    const cid = (req as any).companyId;
    const { toolType, displayName, config } = req.body;
    if (!toolType || !displayName) {
      res.status(400).json({ success: false, error: 'toolType and displayName are required' });
      return;
    }

    const saved = await upsertNotificationConfig({
      tool_type: toolType,
      display_name: displayName,
      config: config || {},
    }, cid);

    res.json({
      success: true,
      data: {
        ...saved,
        toolType: saved.tool_type,
        displayName: saved.display_name,
        connectedAt: saved.connected_at,
        lastTestedAt: saved.last_tested_at,
        lastTestResult: saved.last_test_result,
        config: sanitizeConfig(saved.tool_type, saved.config),
      },
    });
  } catch (error) {
    logger.error(MOD, 'POST /config error', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to save config' });
  }
});

/* ------------------------------------------------------------------ */
/*  DELETE /api/notifications/config/:id                                */
/* ------------------------------------------------------------------ */

router.delete('/config/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid ID' });
      return;
    }

    const deleted = await deleteNotificationConfig(id);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    logger.error(MOD, 'DELETE /config/:id error', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to delete config' });
  }
});

/* ------------------------------------------------------------------ */
/*  POST /api/notifications/test                                       */
/* ------------------------------------------------------------------ */

router.post('/test', async (req: Request, res: Response) => {
  try {
    const { toolType, config, id } = req.body;
    if (!toolType || !config) {
      res.status(400).json({ success: false, error: 'toolType and config required' });
      return;
    }

    let result: { success: boolean; message: string; details?: Record<string, any> };

    switch (toolType) {
      case 'slack': {
        const { botToken, channel } = config;
        if (!botToken) {
          result = { success: false, message: 'Bot Token is required' };
          break;
        }
        // First test auth
        const authRes = await fetch('https://slack.com/api/auth.test', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json',
          },
        });
        const authData = await authRes.json() as any;
        if (!authData.ok) {
          result = { success: false, message: `Slack auth failed: ${authData.error}` };
          break;
        }
        // Send test message if channel provided
        if (channel) {
          const msgResult = await sendSlackTest(botToken, channel);
          if (!msgResult.ok) {
            result = {
              success: false,
              message: `Auth OK (${authData.team}) but failed to post to ${channel}: ${msgResult.error}`,
            };
            break;
          }
        }
        result = {
          success: true,
          message: `Connected to workspace "${authData.team}" as ${authData.user}${channel ? `. Test message sent to ${channel}` : ''}`,
          details: { team: authData.team, user: authData.user },
        };
        break;
      }

      case 'jira': {
        const { instanceUrl, email, apiToken } = config;
        if (!instanceUrl || !email || !apiToken) {
          result = { success: false, message: 'Instance URL, email, and API token required' };
          break;
        }
        const url = instanceUrl.replace(/\/$/, '');
        const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
        const jiraRes = await fetch(`${url}/rest/api/3/myself`, {
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        });
        if (jiraRes.ok) {
          const jiraData = await jiraRes.json() as any;
          result = {
            success: true,
            message: `Connected as ${jiraData.displayName} (${jiraData.emailAddress})`,
            details: { displayName: jiraData.displayName, email: jiraData.emailAddress },
          };
        } else {
          result = { success: false, message: `Jira returned ${jiraRes.status}: ${jiraRes.statusText}` };
        }
        break;
      }

      case 'teams': {
        const { webhookUrl } = config;
        if (!webhookUrl) {
          result = { success: false, message: 'Webhook URL is required' };
          break;
        }
        const teamsResult = await sendTeamsTestMessage(webhookUrl);
        result = teamsResult.ok
          ? { success: true, message: 'Test message sent to Teams channel' }
          : { success: false, message: teamsResult.error || 'Failed to send' };
        break;
      }

      case 'github': {
        const { token } = config;
        if (!token) {
          result = { success: false, message: 'Token is required' };
          break;
        }
        const ghRes = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
        });
        if (ghRes.ok) {
          const ghData = await ghRes.json() as any;
          result = {
            success: true,
            message: `Authenticated as ${ghData.login}`,
            details: { login: ghData.login, name: ghData.name },
          };
        } else {
          result = { success: false, message: `GitHub returned ${ghRes.status}` };
        }
        break;
      }

      default:
        result = { success: false, message: `Unknown tool type: ${toolType}` };
    }

    // Persist test result if ID provided
    if (id && typeof id === 'number') {
      try {
        await updateNotificationTestResult(id, result.success);
      } catch { /* ignore */ }
    }

    res.json({ success: true, result });
  } catch (error) {
    logger.error(MOD, 'POST /test error', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Test failed unexpectedly' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/notifications/logs                                        */
/* ------------------------------------------------------------------ */

router.get('/logs', async (req: Request, res: Response) => {
  try {
    const cid = (req as any).companyId;
    const limit = parseInt(String(req.query.limit || "50")) || 50;
    const logs = await getNotificationLogs(limit, cid);
    res.json({ success: true, data: logs });
  } catch (error) {
    logger.error(MOD, 'GET /logs error', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to fetch logs' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/notifications/jira/projects                               */
/* ------------------------------------------------------------------ */

router.get('/jira/projects', async (req: Request, res: Response) => {
  try {
    const { instanceUrl, email, apiToken } = req.query as Record<string, string>;
    if (!instanceUrl || !email || !apiToken) {
      res.status(400).json({ success: false, error: 'instanceUrl, email, apiToken required' });
      return;
    }
    const projects = await fetchProjects({ instanceUrl, email, apiToken });
    res.json({ success: true, data: projects });
  } catch (error) {
    logger.error(MOD, 'GET /jira/projects error', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to fetch projects' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/notifications/jira/issue-types                            */
/* ------------------------------------------------------------------ */

router.get('/jira/issue-types', async (req: Request, res: Response) => {
  try {
    const { instanceUrl, email, apiToken, projectKey } = req.query as Record<string, string>;
    if (!instanceUrl || !email || !apiToken || !projectKey) {
      res.status(400).json({ success: false, error: 'instanceUrl, email, apiToken, projectKey required' });
      return;
    }
    const types = await fetchIssueTypes({ instanceUrl, email, apiToken }, projectKey);
    res.json({ success: true, data: types });
  } catch (error) {
    logger.error(MOD, 'GET /jira/issue-types error', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to fetch issue types' });
  }
});

export function createNotificationsRouter(): Router {
  return router;
}
