import type {SyncProvider} from '@nimbalyst/runtime/sync/types';
import type {SessionContinuation} from './sessionContinuations.js';

/** A retained database row is never sufficient authority to execute a prompt. */
export async function ownsSessionExecution(provider: SyncProvider, sessionId: string, workspaceId: string, deviceId: string): Promise<boolean> {
  if (provider.isIndexReady?.() !== true || !provider.getVerifiedSessionOwnership) return false;
  const generation = provider.getConnectionGeneration?.();
  // A normal fetch replays queued rows back into intake. This server-only view
  // is verified once per connection and maintained by actual index replication.
  const entry = provider.getVerifiedSessionOwnership(sessionId);
  if (provider.getConnectionGeneration?.() !== generation) return false;
  if (!entry || entry.hostDeviceId !== deviceId || entry.projectId !== workspaceId || entry.isArchived) return false;
  const latest = provider.getCachedIndexEntry?.(sessionId);
  return !provider.getCachedIndexEntry || !!latest && latest.hostDeviceId === deviceId && latest.projectId === workspaceId && !latest.isArchived;
}

/** Retry on every startup. Missing/deleted source rows are never recreated. */
export async function confirmContinuationOwnership(provider: SyncProvider, entry: SessionContinuation, hostDeviceId: string, currentProvider = entry.provider, verifyNative?: () => Promise<void>): Promise<'confirmed' | 'deleted'> {
  if (!provider.fetchIndex) throw new Error('The remote session index is unavailable.');
  let deleted = false;
  const stop = provider.onIndexDelete?.(id => {if (id === entry.id) deleted = true;});
  try {
    await provider.waitForIndexReady?.(30_000);
    const generation = provider.getConnectionGeneration?.();
    const index = await provider.fetchIndex();
    if (provider.getConnectionGeneration?.() !== generation || index.complete === false) throw new Error('The original conversation index is unavailable.');
    if (deleted || index.deletedSessionIds?.includes(entry.id)) return 'deleted';
    const current = index.sessions.find(row => row.sessionId === entry.id);
    if (!current || current.projectId !== entry.workspaceId) throw new Error('The original conversation must already be synced in its mapped project.');
    if (current.provider && current.provider !== currentProvider) throw new Error('The indexed conversation provider does not match the imported native identity.');
    try {await verifyNative?.();} catch (error) {if (deleted) return 'deleted'; throw error;}
    if (deleted) return 'deleted';
    const latest = provider.getCachedIndexEntry?.(entry.id);
    if (provider.getConnectionGeneration?.() !== generation || (provider.getCachedIndexEntry && (!latest || latest.hostDeviceId !== current.hostDeviceId || latest.projectId !== entry.workspaceId))) throw new Error('The conversation ownership changed during native verification.');
    if (current.hostDeviceId === hostDeviceId) return 'confirmed';
    const previousHost = entry.sourceHostDeviceId ?? entry.metadata?.hostDeviceId;
    if (current.hostDeviceId && current.hostDeviceId !== previousHost) throw new Error('The original conversation belongs to an unexpected source host.');
    const idle = (row: typeof current) => !row.isExecuting && !row.queuedPrompts?.length && !(row.queuedPromptCount && row.queuedPromptCount > 0) && !row.pendingExecution;
    if (!idle(current)) throw new Error('Stop and clear the original conversation before handing off its native history.');
    const previousOwner = current.hostDeviceId;
    const isCurrent = () => {
      if (deleted || provider.getConnectionGeneration?.() !== generation) return false;
      const cached = provider.getCachedIndexEntry?.(entry.id);
      return !provider.getCachedIndexEntry || !!cached && idle(cached) && cached.projectId === entry.workspaceId &&
        (cached.hostDeviceId === previousOwner || cached.hostDeviceId === hostDeviceId);
    };
    const outcome = await provider.pushChange(entry.id, {type: 'metadata_updated', metadata: {hostDeviceId, workspaceId: entry.workspaceId}}, {isCurrent});
    if (deleted) return 'deleted';
    if (!outcome?.published || !isCurrent()) throw new Error('The conversation ownership handoff was not published. Retry startup.');
    const confirmed = await provider.fetchIndex();
    const owner = confirmed.sessions.find(row => row.sessionId === entry.id);
    if (deleted || confirmed.deletedSessionIds?.includes(entry.id)) return 'deleted';
    if (!isCurrent() || confirmed.complete === false || confirmed.deletedSessionIds?.includes(entry.id) ||
      !owner || owner.hostDeviceId !== hostDeviceId || owner.projectId !== entry.workspaceId) throw new Error('The conversation ownership handoff was not confirmed. Retry startup.');
    return 'confirmed';
  } finally {stop?.();}
}
