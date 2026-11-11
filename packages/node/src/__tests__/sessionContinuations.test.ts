// @vitest-environment node
import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {importSessionContinuations} from '../serve/sessionContinuations.js';
import {validateSessionContinuation} from '../serve/validateSessionContinuation.js';
import {confirmContinuationOwnership, ownsSessionExecution} from '../serve/confirmContinuationOwnership.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {for (const directory of temporaryDirectories.splice(0)) await rm(directory, {recursive: true, force: true});});

async function nativeFixture(provider = 'openai-codex', nativeId = 'native-thread') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'continuation-validation-')));
  temporaryDirectories.push(directory);
  const checkout = join(directory, 'project');
  const workspace = join(checkout, 'worktrees', 'existing');
  await mkdir(workspace, {recursive: true});
  const nativeSessionPath = join(directory, 'thread.jsonl');
  const content = JSON.stringify(provider === 'openai-codex'
    ? {type: 'session_meta', payload: {id: nativeId}}
    : {type: 'user', sessionId: nativeId, message: {content: 'history'}}) + '\n';
  await writeFile(nativeSessionPath, content);
  const entry = {...fixture().entry, provider, remoteWorkspacePath: workspace, nativeSessionPath, nativeSessionSha256: createHash('sha256').update(content).digest('hex')};
  return {directory, entry, mapping: {projectId: entry.workspaceId, repoUrl: 'https://example.test/repo.git', branch: 'main', checkoutDir: checkout}};
}

function fixture() {
  const entry = {id: 'same-id', workspaceId: '/mac/foss', provider: 'openai-codex', providerSessionId: 'native-thread', title: 'Existing task', remoteWorkspacePath: '/coder/migrated/task', nativeSessionPath: '/coder/.codex/sessions/thread.jsonl', nativeSessionSha256: 'abc', metadata: {phase: 'validating'}};
  const store = {get: vi.fn(async () => null as any), create: vi.fn(async () => {})};
  Object.assign(store, {createIfAbsent: store.create});
  const validate = vi.fn(async () => {});
  return {entry, store, validate, input: {migrationId: 'move-one', entries: [entry], hostDeviceId: 'coder-one', store: store as any, validate, confirm: vi.fn(async () => {})}};
}

it('imports the original id and native conversation without local worktree ids or a new session', async () => {
  const f = fixture();
  await importSessionContinuations(f.input);
  expect(f.store.create).toHaveBeenCalledWith(expect.objectContaining({id: 'same-id', providerSessionId: 'native-thread', workspaceId: '/mac/foss', metadata: expect.objectContaining({hostDeviceId: 'coder-one', remoteWorkspacePath: '/coder/migrated/task', phase: 'validating', remoteMigration: expect.objectContaining({id: 'move-one'})})}));
});

it('validates the whole batch before writing any sessions', async () => {
  const f = fixture();
  f.input.entries.push({...f.entry, id: 'bad'});
  f.validate.mockRejectedValueOnce(new Error('outside checkout root'));
  await expect(importSessionContinuations(f.input)).rejects.toThrow('outside checkout root');
  expect(f.store.create).not.toHaveBeenCalled();
});

it('refuses an existing session collision without changing its state', async () => {
  const f = fixture(); f.store.get.mockResolvedValue({id: 'same-id', metadata: {}});
  await expect(importSessionContinuations(f.input)).rejects.toThrow(/already exists/);
  expect(f.store.create).not.toHaveBeenCalled();
});

it('preserves later continuation state when the runner restarts', async () => {
  const f = fixture();
  f.store.get.mockResolvedValue({id: 'same-id', providerSessionId: 'advanced-thread', workspacePath: '/mac/foss', metadata: {hostDeviceId: 'coder-one', remoteWorkspacePath: '/coder/migrated/task', remoteMigration: {id: 'move-one', originalProvider: 'openai-codex', originalProviderSessionId: 'native-thread'}}});
  expect(await importSessionContinuations(f.input)).toEqual({imported: 0, retained: 1, deleted: 0});
  expect(f.store.create).not.toHaveBeenCalled();
  expect(f.validate).not.toHaveBeenCalled();
});

