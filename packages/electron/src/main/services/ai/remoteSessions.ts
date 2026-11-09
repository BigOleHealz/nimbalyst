import {getWorkspaceState} from '../../utils/store';
import { readDeployment } from '../cloudflareSandbox/deploymentStore';
import { getAgentWorkflowService } from '../AgentWorkflowService';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { findWindowByWorkspace } from '../../window/WindowManager';
import { encryptRemoteAttachments } from './remoteAttachments';
import { RemoteSessionMirror } from './RemoteSessionMirror';
import { assertProjectAllowsLocalExecution } from './projectExecution';

export const remoteSessions = new RemoteSessionMirror({
  localSessionIds: async workspace => new Set((await AISessionsRepository.list(workspace, {includeArchived: true})).map(s => s.id)),
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
  hasLocalSession: async id => !!await AISessionsRepository.get(id),
  assertLocalProjectExecution: async id => {
    const session = await AISessionsRepository.get(id);
    if (session?.workspacePath) assertProjectAllowsLocalExecution(session.workspacePath);
  },
  listChanged: (workspacePath, sessionId) => {
    const window = findWindowByWorkspace(workspacePath);
    if (window && !window.isDestroyed()) window.webContents.send('sessions:refresh-list', { workspacePath, sessionId });
  },
});
