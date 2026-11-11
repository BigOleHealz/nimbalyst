import { projectRemoteHosts } from './remoteHostInventory';
import { createHash, randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger';
import { TranscriptRuntime } from '@nimbalyst/runtime/ai/server/transcript/TranscriptRuntime';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptTransformer';
import type { ChatAttachment, SessionData } from '@nimbalyst/runtime/ai/server/types';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { DeviceInfo, SyncProvider } from '@nimbalyst/runtime/sync/types';
import { isSessionConnectionRefused } from '@nimbalyst/runtime/sync/SyncedSessionStore';

type IndexEntry = NonNullable<Awaited<ReturnType<NonNullable<SyncProvider['fetchIndex']>>>>['sessions'][number];
import type { RemoteSessionSnapshot } from '../../../shared/remoteSessions';
export type { RemoteSessionSnapshot } from '../../../shared/remoteSessions';
interface Observation {
  entry: IndexEntry;
  rows: Map<number, RawMessage>;
  bytes: number;
  listeners: Set<(snapshot: RemoteSessionSnapshot) => void>;
  runtime: TranscriptRuntime;
  dispose(): void;
  timer?: ReturnType<typeof setTimeout>;
  publishing?: Promise<void>;
  dirty: boolean;
  error?: string;
  rowVersion: number;
  projectedVersion: number;
}

/** Account-scoped, read-only mirrors. Nothing is inserted into the execution store. */
export class RemoteSessionMirror {
  private provider: SyncProvider | null = null;
  private encryptionKey: CryptoKey | null = null;
  private entries = new Map<string, IndexEntry>();
  private observations = new Map<string, Observation>();
  private unlistenIndex?: () => void;
  private unlistenIndexDelete?: () => void;
  private unlistenDevices?: () => void;
  private refreshInFlight?: Promise<void>;
  private refreshedAt = 0;
  private deletedIds = new Set<string>();
  private providerGeneration = 0;
  private initializing = new Map<string, Promise<Observation>>();
  private writeQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: {
    preparePrompt?(prompt: string, workspace: string): Promise<string>;
    encryptAttachments?(attachments: ChatAttachment[], workspace: string, key: CryptoKey): Promise<import("@nimbalyst/runtime/sync/types").EncryptedAttachment[]>;
    localSessionIds(workspace: string): Promise<Set<string>>;
    configuredHostIds?(): Set<string>;
    linkedTrackerItemIds?(workspace: string, sessionId: string): string[] | undefined;
    hasLocalSession(id: string): Promise<boolean>;
    /** An explicit, retained local copy whose execution was moved to this host. */
    migratedHost?(id: string): Promise<string | undefined>;
    migratedWorkspace?(id: string): Promise<string | undefined>;
    seedMessages?(id: string): Promise<RawMessage[]>;
    assertLocalProjectExecution?(id: string): Promise<void>;
    listChanged(workspacePath: string, sessionId: string): void;
  }) {}

  setProvider(provider: SyncProvider | null, encryptionKey: CryptoKey | null = null): void {
    this.encryptionKey = encryptionKey;
    if (provider === this.provider) return;
    this.providerGeneration++;
    this.initializing.clear();
    this.deletedIds.clear();
    this.unlistenIndex?.();
    this.unlistenIndexDelete?.();
    this.unlistenDevices?.();
    for (const [id, observation] of this.observations) {
      observation.dispose();
      this.provider?.disconnect(id);
      for (const listener of observation.listeners) listener({
        session: this.sessionData(observation.entry, []), connected: false,
        hostOnline: false, syncing: false, executing: false, queuedPrompts: [],
        error: 'Session sync changed. Reopen this remote session to reconnect.',
      });
    }
    for (const workspace of new Set([...this.entries.values()].map(entry => entry.projectId))) this.deps.listChanged(workspace, "");
    this.observations.clear(); this.entries.clear();
    this.refreshInFlight = undefined; this.refreshedAt = 0;
    this.provider = provider;
    this.unlistenIndex = provider?.onIndexChange?.((id) => {
      if (this.provider !== provider) return;
      const cached = provider.getCachedIndexEntry?.(id);
      if (!cached) { this.removeEntry(id); return; }
      if (!this.isRemoteHost(cached.hostDeviceId)) return;
      const entry = { ...this.entries.get(id), ...cached, sessionId: id } as IndexEntry;
      if (!entry.projectId) return;
      this.entries.set(id, entry);
      const observation = this.observations.get(id);
      if (observation) {
        const resumeTranscript = entry.isExecuting || (entry.messageCount ?? 0) > (observation.entry.messageCount ?? 0);
        observation.entry = entry;
        if (resumeTranscript && !provider.getStatus(id).connected) {
          void provider.connect(id).catch(() => { observation.error = 'The remote transcript could not reconnect. Reopen it to retry.'; this.schedule(id, observation); });
        }
        this.schedule(id, observation);
      }
      this.deps.listChanged(entry.projectId, id);
    });
    this.unlistenIndexDelete = provider?.onIndexDelete?.(id => {
      if (this.provider === provider) this.removeEntry(id);
    });
    this.unlistenDevices = provider?.onDeviceStatusChange?.(() => {
      for (const [id, observation] of this.observations) this.schedule(id, observation);
    });
  }

  private isRemoteHost(host?: string): boolean {
    if (!host || host === this.provider?.getLocalDeviceInfo?.()?.deviceId) return false;
    const device = this.provider?.getConnectedDevices?.().find(device => device.deviceId === host);
    return !device || host.startsWith('sandbox-') || device.type === 'unknown' || device.type === 'headless' || device.type === 'desktop';
  }
  isRemote(sessionId: string): boolean {
    return this.isRemoteHost(this.provider?.getCachedIndexEntry?.(sessionId)?.hostDeviceId ?? this.entries.get(sessionId)?.hostDeviceId);
  }
  async assertLocalExecution(sessionId: string): Promise<void> {
    if (await this.deps.migratedHost?.(sessionId)) throw new Error('This conversation continues on its remote machine.');
    await this.deps.assertLocalProjectExecution?.(sessionId);
    if (this.isRemote(sessionId) && !await this.deps.hasLocalSession(sessionId)) {
      throw new Error('Use the sandbox controls to send this prompt to its host.');
    }
  }
  private async refresh(): Promise<void> {
    if (!this.provider?.fetchIndex || Date.now() - this.refreshedAt < 5000) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    const provider = this.provider;
    const attempt = (async () => {
      const index = await provider.fetchIndex!();
      if (index.complete === false) throw new Error('The remote session index is incomplete. Reconnect and retry.');
      if (this.provider !== provider) return;
      const next = new Map(index.sessions.filter(entry => this.isRemoteHost(entry.hostDeviceId)).map(entry => [entry.sessionId, entry]));
      this.entries = next;
      for (const id of index.deletedSessionIds ?? []) this.deletedIds.add(id);
      for (const id of next.keys()) this.deletedIds.delete(id);
      this.refreshedAt = Date.now();
    })();
    this.refreshInFlight = attempt;
    try { await attempt; }
    finally { if (this.refreshInFlight === attempt) this.refreshInFlight = undefined; }
  }
  async list(workspacePath: string, local: SessionMeta[]): Promise<SessionMeta[]> {
    try { await this.refresh(); } catch { /* Local history remains usable offline. */ }
    const retained = await Promise.all(local.map(async row => {
      const host = await this.deps.migratedHost?.(row.id);
      if (!host) return row;
      const recordedWorkspace = await this.deps.migratedWorkspace?.(row.id);
      if (recordedWorkspace && recordedWorkspace !== workspacePath) return undefined;
      const entry = this.entries.get(row.id);
      // Only an explicit tombstone proves deletion. An unknown/expired index
      // row must not hide the user's retained recovery history.
      if (this.deletedIds.has(row.id)) return undefined;
      const current = entry?.projectId === workspacePath && entry.hostDeviceId === host ? entry : undefined;
      return {
        ...row,
        ...(current ? {
          title: current.title || row.title, isArchived: !!current.isArchived, isPinned: !!current.isPinned,
          parentSessionId: current.parentSessionId ?? null, createdBySessionId: current.createdBySessionId ?? null,
          updatedAt: current.updatedAt,
          messageCount: Math.max(row.messageCount ?? 0, current.messageCount ?? 0),
        } : {}),
        remoteHostDeviceId: host, worktreeId: null, uncommittedCount: 0,
      };
    }));
    local = retained.filter((row): row is SessionMeta => !!row);
    const ids = new Set(local.map(entry => entry.id));
    const provider = this.provider;
    const remote: SessionMeta[] = [];
    const childCounts = new Map<string, number>();
    const descendantCounts = new Map<string, number>();
    for (const child of this.entries.values()) {
      let parentId = child.parentSessionId;
      const seen = new Set([child.sessionId]);
      let direct = true;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = this.entries.get(parentId);
        if (!parent || parent.projectId !== child.projectId || parent.hostDeviceId !== child.hostDeviceId) break;
        const key = `${child.hostDeviceId}:${parentId}`;
        if (direct) childCounts.set(key, (childCounts.get(key) ?? 0) + 1);
        descendantCounts.set(key, (descendantCounts.get(key) ?? 0) + 1);
        direct = false;
        parentId = parent.parentSessionId;
      }
    }
    for (const entry of this.entries.values()) {
      if (entry.projectId !== workspacePath || ids.has(entry.sessionId)) continue;
      const recordedWorkspace = await this.deps.migratedWorkspace?.(entry.sessionId);
      if (recordedWorkspace && recordedWorkspace !== workspacePath) continue;
      if (await this.deps.hasLocalSession(entry.sessionId)) continue;
      if (this.provider !== provider) return local;
      remote.push({
        id: entry.sessionId, title: entry.title || 'Sandbox session', provider: entry.provider,
        model: entry.model, sessionType: entry.sessionType === 'workstream' ? 'workstream' : entry.sessionType === 'blitz' ? 'blitz' : 'session', mode: entry.mode ?? 'agent',
        workspaceId: workspacePath, worktreeId: null, parentSessionId: entry.parentSessionId ?? null,
        childCount: childCounts.get(`${entry.hostDeviceId}:${entry.sessionId}`) ?? 0, uncommittedCount: 0, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
        descendantCount: descendantCounts.get(`${entry.hostDeviceId}:${entry.sessionId}`) ?? 0,
        createdBySessionId: entry.createdBySessionId ?? null,
        messageCount: entry.messageCount, isArchived: !!entry.isArchived, isPinned: !!entry.isPinned,
        remoteHostDeviceId: entry.hostDeviceId,
        linkedTrackerItemIds: this.deps.linkedTrackerItemIds?.(workspacePath, entry.sessionId),
      });
    }
    return [...local, ...remote].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private async requireEntry(id: string, workspace: string): Promise<IndexEntry> {
    const provider = this.provider;
    await this.assertMigrationWorkspace(id, workspace);
    await this.refresh();
    const entry = this.entries.get(id);
    if (!entry || !this.isRemoteHost(entry.hostDeviceId) || entry.projectId !== workspace || await this.deps.hasLocalSession(id)) {
      throw new Error('This remote session is not available in this workspace.');
    }
    const migratedHost = await this.deps.migratedHost?.(id);
    if (migratedHost && migratedHost !== entry.hostDeviceId) throw new Error('The remote host does not match this conversation’s migration record.');
    if (provider !== this.provider) throw new Error('Session sync changed. Reopen this remote session.');
    return entry;
  }
  private async assertMigrationWorkspace(id: string, workspace: string): Promise<void> {
    const recordedWorkspace = await this.deps.migratedWorkspace?.(id);
    if (recordedWorkspace && recordedWorkspace !== workspace) throw new Error('The migrated conversation belongs to another workspace.');
  }
  private sessionData(entry: IndexEntry, messages: SessionData['messages']): SessionData {
    return {
      id: entry.sessionId, title: entry.title || 'Sandbox session', provider: entry.provider,
      model: entry.model, sessionType: entry.sessionType === 'workstream' ? 'workstream' : entry.sessionType === 'blitz' ? 'blitz' : 'session', mode: entry.mode ?? 'agent',
      workspacePath: entry.projectId, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
      messages, isArchived: entry.isArchived, isPinned: entry.isPinned,
      parentSessionId: entry.parentSessionId,
      metadata: { remoteHostDeviceId: entry.hostDeviceId },
    };
  }
  async workspaceForSession(id: string): Promise<string | undefined> {
    const migratedWorkspace = await this.deps.migratedWorkspace?.(id);
    if (migratedWorkspace) return migratedWorkspace;
    if (await this.deps.migratedHost?.(id)) throw new Error('The migrated conversation workspace is unavailable.');
    if (await this.deps.hasLocalSession(id)) return undefined;
    await this.refresh();
    const entry = this.entries.get(id);
    return entry && this.isRemoteHost(entry.hostDeviceId) && !await this.deps.hasLocalSession(id) ? entry.projectId : undefined;
  }
  async get(id: string, workspace: string): Promise<SessionData | null> {
    await this.assertMigrationWorkspace(id, workspace);
    if (await this.deps.hasLocalSession(id)) return null;
    if (this.deletedIds.has(id)) throw new Error('This remote conversation was deleted.');
    try { await this.refresh(); } catch {
      if (this.deletedIds.has(id)) throw new Error('This remote conversation was deleted.');
      return null;
    }
    if (this.deletedIds.has(id)) throw new Error('This remote conversation was deleted.');
    if (!this.entries.has(id)) return null;
    const entry = await this.requireEntry(id, workspace);
    return this.sessionData(entry, []);
  }
  private hostOnline(entry: IndexEntry): boolean {
    if (this.provider?.isIndexReady?.() === false) return false;
    return this.provider?.getConnectedDevices?.().some(device => device.deviceId === entry.hostDeviceId && device.isOnline !== false) ?? false;
  }
  private readOnlyReason(entry: IndexEntry): string | undefined {
    const host = this.provider?.getConnectedDevices?.().find(device => device.deviceId === entry.hostDeviceId);
    // Headless connectedAt is fixed at process startup, including across token
    // refresh/socket reconnects. A new process cannot resume ephemeral sessions.
    if (host?.type === 'headless' && !host.persistentWorkspaces && Number.isFinite(host.connectedAt) && host.connectedAt > entry.createdAt) {
      return 'The sandbox restarted after this session began. Its transcript is available, but start a new sandbox session to continue working.';
    }
    return undefined;
  }
  private async snapshot(id: string, observation: Observation): Promise<RemoteSessionSnapshot> {
    const status = this.provider?.getStatus(id);
    const version = observation.rowVersion;
    if (observation.projectedVersion !== version) {
      await observation.runtime.forceReparseSession(id, observation.entry.provider);
      observation.projectedVersion = version;
    }
    return {
      session: this.sessionData(observation.entry, await observation.runtime.getViewMessages(id, observation.entry.provider)),
      connected: status?.connected ?? false, hostOnline: this.hostOnline(observation.entry),
      syncing: status?.syncing ?? false, executing: observation.entry.isExecuting ?? false,
      readOnlyReason: this.readOnlyReason(observation.entry),
      queuedPrompts: observation.entry.queuedPrompts ?? [], error: observation.error ?? status?.error ?? undefined,
    };
  }
  private schedule(id: string, observation: Observation): void {
    observation.dirty = true;
    if (observation.timer || observation.publishing) return;
    observation.timer = setTimeout(() => {
      observation.timer = undefined;
      observation.dirty = false;
      observation.publishing = this.snapshot(id, observation).then(snapshot => {
        if (this.observations.get(id) !== observation) return;
        for (const listener of observation.listeners) listener(snapshot);
      }).catch(() => { observation.error = 'The remote transcript could not be read. Reopen it to retry.'; }).finally(() => {
        observation.publishing = undefined;
        if (observation.dirty && this.observations.get(id) === observation) this.schedule(id, observation);
      });
    }, 150);
  }
  private async initializeObservation(id: string, workspace: string, entry: IndexEntry, provider: SyncProvider, generation: number): Promise<Observation> {
    if (new Set([...this.observations.keys(), ...this.initializing.keys()]).size >= 4) throw new Error('Close another remote transcript before opening this one.');
    const rows = new Map<number, RawMessage>();
    const identity = (row: Pick<RawMessage, 'source' | 'direction' | 'createdAt' | 'content'>) => createHash('sha256').update(JSON.stringify([row.source, row.direction, new Date(row.createdAt).getTime(), row.content])).digest('hex');
    const identities = new Set<string>();
    // The original database remains the recovery copy. Seed its history without
    // uploading it again or counting it against the live remote receive limit.
    if (await this.deps.migratedHost?.(id)) {
      const seed = await this.deps.seedMessages?.(id) ?? [];
      for (const [index, row] of seed.entries()) {
        if (row.sessionId !== id) throw new Error('Mismatched migrated transcript.');
        const seedId = index - seed.length;
        rows.set(seedId, {...row, id: seedId, createdAt: new Date(row.createdAt)});
        identities.add(identity(row));
      }
    }
    if (provider !== this.provider || generation !== this.providerGeneration) throw new Error('Session sync changed. Reopen this remote session.');
    const live = this.entries.get(id);
    if (this.deletedIds.has(id) || !live || live.hostDeviceId !== entry.hostDeviceId || live.projectId !== workspace) throw new Error('Session sync changed. Reopen this remote session.');
    let receivedRows = 0;
    const runtime = new TranscriptRuntime({ getMessages: async (_id, afterId) => [...rows.values()]
      // A retained row can arrive after the answer it preceded. Wire receipt
      // order is not agent turn order; timestamp ties keep the room sequence.
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)
      .map((row, index) => ({ ...row, id: index + 1 }))
      .filter(row => afterId === undefined || row.id > afterId)
    }, { cacheCap: 1 });
    const observation: Observation = { entry, rows, runtime, bytes: 0, dirty: false, rowVersion: 0, projectedVersion: -1, listeners: new Set(), dispose() {} };
    this.observations.set(id, observation);
    const current = observation;
    const offChange = provider.onRemoteChange(id, change => {
      if (change.type !== 'message_added' || change.message.sessionId !== id) return;
      const message = change.message;
      if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || message.id <= 0 || rows.has(message.id)) return;
      const messageIdentity = identity({...message, createdAt: new Date(message.createdAt ?? 0)});
      if (identities.has(messageIdentity)) return;
      const bytes = Buffer.byteLength(message.content, 'utf8');
      if (current.bytes + bytes > 8 * 1024 * 1024 || receivedRows >= 20000) {
        current.error = 'This remote transcript exceeds the desktop viewing limit.';
        offChange(); provider.disconnect(id); this.schedule(id, current); return;
      }
      current.bytes += bytes;
      receivedRows++;
      rows.set(message.id, { ...message, id: message.id, createdAt: new Date(message.createdAt ?? 0) });
      current.rowVersion++;
      this.schedule(id, current);
    });
    const offStatus = provider.onStatusChange(id, () => this.schedule(id, current));
    current.dispose = () => { offChange(); offStatus(); if (current.timer) clearTimeout(current.timer); };
    void provider.connect(id).catch(() => {
      current.error = 'The sandbox transcript could not connect. Reopen it to retry.';
      this.schedule(id, current);
    });
    return current;
  }
  async watch(id: string, workspace: string, listener: (snapshot: RemoteSessionSnapshot) => void): Promise<() => void> {
    const provider = this.provider;
    const generation = this.providerGeneration;
    const entry = await this.requireEntry(id, workspace);
    if (!provider) throw new Error('Session sync is not connected.');
    if (provider !== this.provider || generation !== this.providerGeneration) throw new Error('Session sync changed. Reopen this remote session.');
    let observation = this.observations.get(id);
    if (!observation) {
      let pending = this.initializing.get(id);
      if (!pending) {
        pending = this.initializeObservation(id, workspace, entry, provider, generation);
        this.initializing.set(id, pending);
        const started = pending;
        void pending.finally(() => {if (this.initializing.get(id) === started) this.initializing.delete(id);}).catch(() => {});
      }
      observation = await pending;
    }
    if (provider !== this.provider || generation !== this.providerGeneration || this.observations.get(id) !== observation) throw new Error('Session sync changed. Reopen this remote session.');
    observation.listeners.add(listener);
    this.schedule(id, observation);
    const current = observation;
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size || this.observations.get(id) !== current) return;
      current.dispose(); this.observations.delete(id); provider.disconnect(id);
    };
  }
  queue(id: string, workspace: string, prompt: string, attachments: ChatAttachment[] = [], options?: import("@nimbalyst/runtime/sync/types").RemoteTurnOptions): Promise<{promptId: string}> {
    const provider = this.provider;
    return this.serializeWrite(id, () => {
      if (provider !== this.provider) throw new Error('Session sync changed. Keep the draft and retry.');
      return this.queueNow(id, workspace, prompt, attachments, options);
    });
  }
  private async queueNow(id: string, workspace: string, prompt: string, attachments: ChatAttachment[] = [], options?: import("@nimbalyst/runtime/sync/types").RemoteTurnOptions): Promise<{ promptId: string }> {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000) throw new Error('Enter a prompt of at most 100,000 characters.');
    const entry = await this.requireEntry(id, workspace);
    if (entry.isArchived) throw new Error('Restore this archived remote session before sending a prompt.');
    const provider = this.provider;
    if (!provider || !this.hostOnline(entry)) throw new Error('The sandbox is offline. Your prompt has not been sent.');
    const readOnlyReason = this.readOnlyReason(entry);
    if (readOnlyReason) throw new Error(readOnlyReason);
    if (attachments.length && (!this.encryptionKey || !this.deps.encryptAttachments)) throw new Error("Attachment encryption is not ready. Keep the draft and retry.");
    // Empty session rooms can expire while a draft is open. Queue delivery uses
    // the index connection; reattach the existing observer before starting work.
    // With every room socket busy the observer stays detached, but the prompt can still go out.
    if (this.observations.has(id) && !provider.getStatus(id).connected) await provider.connect(id).catch(error => { if (!isSessionConnectionRefused(error)) throw error; });
    if (provider !== this.provider) throw new Error('Session sync changed. Keep the draft and retry.');
    const preparedPrompt = this.deps.preparePrompt ? await this.deps.preparePrompt(prompt, workspace) : prompt;
    const encrypted = attachments.length ? await this.deps.encryptAttachments!(attachments, workspace, this.encryptionKey!) : [];
    if (provider !== this.provider) throw new Error("Session sync changed. Keep the draft and retry.");
    const promptId = `remote-${randomUUID()}`;
    const cached = provider.getCachedIndexEntry?.(id);
    const queue = cached?.queuedPrompts ?? entry.queuedPrompts ?? [];
    const outcome = await provider.pushChange(id, { type: 'metadata_updated', metadata: {
      queuedPrompts: [...queue, { id: promptId, prompt: preparedPrompt.trim(), timestamp: Date.now(), ...(encrypted.length ? {attachments: encrypted} : {}), ...(options ? {options} : {}) }],
    } });
    if (outcome && !outcome.published) {
      logger.main.warn(`[RemoteSessionMirror] Failed to publish prompt for session ${id}: ${outcome.reason ?? 'not published'}`);
      throw new Error('The prompt could not be sent. Keep it and retry when connected.');
    }
    return { promptId };
  }
  async workspaceContext(id: string, workspace: string): Promise<unknown> {
    const entry = await this.requireEntry(id, workspace);
    const provider = this.provider;
    const key = this.encryptionKey;
    if (!key || !provider?.sendSessionControlMessage || !provider.onSessionControlMessage || !this.hostOnline(entry)) throw new Error('The remote workspace is unavailable.');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('The remote machine did not return its file and command list.')); }, 15000);
      const off = provider.onSessionControlMessage!(message => {
        if (message.type !== 'workspace-context-response' || message.sessionId !== id || message.payload?.requestId !== requestId || message.sentByDeviceId !== entry.hostDeviceId) return;
        clearTimeout(timer); off();
        if (provider !== this.provider) return reject(new Error('Session sync changed.'));
        const payload = message.payload;
        if (typeof payload.encrypted !== 'string' || payload.encrypted.length > 1024 * 1024 || typeof payload.iv !== 'string') return reject(new Error('Invalid remote workspace response.'));
        void crypto.subtle.decrypt({name: 'AES-GCM', iv: Buffer.from(payload.iv, 'base64')}, key, Buffer.from(payload.encrypted, 'base64'))
          .then(data => { if (provider !== this.provider) throw new Error('Session sync changed.'); return JSON.parse(new TextDecoder().decode(data)); }).then(resolve, reject);
      });
      void provider.sendSessionControlMessage!({sessionId: id, type: 'workspace-context-request', targetDeviceId: entry.hostDeviceId, sentByDeviceId: provider.getLocalDeviceInfo?.()?.deviceId, sentBy: 'desktop', timestamp: Date.now(), payload: {requestId}}).catch(error => {clearTimeout(timer); off(); reject(error);});
    });
  }

  async hosts(workspace: string): Promise<DeviceInfo[]> {
    if (!workspace) throw new Error('workspace is required');
    try { await this.refresh(); } catch { /* Retain offline history. */ }
    const provider = this.provider;
    if (!provider) return [];
    const localIds = await this.deps.localSessionIds(workspace);
    if (provider !== this.provider) return [];
    return projectRemoteHosts({
      devices: provider.getConnectedDevices?.() ?? [],
      localDeviceId: provider.getLocalDeviceInfo?.()?.deviceId,
      historyHostIds: new Set([...this.entries.values()].filter(e => e.projectId === workspace && !localIds.has(e.sessionId)).map(e => e.hostDeviceId).filter((id): id is string => !!id)),
      configuredHostIds: this.deps.configuredHostIds?.() ?? new Set(),
    });
  }

  async create(workspace: string, host: string, options: {prompt?: string; model?: string; parentSessionId?: string; worktree?: boolean} = {}): Promise<string> {
    const provider = this.provider;
    const device = provider?.getConnectedDevices?.().find(device => device.deviceId === host && device.isOnline !== false);
    if (!device || !this.isRemoteHost(host) || !provider?.sendCreateSessionRequest || !provider.onCreateSessionResponse) throw new Error('The selected machine is offline.');
    if (options.worktree && !device.persistentWorkspaces) throw new Error('This remote host does not support creating worktrees yet.');
    if (options.parentSessionId && (await this.requireEntry(options.parentSessionId, workspace)).hostDeviceId !== host) throw new Error("The parent session belongs to another machine.");
    if (provider !== this.provider) throw new Error('Session sync changed.');
    const initialPrompt = options.prompt && this.deps.preparePrompt ? await this.deps.preparePrompt(options.prompt, workspace) : options.prompt;
    if (provider !== this.provider) throw new Error("Session sync changed.");
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('The remote machine did not answer. Check its status before retrying.')); }, 60000);
      const off = provider.onCreateSessionResponse!(response => {
        if (response.requestId !== requestId) return;
        clearTimeout(timer); off();
        if (provider !== this.provider) return reject(new Error('Session sync changed.'));
        if (response.success && response.sessionId) { this.refreshedAt = 0; resolve(response.sessionId); }
        else reject(new Error(response.error || 'The remote session could not be created.'));
      });
      void provider.sendCreateSessionRequest!({requestId, projectId: workspace, targetDeviceId: host, provider: options.model?.startsWith('openai-codex:') ? 'openai-codex' : 'claude-code', model: options.model, parentSessionId: options.parentSessionId, initialPrompt, timestamp: Date.now()})
        .catch(error => { clearTimeout(timer); off(); reject(error); });
    });
  }

  async cancel(id: string, workspace: string): Promise<void> {
    const entry = await this.requireEntry(id, workspace);
    if (!this.provider?.sendSessionControlMessage || !this.hostOnline(entry)) throw new Error('The sandbox is offline.');
    const readOnlyReason = this.readOnlyReason(entry);
    if (readOnlyReason) throw new Error(readOnlyReason);
    await this.provider.sendSessionControlMessage({ sessionId: id, type: 'cancel', targetDeviceId: entry.hostDeviceId, timestamp: Date.now(), sentBy: 'desktop' });
  }

  private serializeWrite<T>(_id: string, write: () => Promise<T>): Promise<T> {
    // A parent lifecycle write also touches descendants. One short publication
    // queue prevents any window from slipping a child prompt into that write.
    const next = this.writeQueue.catch(() => {}).then(write);
    this.writeQueue = next;
    return next;
  }

  private removeEntry(id: string): void {
    this.deletedIds.add(id);
    const entry = this.entries.get(id);
    const observation = this.observations.get(id);
    if (observation) {
      observation.dispose(); this.observations.delete(id);
      this.provider?.disconnect(id);
      for (const listener of observation.listeners) listener({
        session: this.sessionData(observation.entry, []), connected: false, hostOnline: false,
        syncing: false, executing: false, queuedPrompts: [], error: 'This remote session was deleted.',
      });
    }
    this.entries.delete(id);
    if (entry) this.deps.listChanged(entry.projectId, id);
  }

  private assertIdle(entry: IndexEntry): void {
    if (entry.isExecuting || entry.queuedPrompts?.length) {
      throw new Error('This remote session has running or queued work. Stop it and clear its queue before archiving or deleting it.');
    }
  }

  private async publishLifecycle(id: string, change: import('@nimbalyst/runtime/sync/types').SessionChange): Promise<void> {
    const provider = this.provider;
    if (!provider || provider.isIndexReady?.() === false) throw new Error('Session sync is disconnected. Reconnect and retry.');
    const outcome = await provider.pushChange(id, change);
    if (provider !== this.provider) throw new Error('Session sync changed. Reopen the session and retry.');
    if (!outcome?.published) throw new Error(`The remote session change was not published: ${outcome?.reason ?? 'sync disconnected'}`);
    const confirmed = await provider.fetchIndex?.();
    if (provider !== this.provider || !confirmed || confirmed.complete === false) throw new Error('The remote session change could not be confirmed. Reconnect and retry.');
    const entry = confirmed.sessions.find(session => session.sessionId === id);
    if (change.type === 'session_deleted' ? !!entry : change.type === 'metadata_updated' && entry?.isArchived !== change.metadata.isArchived) {
      throw new Error('The remote session change has not been confirmed by the sync server. Retry after reconnecting.');
    }
  }

  setArchived(id: string, workspace: string, isArchived: boolean): Promise<void> {
    return this.serializeWrite(id, () => this.setArchivedNow(id, workspace, isArchived));
  }

  private async setArchivedNow(id: string, workspace: string, isArchived: boolean): Promise<void> {
    if (typeof isArchived !== 'boolean') throw new Error('An archive state is required.');
    this.refreshedAt = 0;
    const root = await this.requireEntry(id, workspace);
    const selected = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const entry of this.entries.values()) {
        if (entry.projectId === workspace && entry.hostDeviceId === root.hostDeviceId && entry.parentSessionId && selected.has(entry.parentSessionId) && !selected.has(entry.sessionId)) {
          selected.add(entry.sessionId); grew = true;
        }
      }
    }
    const entries = [...selected].map(sessionId => this.entries.get(sessionId)!);
    if (isArchived) for (const entry of entries) this.assertIdle(entry);
    for (const entry of entries) {
      this.refreshedAt = 0;
      const current = await this.requireEntry(entry.sessionId, workspace);
      if (isArchived) this.assertIdle(current);
      await this.publishLifecycle(entry.sessionId, {type: 'metadata_updated', metadata: {isArchived}});
      this.entries.set(entry.sessionId, {...entry, isArchived});
      const observation = this.observations.get(entry.sessionId);
      if (observation) { observation.entry = {...observation.entry, isArchived}; this.schedule(entry.sessionId, observation); }
      this.deps.listChanged(workspace, entry.sessionId);
    }
  }

  delete(id: string, workspace: string): Promise<void> {
    return this.serializeWrite(id, () => this.deleteNow(id, workspace));
  }

  private async deleteNow(id: string, workspace: string): Promise<void> {
    this.refreshedAt = 0;
    const entry = await this.requireEntry(id, workspace);
    this.assertIdle(entry);
    if ([...this.entries.values()].some(child => child.parentSessionId === id && child.projectId === workspace && child.hostDeviceId === entry.hostDeviceId)) {
      throw new Error('Archive this workstream, or delete its child sessions first.');
    }
    const provider = this.provider!;
    try {
      // The transcript room and index must both receive deletion. The host's
      // retained execution record remains available for recovery; its checkout
      // and linked tracker tickets are never deleted by a mirror operation.
      await provider.connect(id);
      if (provider !== this.provider) throw new Error('Session sync changed. Reopen the session and retry.');
      await this.publishLifecycle(id, {type: 'session_deleted'});
      this.removeEntry(id);
    } finally {
      provider.disconnect(id);
    }
  }
}