it('retries ownership confirmation for a retained import before declaring the runner ready', async () => {
  const f = fixture();
  f.store.get.mockResolvedValue({id: 'same-id', workspacePath: f.entry.workspaceId, metadata: {hostDeviceId: 'coder-one', remoteWorkspacePath: f.entry.remoteWorkspacePath, remoteMigration: {id: 'move-one', originalProvider: 'openai-codex', originalProviderSessionId: 'native-thread'}}});
  const confirm = vi.fn(async () => {throw new Error('Index not ready');});
  await expect(importSessionContinuations({...f.input, confirm})).rejects.toThrow('Index not ready');
  expect(confirm).toHaveBeenCalledWith(f.entry);
  expect(f.store.create).not.toHaveBeenCalled();
});

it('rejects two identities that would resume the same native conversation', async () => {
  const f = fixture();
  f.input.entries.push({...f.entry, id: 'other', remoteWorkspacePath: '/coder/other'});
  await expect(importSessionContinuations(f.input)).rejects.toThrow(/native|duplicate|conversation/i);
  expect(f.store.create).not.toHaveBeenCalled();
});

it('requires a collision-safe insertion rather than overwriting a concurrent session', async () => {
  const f = fixture();
  Object.assign(f.store, {createIfAbsent: vi.fn(async () => {throw new Error('Session already exists');})});
  await expect(importSessionContinuations(f.input)).rejects.toThrow(/already exists/);
  expect(f.store.create).not.toHaveBeenCalled();
});

it.each(['openai-codex', 'claude-code'])('checks the actual %s conversation identity inside the verified file', async provider => {
  const f = await nativeFixture(provider, 'different-native-thread');
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory)).rejects.toThrow(/identity|conversation|session/i);
});

it('rejects a different project checkout inside the broad host root', async () => {
  const f = await nativeFixture();
  f.entry.remoteWorkspacePath = join(f.directory, 'other-project');
  await mkdir(f.entry.remoteWorkspacePath);
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory)).rejects.toThrow(/project|mapping|workspace/i);
});

it.each(['openai-codex', 'claude-code'])('accepts a verified %s conversation in the mapped project', async provider => {
  const f = await nativeFixture(provider);
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory)).resolves.toBeUndefined();
});

it('accepts the immediately inherited parent header in a forked Codex rollout', async () => {
  const f = await nativeFixture();
  const content = [
    {type: 'session_meta', payload: {id: 'native-thread', cwd: '/mac/foss', forked_from_id: 'parent-thread'}},
    {type: 'session_meta', payload: {id: 'parent-thread', cwd: '/mac/foss'}},
    {type: 'response_item', payload: {type: 'message', role: 'user', content: []}},
  ].map(row => JSON.stringify(row) + '\n').join('');
  await writeFile(f.entry.nativeSessionPath, content);
  f.entry.nativeSessionSha256 = createHash('sha256').update(content).digest('hex');
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory)).resolves.toBeUndefined();
});

it.each(['unrelated', 'late', 'foreign-cwd'])('rejects %s inherited metadata in a Codex fork', async kind => {
  const f = await nativeFixture();
  const header = {type: 'session_meta', payload: {id: 'native-thread', cwd: '/mac/foss', forked_from_id: 'parent'}};
  const parent = {type: 'session_meta', payload: {id: kind === 'unrelated' ? 'stranger' : 'parent', cwd: kind === 'foreign-cwd' ? '/foreign' : '/mac/foss'}};
  const body = {type: 'response_item', payload: {type: 'message', role: 'user', content: []}};
  const content = (kind === 'late' ? [header, body, parent] : [header, parent, body]).map(row => JSON.stringify(row) + '\n').join('');
  await writeFile(f.entry.nativeSessionPath, content);
  f.entry.nativeSessionSha256 = createHash('sha256').update(content).digest('hex');
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory)).rejects.toThrow(/identity/);
});

