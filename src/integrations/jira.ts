/**
 * Jira Integration
 *
 * Auto-creates bug tickets from RCA findings.
 * Links healing PRs to Jira issues.
 * Fetches projects + issue types for config.
 */

import { logger } from '../utils/logger';
import {
  getNotificationConfigByType,
  insertNotificationLog,
} from '../db/postgres';

const MOD = 'jira';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface JiraConfig {
  instanceUrl: string; // e.g. https://company.atlassian.net
  email: string;
  apiToken: string;
  projectKey?: string; // default project for auto-created tickets
  issueType?: string;  // default issue type (Bug, Task, Story)
}

export interface JiraTicketData {
  testName: string;
  classification: string;
  severity: string;
  rootCause: string;
  suggestedFix: string;
  affectedComponent: string;
  isFlaky: boolean;
  jobId: string;
  repoName?: string;
  branch?: string;
  prUrl?: string;
  healingAttempted: boolean;
  healingSucceeded: boolean;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

/**
 * A Jira issue mapped into a requirement-friendly shape for the Requirements
 * Hub import flow. `description` is flattened from ADF into plain text so it can
 * feed the scenario planner unchanged.
 */
export interface JiraImportedIssue {
  key: string;            // AUTH-123
  summary: string;        // issue title
  description: string;    // plain-text description (ADF flattened)
  issueType: string;      // Story, Epic, Task, Bug
  status: string;         // To Do, In Progress, Done ...
  priority?: string;      // Highest, High, Medium ...
  assignee?: string;      // display name
  sprint?: string;        // active/most-recent sprint name, if any
  labels?: string[];
  updated?: string;       // ISO timestamp of last update
  url: string;            // browse URL
}

export interface CreateTicketResult {
  success: boolean;
  issueKey?: string;
  issueUrl?: string;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/*  Internal HTTP helper                                                      */
/* -------------------------------------------------------------------------- */

function buildAuth(email: string, apiToken: string): string {
  return Buffer.from(`${email}:${apiToken}`).toString('base64');
}

async function jiraFetch(
  config: JiraConfig,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${config.instanceUrl.replace(/\/$/, '')}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Basic ${buildAuth(config.email, config.apiToken)}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Auto-create a Jira bug ticket from RCA findings.
 * Reads config from DB; no-ops if Jira is not configured.
 */
export async function createRcaTicket(data: JiraTicketData): Promise<CreateTicketResult> {
  const config = await getJiraConfig();
  if (!config) return { success: false, error: 'Jira not configured' };
  if (!config.projectKey) return { success: false, error: 'No project key configured' };

  try {
    const severity = data.severity;
    const priorityMap: Record<string, string> = {
      critical: 'Highest',
      high: 'High',
      medium: 'Medium',
      low: 'Low',
    };

    const labels = [
      'levelup-qa',
      `rca-${data.classification}`,
      data.isFlaky ? 'flaky-test' : '',
      data.healingSucceeded ? 'auto-healed' : '',
    ].filter(Boolean);

    const summaryPrefix = data.isFlaky ? '[FLAKY] ' : '';
    const summary = `${summaryPrefix}${data.classification.replace(/_/g, ' ').toUpperCase()}: ${data.testName}`.slice(0, 250);

    // Build rich description in Atlassian Document Format (ADF)
    const description = buildAdfDescription(data);

    const payload: Record<string, any> = {
      fields: {
        project: { key: config.projectKey },
        issuetype: { name: config.issueType || 'Bug' },
        summary,
        description,
        labels,
      },
    };

    // Try to set priority (may fail if custom priority scheme)
    const priorityName = priorityMap[severity];
    if (priorityName) {
      payload.fields.priority = { name: priorityName };
    }

    const res = await jiraFetch(config, '/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text();
      logger.error(MOD, 'Create ticket failed', { status: res.status, body: errBody });

      // If priority fails, retry without it
      if (errBody.includes('priority') && payload.fields.priority) {
        delete payload.fields.priority;
        const retry = await jiraFetch(config, '/rest/api/3/issue', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (retry.ok) {
          const retryData = await retry.json() as any;
          const result: CreateTicketResult = {
            success: true,
            issueKey: retryData.key,
            issueUrl: `${config.instanceUrl}/browse/${retryData.key}`,
          };
          await logTicketCreation(data, result);
          return result;
        }
      }

      const result: CreateTicketResult = { success: false, error: `Jira ${res.status}: ${errBody.slice(0, 300)}` };
      await logTicketCreation(data, result);
      return result;
    }

    const respData = await res.json() as any;
    const result: CreateTicketResult = {
      success: true,
      issueKey: respData.key,
      issueUrl: `${config.instanceUrl}/browse/${respData.key}`,
    };

    logger.info(MOD, 'Ticket created', { issueKey: respData.key, test: data.testName });
    await logTicketCreation(data, result);

    // If there's a PR, add it as a comment
    if (data.prUrl && respData.key) {
      await addComment(config, respData.key, `Healing PR: ${data.prUrl}`);
    }

    return result;
  } catch (err) {
    logger.error(MOD, 'Create ticket error', { error: (err as Error).message });
    const result: CreateTicketResult = { success: false, error: (err as Error).message };
    await logTicketCreation(data, result);
    return result;
  }
}

/**
 * Link a PR to an existing Jira ticket by adding a comment.
 */
export async function linkPrToTicket(
  issueKey: string,
  prUrl: string,
  prTitle?: string,
): Promise<boolean> {
  const config = await getJiraConfig();
  if (!config) return false;

  const comment = prTitle
    ? `Healing PR merged: [${prTitle}|${prUrl}]`
    : `Healing PR: ${prUrl}`;

  return addComment(config, issueKey, comment);
}

/**
 * Fetch available projects (for config UI).
 */
export async function fetchProjects(config: JiraConfig): Promise<JiraProject[]> {
  try {
    const res = await jiraFetch(config, '/rest/api/3/project?maxResults=50');
    if (!res.ok) return [];
    const data = await res.json() as any[];
    return data.map((p: any) => ({ id: p.id, key: p.key, name: p.name }));
  } catch {
    return [];
  }
}

/**
 * Fetch issue types for a project (for config UI).
 */
export async function fetchIssueTypes(
  config: JiraConfig,
  projectKey: string,
): Promise<JiraIssueType[]> {
  try {
    const res = await jiraFetch(
      config,
      `/rest/api/3/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes`,
    );
    if (!res.ok) return [];
    const data = await res.json() as any;
    const project = data.projects?.[0];
    if (!project) return [];
    return project.issuetypes.map((it: any) => ({
      id: it.id,
      name: it.name,
      subtask: it.subtask,
    }));
  } catch {
    return [];
  }
}

/**
 * Search issues in a project filtered by issue type(s), for the Requirements
 * Hub import flow. Returns issues mapped into a requirement-friendly shape.
 * Uses the Jira JQL search API and only pulls the fields we need.
 */
export async function searchIssues(
  config: JiraConfig,
  projectKey: string,
  issueTypes: string[],
  maxResults = 100,
): Promise<JiraImportedIssue[]> {
  try {
    const jqlParts = [`project = "${projectKey}"`];
    if (issueTypes && issueTypes.length > 0) {
      const quoted = issueTypes.map((t) => `"${t.replace(/"/g, '')}"`).join(', ');
      jqlParts.push(`issuetype IN (${quoted})`);
    }
    const jql = jqlParts.join(' AND ') + ' ORDER BY updated DESC';
    const fields = [
      'summary',
      'description',
      'issuetype',
      'status',
      'priority',
      'assignee',
      'labels',
      'updated',
    ].join(',');

    const issues: JiraImportedIssue[] = [];
    let nextPageToken: string | undefined;

    // Jira Cloud's legacy /rest/api/3/search is removed (410); the current
    // enhanced endpoint is /rest/api/3/search/jql with token-based pagination
    // (no startAt / total). Loop until isLast or we hit the cap.
    while (issues.length < maxResults) {
      const body: Record<string, any> = {
        jql,
        maxResults: Math.min(100, maxResults - issues.length),
        fields: fields.split(','),
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;

      const res = await jiraFetch(config, '/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        logger.error(MOD, 'searchIssues failed', { status: res.status, body: errText.slice(0, 300) });
        break;
      }
      const data = (await res.json()) as any;
      const batch: any[] = data.issues || [];
      for (const issue of batch) {
        issues.push(mapIssue(config, issue));
      }
      nextPageToken = data.nextPageToken;
      if (data.isLast || !nextPageToken || batch.length === 0) break;
    }

    return issues;
  } catch (err) {
    logger.error(MOD, 'searchIssues error', { error: (err as Error).message });
    return [];
  }
}

/** Map a raw Jira issue payload into our requirement-friendly shape. */
function mapIssue(config: JiraConfig, issue: any): JiraImportedIssue {
  const f = issue.fields || {};
  // Sprint lives in a customfield whose id varies per instance; find the first
  // array field holding objects that look like sprints (have a `name`).
  let sprint: string | undefined;
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith('customfield_') && Array.isArray(v) && v.length > 0) {
      const last = v[v.length - 1] as any;
      if (last && typeof last === 'object' && typeof last.name === 'string' && 'state' in last) {
        sprint = last.name;
        break;
      }
    }
  }
  return {
    key: issue.key,
    summary: f.summary || issue.key,
    description: adfToPlainText(f.description),
    issueType: f.issuetype?.name || 'Task',
    status: f.status?.name || 'To Do',
    priority: f.priority?.name,
    assignee: f.assignee?.displayName,
    sprint,
    labels: Array.isArray(f.labels) ? f.labels : [],
    updated: f.updated,
    url: `${config.instanceUrl.replace(/\/$/, '')}/browse/${issue.key}`,
  };
}

/**
 * Flatten an Atlassian Document Format (ADF) description into readable plain
 * text. Handles headings, paragraphs, bullet/ordered lists and hard breaks so
 * numbered acceptance criteria survive into the scenario planner. Falls back to
 * the raw string if the value is already a string (older API / plain text).
 */
export function adfToPlainText(adf: any): string {
  if (!adf) return '';
  if (typeof adf === 'string') return adf;
  const lines: string[] = [];

  const walkInline = (nodes: any[]): string =>
    (nodes || [])
      .map((n) => {
        if (n.type === 'text') return n.text || '';
        if (n.type === 'hardBreak') return '\n';
        if (n.type === 'inlineCard') return n.attrs?.url || '';
        if (n.type === 'mention') return n.attrs?.text || '';
        if (Array.isArray(n.content)) return walkInline(n.content);
        return '';
      })
      .join('');

  const walkBlock = (node: any, depth = 0): void => {
    if (!node) return;
    switch (node.type) {
      case 'doc':
        (node.content || []).forEach((c: any) => walkBlock(c, depth));
        break;
      case 'heading':
      case 'paragraph': {
        const text = walkInline(node.content || []).trim();
        if (text) lines.push(text);
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        const ordered = node.type === 'orderedList';
        (node.content || []).forEach((item: any, i: number) => {
          const prefix = ordered ? `${i + 1}. ` : '- ';
          const text = walkInline(collectItemInline(item)).trim();
          if (text) lines.push(`${'  '.repeat(depth)}${prefix}${text}`);
          // nested lists
          (item.content || [])
            .filter((c: any) => c.type === 'bulletList' || c.type === 'orderedList')
            .forEach((c: any) => walkBlock(c, depth + 1));
        });
        break;
      }
      case 'codeBlock': {
        const text = walkInline(node.content || []);
        if (text) lines.push(text);
        break;
      }
      default:
        if (Array.isArray(node.content)) node.content.forEach((c: any) => walkBlock(c, depth));
    }
  };

  // Gather inline content of a listItem's direct paragraphs (not nested lists).
  const collectItemInline = (item: any): any[] => {
    const out: any[] = [];
    (item.content || [])
      .filter((c: any) => c.type === 'paragraph' || c.type === 'heading')
      .forEach((c: any) => out.push(...(c.content || [])));
    return out;
  };

  walkBlock(adf);
  return lines.join('\n').trim();
}

/**
 * Load the stored, connected Jira config for the current company. Exposed for
 * the Requirements Hub import routes so users never re-enter credentials.
 * Returns null if Jira isn't configured/connected.
 */
export async function getStoredJiraConfig(): Promise<JiraConfig | null> {
  return getJiraConfig();
}

/* -------------------------------------------------------------------------- */
/*  ADF Description Builder                                                    */
/* -------------------------------------------------------------------------- */

function buildAdfDescription(data: JiraTicketData): any {
  const content: any[] = [];

  // Header
  content.push({
    type: 'heading',
    attrs: { level: 3 },
    content: [{ type: 'text', text: 'Root Cause Analysis' }],
  });

  // Info table
  const infoItems = [
    ['Test Name', data.testName],
    ['Classification', data.classification.replace(/_/g, ' ')],
    ['Severity', data.severity],
    ['Flaky Test', data.isFlaky ? 'Yes' : 'No'],
    ['Healing Attempted', data.healingAttempted ? 'Yes' : 'No'],
    ['Healing Succeeded', data.healingSucceeded ? 'Yes' : 'No'],
    ['Job ID', data.jobId],
  ];
  if (data.repoName) infoItems.push(['Repository', data.repoName]);
  if (data.branch) infoItems.push(['Branch', data.branch]);

  content.push({
    type: 'table',
    attrs: { layout: 'default' },
    content: infoItems.map(([label, value]) => ({
      type: 'tableRow',
      content: [
        {
          type: 'tableCell',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: label, marks: [{ type: 'strong' }] }] }],
        },
        {
          type: 'tableCell',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
        },
      ],
    })),
  });

  // Root Cause
  content.push({
    type: 'heading',
    attrs: { level: 4 },
    content: [{ type: 'text', text: 'Root Cause' }],
  });
  content.push({
    type: 'paragraph',
    content: [{ type: 'text', text: data.rootCause }],
  });

  // Suggested Fix
  content.push({
    type: 'heading',
    attrs: { level: 4 },
    content: [{ type: 'text', text: 'Suggested Fix' }],
  });
  content.push({
    type: 'paragraph',
    content: [{ type: 'text', text: data.suggestedFix }],
  });

  // Affected Component
  if (data.affectedComponent) {
    content.push({
      type: 'heading',
      attrs: { level: 4 },
      content: [{ type: 'text', text: 'Affected Component' }],
    });
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: data.affectedComponent }],
    });
  }

  // PR Link
  if (data.prUrl) {
    content.push({
      type: 'heading',
      attrs: { level: 4 },
      content: [{ type: 'text', text: 'Healing PR' }],
    });
    content.push({
      type: 'paragraph',
      content: [
        {
          type: 'inlineCard',
          attrs: { url: data.prUrl },
        },
      ],
    });
  }

  // Footer
  content.push({
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: 'Created automatically by LevelUp AI QA',
        marks: [{ type: 'em' }],
      },
    ],
  });

  return {
    version: 1,
    type: 'doc',
    content,
  };
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

