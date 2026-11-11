interface RemoteSessionLifecycle {
  workspaceForSession(id: string): Promise<string | undefined>;
  delete(id: string, workspace: string): Promise<void>;
  setArchived(id: string, workspace: string, isArchived: boolean): Promise<void>;
}

export async function tryRemoteSessionLifecycle(
  remote: RemoteSessionLifecycle,
  sessionId: string,
  workspacePath: string | undefined,
  action: {type: 'delete'} | {type: 'archive'; isArchived: boolean},
): Promise<boolean> {
  const remoteWorkspace = await remote.workspaceForSession(sessionId);
  if (!remoteWorkspace) return false;
  if (!workspacePath || remoteWorkspace !== workspacePath) throw new Error('Session is not available in the selected workspace.');
  if (action.type === 'delete') await remote.delete(sessionId, workspacePath);
  else await remote.setArchived(sessionId, workspacePath, action.isArchived);
  return true;
}