it('confirms ownership again after a restart without rewriting advanced native state', async () => {
  const f = fixture();
  const row = {sessionId: f.entry.id, projectId: f.entry.workspaceId, hostDeviceId: 'old-desktop', title: 'Edited remotely', isArchived: true};
  const pushChange = vi.fn(async (_id, change) => {Object.assign(row, change.metadata);return {published: true};});
  const provider = {fetchIndex: vi.fn(async () => ({sessions: [row]})), getCachedIndexEntry: () => row, pushChange} as any;
  await confirmContinuationOwnership(provider, {...f.entry, sourceHostDeviceId: 'old-desktop'}, 'coder-one');
  expect(pushChange).toHaveBeenCalledWith(f.entry.id, {type: 'metadata_updated', metadata: {hostDeviceId: 'coder-one', workspaceId: f.entry.workspaceId}}, {isCurrent: expect.any(Function)});
  expect(row).toMatchObject({title: 'Edited remotely', isArchived: true});
  pushChange.mockClear();
  await confirmContinuationOwnership(provider, f.entry, 'coder-one');
  expect(pushChange).not.toHaveBeenCalled();
});

it.each([{deletedSessionIds: []}, {deletedSessionIds: ['same-id']}])('never recreates an absent or deleted index row during import recovery (%j)', async ({deletedSessionIds}) => {
  const f = fixture();
  const pushChange = vi.fn();
  const confirmation = confirmContinuationOwnership({fetchIndex: async () => ({sessions: [], deletedSessionIds}), pushChange} as any, f.entry, 'coder-one');
  if (deletedSessionIds.length) await expect(confirmation).resolves.toBe('deleted');
  else await expect(confirmation).rejects.toThrow();
  expect(pushChange).not.toHaveBeenCalled();
});

it('rejects a changed manifest identity after an interrupted first handoff', async () => {
  const f = fixture();
  f.store.get.mockResolvedValue({id: f.entry.id, provider: 'openai-codex', providerSessionId: 'native-thread', workspacePath: f.entry.workspaceId,
    metadata: {hostDeviceId: 'coder-one', remoteWorkspacePath: f.entry.remoteWorkspacePath, remoteMigration: {id: 'move-one', originalProvider: 'openai-codex', originalProviderSessionId: 'native-thread'}}});
  f.input.entries[0] = {...f.entry, provider: 'claude-code', providerSessionId: 'different-thread'};
  await expect(importSessionContinuations(f.input)).rejects.toThrow(/identity|conversation|migration/i);
  expect(f.input.confirm).not.toHaveBeenCalled();
});

it.each([{isExecuting: true}, {queuedPromptCount: 1}, {pendingExecution: {messageId: 'pending'}}])('rejects a source that becomes busy while ownership publication is pending (%j)', async busy => {
  const f = fixture();
  const row = {sessionId: f.entry.id, projectId: f.entry.workspaceId};
  const provider = {fetchIndex: async () => ({sessions: [row]}), getCachedIndexEntry: () => row,
    pushChange: async (_id, _change, options) => {Object.assign(row, busy);const published = options.isCurrent();if (published) Object.assign(row, {hostDeviceId: 'coder-one'});return {published};}} as any;
  await expect(confirmContinuationOwnership(provider, f.entry, 'coder-one')).rejects.toThrow(/not published/);
});

it('rejects a handoff whose server read-back does not confirm ownership', async () => {
  const f = fixture();
  const row = {sessionId: f.entry.id, projectId: f.entry.workspaceId};
  await expect(confirmContinuationOwnership({fetchIndex: async () => ({sessions: [row]}), pushChange: async () => ({published: true})} as any, f.entry, 'coder-one')).rejects.toThrow(/not confirmed/);
});