async function addComment(
  config: JiraConfig,
  issueKey: string,
  text: string,
): Promise<boolean> {
  try {
    const res = await jiraFetch(config, `/rest/api/3/issue/${issueKey}/comment`, {
      method: 'POST',
      body: JSON.stringify({
        body: {
          version: 1,
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text }],
            },
          ],
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getJiraConfig(): Promise<JiraConfig | null> {
  try {
    const cfg = await getNotificationConfigByType('jira');
    if (!cfg || cfg.status !== 'connected') return null;
    const c = cfg.config as unknown as JiraConfig;
    if (!c.instanceUrl || !c.email || !c.apiToken) return null;
    return c;
  } catch (err) {
    logger.error(MOD, 'Failed to load Jira config', { error: (err as Error).message });
    return null;
  }
}

async function logTicketCreation(
  data: JiraTicketData,
  result: CreateTicketResult,
): Promise<void> {
  try {
    await insertNotificationLog({
      tool_type: 'jira',
      event_type: 'ticket_created',
      message_preview: result.issueKey
        ? `${result.issueKey}: ${data.testName}`
        : `Failed: ${data.testName}`,
      status: result.success ? 'sent' : 'failed',
      error: result.error,
      metadata: {
        issueKey: result.issueKey,
        issueUrl: result.issueUrl,
        testName: data.testName,
        classification: data.classification,
        severity: data.severity,
        jobId: data.jobId,
      },
    });
  } catch { /* ignore log failures */ }
}
