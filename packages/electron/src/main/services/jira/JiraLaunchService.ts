import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JiraClient, JiraError, type JiraLaunchContext } from '@nimbalyst/runtime/integrations/jira';
import { formatJiraLaunchEvidence, JIRA_AGENT_LAUNCH_INSTRUCTIONS } from '@nimbalyst/runtime/integrations/jiraLaunchPrompt';
import { getDatabase } from '../../database/initialize';
import { readLocalTrackerBody } from '../tracker/pageTypeBodyCheck';
import { readHeadlessBodyMarkdown } from '../MainBodyDocService';
import { ensureWorkspaceTrackerSchemasLoaded } from '../TrackerSchemaService';
import { resolveTrackerSharingPolicy, shouldSyncTrackerItem } from '../TrackerPolicyService';
import { jiraProjectSettings, readJiraCredentials } from './jiraSettings';
import type { ExternalSourceRef } from '@nimbalyst/tracker-core';

const LAUNCH_CONTEXT_BUDGET = 48_000;

/** Produces a read-only snapshot; no tracker mutation or Jira write-back. */
export async function prepareJiraTrackerLaunch(workspacePath: string, itemId: string): Promise<{ draftInput: string; contextPath: string }> {
  if (!workspacePath?.trim() || !itemId?.trim()) throw new Error('Jira launch requires workspacePath and itemId.');
  const result = await getDatabase().query<{ id: string; type: string; title: string; data: unknown }>(
    'SELECT id, type, title, data FROM tracker_items WHERE id = $1 AND workspace = $2', [itemId, workspacePath],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Jira tracker item not found in this workspace.');
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  type LaunchMetadata = { origin?: { kind: string; external?: ExternalSourceRef }; comments?: unknown; customFields?: LaunchMetadata };
  const metadata = data as LaunchMetadata | null;
  const origin = metadata?.origin ?? metadata?.customFields?.origin;
  const external = origin?.external;
  if (origin?.kind !== 'external' || external?.providerId !== 'jira') throw new Error('This tracker item is not imported from Jira.');

  let cachedBody: string | null = null;
  try { cachedBody = await readLocalTrackerBody(workspacePath, itemId); } catch { /* Explicitly labelled unavailable below. */ }
  let canonicalBody: string | null = null;
  try {
    await ensureWorkspaceTrackerSchemasLoaded(workspacePath);
    const resolution = resolveTrackerSharingPolicy(workspacePath, row.type);
    if (resolution.known) {
      canonicalBody = shouldSyncTrackerItem(resolution.policy, data as Record<string, unknown>)
        ? await readHeadlessBodyMarkdown(workspacePath, itemId)
        : cachedBody;
    }
  } catch { /* An inaccessible canonical body must never be reported as empty. */ }

  let upstream: JiraLaunchContext | undefined;
  let refreshError: string | undefined;
  try {
    const credentials = readJiraCredentials();
    if (!credentials) throw new JiraError('Jira connection is not configured.');
    const client = new JiraClient(credentials);
    // A changed account/site must not silently refresh a different APP-1.
    if (new URL(external.url).origin !== client.siteUrl) throw new Error('The configured Jira site does not match this imported ticket site.');
    upstream = await client.launchContext(external.externalId, jiraProjectSettings(workspacePath).acceptanceCriteriaFieldIds);
  } catch (error) {
    if (error instanceof Error && error.message === 'The configured Jira site does not match this imported ticket site.') throw error;
    refreshError = error instanceof JiraError ? error.message : 'Jira refresh failed. Cached upstream context is stale; investigate with an authorized connection.';
  }
  const localComments = metadata;
  const packet = [
    `# Jira ticket launch evidence\n\nTracker: ${itemId}\nWorkspace: ${workspacePath}\nLocal title: ${row.title}\nJira: ${external.externalId}\n${external.url}`,
    `Last imported upstream context: ${external.lastSyncedAt ?? 'unknown'} (cached; potentially stale).`,
    '## Canonical tracker body and local additions\n\nThis is the current tracker body; it may combine the earlier Jira import with local additions. Compare it with the separate upstream snapshot; preserve local additions and resolve contradictions.',
    canonicalBody === null ? 'canonical body unavailable; do not interpret this as empty. The following local cache may be stale.' : 'Canonical body resolved.',
    canonicalBody ?? cachedBody ?? 'Local body cache unavailable.',
    localComments?.comments || localComments?.customFields?.comments ? `## Local tracker comments\n\n${JSON.stringify(localComments.comments ?? localComments.customFields?.comments, null, 2)}` : '',
    upstream ? formatJiraLaunchEvidence(upstream) : `## Upstream Jira refresh failed\n\n${refreshError}\nCached upstream content is stale as of ${external.lastSyncedAt ?? 'unknown'}.`,
  ].join('\n\n');
  // Private, durable artifact outside the repository: survives worktree creation,
  // provider changes and restarts, without adding ticket content to Git.
  const directory = join(app.getPath('userData'), 'tracker-launch-context');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const contextPath = join(directory, `${randomUUID()}.md`);
  await writeFile(contextPath, packet, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const reference = `Complete ticket evidence: ${JSON.stringify(contextPath)} (${packet.length} characters, ${packet.split('\n').length} lines). Read the entire file with filesystem tools, using successive offset/limit reads if needed, before implementing. Do not treat a bounded tool preview as the complete file. This absolute path is valid from the original repository and the new worktree.`;
  const draft = (evidence: string) => `${JIRA_AGENT_LAUNCH_INSTRUCTIONS}\n\n${reference}\n\n--- BEGIN TASK EVIDENCE ---\n\n${evidence}\n\n--- END TASK EVIDENCE ---`;
  const completeDraft = draft(packet);
  return { contextPath, draftInput: completeDraft.length <= LAUNCH_CONTEXT_BUDGET ? completeDraft
    : draft('Ticket evidence exceeds the launch context budget. No ticket content was truncated; retrieve the complete continuation file above.') };
}
