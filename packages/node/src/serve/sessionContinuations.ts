import type {CreateSessionPayload, SessionStore} from '@nimbalyst/runtime/ai/adapters/sessionStore';

/** An operator-provisioned continuation manifest; never accepted from a queued prompt. */
export interface SessionContinuation extends CreateSessionPayload {
  remoteWorkspacePath: string;
  nativeSessionPath: string;
  nativeSessionSha256: string;
  /** Explicit previous owner, required when handing off an already-owned index row. */
  sourceHostDeviceId?: string;
}

export async function importSessionContinuations(input: {
  migrationId: string;
  entries: SessionContinuation[];
  hostDeviceId: string;
  store: Pick<SessionStore, 'get' | 'createIfAbsent' | 'verifyContinuationIdentity'>;
  validate(entry: SessionContinuation): Promise<void>;
  confirm(entry: SessionContinuation): Promise<'deleted' | 'confirmed' | void>;
}): Promise<{imported: number; retained: number; deleted: number}> {
  if (!input.migrationId || !input.hostDeviceId || !Array.isArray(input.entries) || input.entries.length > 100) throw new Error('Invalid session continuation manifest.');
  const pending: SessionContinuation[] = [];
  const ids = new Set<string>();
  const nativeIds = new Set<string>();
  let retained = 0;
  for (const entry of input.entries) {
    if (!entry.id || ids.has(entry.id) || !entry.workspaceId || !['openai-codex', 'claude-code'].includes(entry.provider) || !entry.providerSessionId || !entry.remoteWorkspacePath) throw new Error('Invalid or duplicate session continuation.');
    ids.add(entry.id);
    const nativeId = JSON.stringify([entry.provider, entry.providerSessionId]);
    if (nativeIds.has(nativeId)) throw new Error('Duplicate native conversation in session continuation manifest.');
    nativeIds.add(nativeId);
    const existing = await input.store.get(entry.id);
    if (existing) {
      const migration = existing.metadata?.remoteMigration as {id?: string; originalProvider?: string; originalProviderSessionId?: string} | undefined;
      if (migration?.id !== input.migrationId || existing.workspacePath !== entry.workspaceId || existing.metadata?.hostDeviceId !== input.hostDeviceId || existing.metadata?.remoteWorkspacePath !== entry.remoteWorkspacePath) throw new Error(`Session ${entry.id} already exists outside this migration.`);
      if (migration.originalProvider === undefined && migration.originalProviderSessionId === undefined) {
        if (!input.store.verifyContinuationIdentity) throw new Error('The legacy migration needs explicit native identity verification.');
        await input.validate(entry);
        await input.store.verifyContinuationIdentity(entry.id, input.migrationId, entry.provider, entry.providerSessionId);
      } else if (migration.originalProvider !== entry.provider || migration.originalProviderSessionId !== entry.providerSessionId) throw new Error('The original native conversation identity changed in the migration manifest.');
      retained++;
      continue;
    }
    await input.validate(entry);
    pending.push(entry);
  }
  if (pending.length && !input.store.createIfAbsent) throw new Error('Session store does not support collision-safe continuation imports.');
  for (const entry of pending) {
    // Explicit fields exclude local worktree foreign keys, credentials, ambient
    // provider config, and old pending prompts. The original snapshot is retained.
    await input.store.createIfAbsent!({
      id: entry.id, workspaceId: entry.workspaceId, provider: entry.provider,
      providerSessionId: entry.providerSessionId, title: entry.title, model: entry.model,
      sessionType: entry.sessionType, mode: entry.mode, agentRole: entry.agentRole,
      parentSessionId: entry.parentSessionId, createdBySessionId: entry.createdBySessionId,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, hasBeenNamed: true,
      metadata: {
        phase: entry.metadata?.phase, tags: entry.metadata?.tags,
        linkedTrackerItemIds: entry.metadata?.linkedTrackerItemIds,
        hostDeviceId: input.hostDeviceId, remoteWorkspacePath: entry.remoteWorkspacePath,
        remoteMigration: {id: input.migrationId, originalProvider: entry.provider, originalProviderSessionId: entry.providerSessionId, sourceWorkspacePath: entry.workspaceId, sourceWorktreePath: entry.worktreePath, sourceRepositoryPath: entry.metadata?.sourceRepositoryPath},
      },
    });
  }
  let deleted = 0;
  for (const entry of input.entries) if (await input.confirm(entry) === 'deleted') deleted++;
  return {imported: pending.length, retained, deleted};
}