it('cancels an ownership handoff when a tombstone arrives during publication', async () => {
  const f = fixture();
  const row = {sessionId: f.entry.id, projectId: f.entry.workspaceId};
  let remove!: (id: string) => void;
  const provider = {
    fetchIndex: async () => ({sessions: [row]}),
    onIndexDelete: callback => {remove = callback;return () => {};},
    pushChange: async (_id, _change, options) => {remove(f.entry.id);return {published: options.isCurrent()};},
  } as any;
  await expect(confirmContinuationOwnership(provider, f.entry, 'coder-one')).resolves.toBe('deleted');
});

it('keeps a deleted migration inactive while confirming the other conversations on restart', async () => {
  const f = fixture();
  const other = {...f.entry, id: 'other', providerSessionId: 'other-native-thread'};
  f.input.entries.push(other);
  const confirm = vi.fn(async entry => entry.id === 'same-id' ? 'deleted' as const : 'confirmed' as const);
  await expect(importSessionContinuations({...f.input, confirm})).resolves.toEqual({imported: 2, retained: 0, deleted: 1});
  expect(confirm).toHaveBeenCalledWith(other);
});

it('refuses ownership when the index advertises a different provider', async () => {
  const f = fixture();
  const provider = {fetchIndex: async () => ({sessions: [{sessionId: f.entry.id, projectId: f.entry.workspaceId, hostDeviceId: 'coder-one', provider: 'claude-code'}]}), pushChange: vi.fn()} as any;
  await expect(confirmContinuationOwnership(provider, f.entry, 'coder-one')).rejects.toThrow(/provider/);
  expect(provider.pushChange).not.toHaveBeenCalled();
});

it.each([
  {hostDeviceId: 'coder-one', expected: true},
  {hostDeviceId: 'previous-host', expected: false},
  {hostDeviceId: undefined, expected: false},
  {hostDeviceId: 'coder-one', isArchived: true, expected: false},
])('requires positive current execution ownership (%j)', async ({expected, ...state}) => {
  const row = {sessionId: 'same-id', projectId: '/project', ...state};
  const provider = {getVerifiedSessionOwnership: () => row, isIndexReady: () => true, getCachedIndexEntry: () => row} as any;
  expect(await ownsSessionExecution(provider, 'same-id', '/project', 'coder-one')).toBe(expected);
});

it('does not authorize a turn from a stale index cache after reconnect', async () => {
  let generation = 1;
  const provider = {isIndexReady: () => true, getConnectionGeneration: () => generation, getVerifiedSessionOwnership: () => {generation++;return {projectId: '/project', hostDeviceId: 'coder-one'};}} as any;
  expect(await ownsSessionExecution(provider, 'same-id', '/project', 'coder-one')).toBe(false);
});

it.each([false, undefined])('never authorizes a turn from an unverified cache (ready=%s)', async ready => {
  const provider = {isIndexReady: () => ready, getCachedIndexEntry: () => ({sessionId: 'same-id', projectId: '/project', hostDeviceId: 'coder-one'})} as any;
  expect(await ownsSessionExecution(provider, 'same-id', '/project', 'coder-one')).toBe(false);
});

it.each([{hostDeviceId: 'unexpected'}, {isExecuting: true}, {queuedPrompts: [{id: 'queued'}]}])('refuses an unsafe source handoff (%j)', async extra => {
  const f = fixture();
  const pushChange = vi.fn();
  const provider = {fetchIndex: async () => ({sessions: [{sessionId: f.entry.id, projectId: f.entry.workspaceId, ...extra}]}), pushChange} as any;
  await expect(confirmContinuationOwnership(provider, f.entry, 'coder-one')).rejects.toThrow();
  expect(pushChange).not.toHaveBeenCalled();
});
