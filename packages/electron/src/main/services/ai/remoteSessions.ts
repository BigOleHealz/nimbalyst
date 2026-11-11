import {getWorkspaceState} from '../../utils/store';
import { readDeployment } from '../cloudflareSandbox/deploymentStore';
import { getAgentWorkflowService } from '../AgentWorkflowService';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { findWindowByWorkspace } from '../../window/WindowManager';
import { encryptRemoteAttachments } from './remoteAttachments';
import { RemoteSessionMirror } from './RemoteSessionMirror';
import { assertProjectAllowsLocalExecution } from './projectExecution';

async function migratedHost(id: string): Promise<string | undefined> {
  const session = await AISessionsRepository.get(id);
  const migration = session?.metadata?.remoteMigration as {hostDeviceId?: unknown} | undefined;
  return typeof migration?.hostDeviceId === 'string' && migration.hostDeviceId ? migration.hostDeviceId : undefined;
}

export const remoteSessions = new RemoteSessionMirror({
  localSessionIds: async workspace => {
    const sessions = await AISessionsRepository.list(workspace, {includeArchived: true});
    return new Set((await Promise.all(sessions.map(async s => await migratedHost(s.id) ? undefined : s.id))).filter((id): id is string => !!id));
  },
  configuredHostIds: () => { const id = readDeployment()?.node?.deviceId; return new Set(id ? [id] : []); },
  encryptAttachments: encryptRemoteAttachments,
  preparePrompt: async (prompt, workspace) => {
    const invocation = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (!invocation) return prompt;
    const workflow = (await getAgentWorkflowService(workspace).listEntries({provider: 'claude-code'})).find(entry => entry.name === invocation[1] && entry.content);
    if (!workflow?.content) return prompt;
    // The selected workflow is sent as encrypted prompt text, never installed
    // as ambient settings or executed on this viewing machine.
    return `Workflow /${workflow.name} (run in the remote workspace):\n\n${workflow.content.replace(/\$ARGUMENTS/g, invocation[2] ?? '')}\n\nUser arguments: ${invocation[2] ?? ''}`;
  },
  linkedTrackerItemIds: (workspace, id) => getWorkspaceState(workspace).remoteSessionTrackerLinks?.[id],
  hasLocalSession: async id => !!await AISessionsRepository.get(id) && !await migratedHost(id),
  migratedHost,
  migratedWorkspace: async id => await migratedHost(id) ? (await AISessionsRepository.get(id))?.workspacePath : undefined,
  seedMessages: async id => (await AgentMessagesRepository.list(id, {includeHidden: true})).map((row, index) => ({...row, id: row.id ?? index + 1, createdAt: new Date(row.createdAt ?? 0)})),
  assertLocalProjectExecution: async id => {
    const session = await AISessionsRepository.get(id);
    if (session?.workspacePath) assertProjectAllowsLocalExecution(session.workspacePath);
  },
  listChanged: (workspacePath, sessionId) => {
    const window = findWindowByWorkspace(workspacePath);
    if (window && !window.isDestroyed()) window.webContents.send('sessions:refresh-list', { workspacePath, sessionId });
  },
});
