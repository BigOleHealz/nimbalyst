import { app } from 'electron';
import { JiraClient, type JiraCredentials, type JiraIssue, type JiraProjectSettings, type JiraSyncResult } from '@nimbalyst/runtime/integrations/jira';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { getDatabase } from '../database/initialize';
import { safeHandle } from '../utils/ipcRegistry';
import { getTrackerImportService } from '../services/tracker/TrackerImportService';
import { getTrackerImporterRegistry } from '../services/tracker/TrackerImporterRegistry';
import { JiraSyncService } from '../services/jira/JiraSyncService';
import { prepareJiraTrackerLaunch } from '../services/jira/JiraLaunchService';
import { jiraProjects, jiraProjectSettings, readJiraCredentials, saveJiraCredentials, saveJiraProjectSettings } from '../services/jira/jiraSettings';

function requireWorkspace(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Jira requires workspacePath.');
  return value;
}

/** Both local task-side links and shared session-side links must protect active work. */
export async function jiraTaskHasActiveSession(workspacePath: string, id: string): Promise<boolean> {
  const db = getDatabase();
  const local = await db.query<{ data: unknown }>('SELECT data FROM tracker_items WHERE workspace = $1 AND id = $2', [workspacePath, id]);
  const raw = local.rows[0]?.data;
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw as { linkedSessions?: string[] } | undefined;
  const states = getSessionStateManager();
  const activeIds = states.getTrackedSessionIds().filter(sessionId => {
    const state = states.getSessionState(sessionId);
    return state?.status === 'running' || state?.status === 'waiting_for_input' || state?.isStreaming;
  });
  // Session links may cross into a worktree or another project. Match the
  // explicit task id, and query only active sessions rather than all history.
  const sessions = await db.query<{ id: string; status: string; metadata: unknown }>(
    `SELECT id, status, metadata FROM ai_sessions WHERE status IN ('running', 'waiting_for_input')${activeIds.length ? ` OR id IN (${activeIds.map((_, index) => `$${index + 1}`).join(', ')})` : ''}`, activeIds);
  return sessions.rows.some(row => {
    const state = states.getSessionState(row.id);
    const status = state?.status ?? row.status;
    if (status !== 'running' && status !== 'waiting_for_input' && !state?.isStreaming) return false;
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    return data?.linkedSessions?.includes(row.id) || metadata?.linkedTrackerItemIds?.includes(id);
  });
}

export function registerJiraHandlers(): void {
  safeHandle('jira:prepare-launch', (_event, args: { workspacePath: string; itemId: string }) => {
    requireWorkspace(args.workspacePath);
    return prepareJiraTrackerLaunch(args.workspacePath, args.itemId);
  });
  const client = () => {
    const credentials = readJiraCredentials();
    if (!credentials) throw new Error('Configure Jira in Settings → Project → Jira before syncing.');
    return new JiraClient(credentials);
  };
  getTrackerImporterRegistry().registerBuiltin({ id: 'jira', displayName: 'Jira', icon: 'sync', urnScheme: 'jira', backendModuleId: 'host-jira', importsAs: ['task'] }, workspacePath => ({
    isAuthenticated: async () => { await client().request('/rest/api/3/myself'); return true; },
    listBindings: async () => [{ id: client().siteUrl, label: client().siteUrl }],
    list: async ({ filters }) => {
      const jira = client();
      const page = await jira.request<{ issues: JiraIssue[]; nextPageToken?: string }>('/rest/api/3/search/jql', {
        jql: jiraProjectSettings(workspacePath).jql, maxResults: 100, fields: ['summary'], ...(filters.cursor ? { nextPageToken: filters.cursor } : {}),
      });
      return { items: page.issues.map(issue => ({ externalId: issue.key, urn: `jira://${new URL(jira.siteUrl).host}/${issue.key}`, url: `${jira.siteUrl}/browse/${issue.key}`, title: `${issue.key} ${issue.fields.summary}`, state: 'open', updatedAt: '' })), nextCursor: page.nextPageToken };
    },
    fetch: async ({ externalId }) => {
      if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(externalId)) throw new Error('Invalid Jira issue key.');
      const jira = client();
      return jira.snapshot(await jira.request<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(externalId)}?fields=summary,description`));
    },
  }));
  const service = new JiraSyncService();
  const lastRun = new Map<string, number>();
  const results = new Map<string, JiraSyncResult>();
  const sync = async (workspacePath: string): Promise<JiraSyncResult> => {
    requireWorkspace(workspacePath);
    lastRun.set(workspacePath, Date.now());
    const credentials = readJiraCredentials();
    if (!credentials) throw new Error('Configure Jira in Settings → Project → Jira before syncing.');
    const result = await service.sync(workspacePath, jiraProjectSettings(workspacePath).jql, new JiraClient(credentials), snapshot =>
      getTrackerImportService().importSnapshot({ workspacePath, providerId: 'jira', externalId: snapshot.external.externalId }, snapshot, { shouldSkip: id => jiraTaskHasActiveSession(workspacePath, id) }));
    results.set(workspacePath, result);
    return result;
  };
  safeHandle('jira:get-settings', (_event, workspacePath: string) => {
    requireWorkspace(workspacePath);
    const credentials = readJiraCredentials();
    return { ...jiraProjectSettings(workspacePath), siteUrl: credentials?.siteUrl ?? '', email: credentials?.email ?? '', hasToken: Boolean(credentials?.apiToken), lastResult: results.get(workspacePath) };
  });
  safeHandle('jira:save-settings', (_event, args: { workspacePath: string; settings: JiraProjectSettings; credentials: JiraCredentials }) => {
    requireWorkspace(args.workspacePath);
    // Empty token preserves the saved credential; never return it to the renderer.
    const existing = args.credentials.apiToken ? null : readJiraCredentials();
    if (existing && (existing.siteUrl !== args.credentials.siteUrl.replace(/\/$/, '') || existing.email !== args.credentials.email.trim())) throw new Error('Enter an API token when changing the Jira site or email.');
    saveJiraCredentials({ ...args.credentials, apiToken: args.credentials.apiToken || existing?.apiToken || '' });
    saveJiraProjectSettings(args.workspacePath, args.settings);
    lastRun.set(args.workspacePath, Date.now());
  });
  safeHandle('jira:sync', (_event, workspacePath: string) => sync(workspacePath));
  // Runs in main, independent of the currently visible project or settings panel.
  for (const workspacePath of Object.keys(jiraProjects())) lastRun.set(workspacePath, Date.now());
  const timer = setInterval(() => {
    for (const [workspacePath, settings] of Object.entries(jiraProjects())) {
      if (settings.autoSyncMinutes > 0 && Date.now() - (lastRun.get(workspacePath) ?? 0) >= settings.autoSyncMinutes * 60_000) {
        void sync(workspacePath).catch(() => results.set(workspacePath, { created: 0, refreshed: 0, skipped: 0, errors: ['Jira auto-sync failed. Check secure credentials and project settings.'] }));
      }
    }
  }, 30_000);
  timer.unref();
  app.once('before-quit', () => clearInterval(timer));
}
