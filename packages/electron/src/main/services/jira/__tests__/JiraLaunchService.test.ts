// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ query: vi.fn(), local: vi.fn(), room: vi.fn(), refresh: vi.fn(), write: vi.fn(), mkdir: vi.fn(), policy: vi.fn(), shared: false, dataPath: '/app-data' }));
vi.mock('electron', () => ({ app: { getPath: () => h.dataPath } }));
vi.mock('node:fs/promises', () => ({ mkdir: h.mkdir, writeFile: h.write }));
vi.mock('../../../database/initialize', () => ({ getDatabase: () => ({ query: h.query }) }));
vi.mock('../../tracker/pageTypeBodyCheck', () => ({ readLocalTrackerBody: h.local }));
vi.mock('../../MainBodyDocService', () => ({ readHeadlessBodyMarkdown: h.room }));
vi.mock('../../TrackerSchemaService', () => ({ ensureWorkspaceTrackerSchemasLoaded: vi.fn() }));
vi.mock('../../TrackerPolicyService', () => ({ resolveTrackerSharingPolicy: h.policy, shouldSyncTrackerItem: () => h.shared }));
vi.mock('../jiraSettings', () => ({ readJiraCredentials: () => ({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }), jiraProjectSettings: () => ({ acceptanceCriteriaFieldIds: ['customfield_7'] }) }));
vi.mock('@nimbalyst/runtime/integrations/jira', async importOriginal => ({ ...await importOriginal<object>(), JiraClient: class { siteUrl = 'https://team.atlassian.net'; launchContext = h.refresh; } }));
import { prepareJiraTrackerLaunch } from '../JiraLaunchService';

const external = { providerId: 'jira', externalId: 'APP-1', url: 'https://team.atlassian.net/browse/APP-1', lastSyncedAt: '2026-09-01' };
describe('Jira launch packet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.shared = false; h.dataPath = '/app-data';
    h.query.mockResolvedValue({ rows: [{ id: 'task', type: 'task', workspace: '/repo', title: 'APP-1 Local title', data: { origin: { kind: 'external', external } } }] });
    h.local.mockResolvedValue('Full canonical body\n\nLocal addition');
    h.policy.mockReturnValue({ known: true, policy: { sharing: 'personal', draftByDefault: false } });
    h.refresh.mockResolvedValue({ key: 'APP-1', url: external.url, title: 'Upstream title', attemptedAt: 'now', refreshedAt: 'now', description: { status: 'present', markdown: 'Upstream details' }, acceptanceCriteria: [], fieldDiscovery: 'discovered', comments: { status: 'complete', total: 0, items: [] } });
  });
  it.each(['inline', 'oversized', 'refresh-failed'])('keeps the dev AWS default and explicit override policy in %s launch instructions', async mode => {
    if (mode === 'oversized') h.local.mockResolvedValue('large body\n'.repeat(20000));
    if (mode === 'refresh-failed') h.refresh.mockRejectedValue(new Error('offline'));

    const { draftInput } = await prepareJiraTrackerLaunch('/repo', 'task');
    const instructions = draftInput.split('--- BEGIN TASK EVIDENCE ---')[0];
    expect(instructions).toContain('default to the dev AWS environment/account unless the user or ticket explicitly specifies another environment');
    expect(instructions).toContain('Do not ask which environment to use solely because none is specified');
    expect(instructions).toContain('verify they match the intended target before making AWS changes');
    expect(instructions).toContain('Accessible credentials do not identify the intended deployment target');
    expect(instructions).toContain('Respect existing permissions for service changes, deployments and external writes');
  });
  it.each([false, true])('reads canonical body and saves a complete separate upstream packet on either JSON backend (%s)', async sqlite => {
    if (sqlite) h.query.mockResolvedValue({ rows: [{ id: 'task', type: 'task', workspace: '/repo', title: 'APP-1 Local title', data: JSON.stringify({ origin: { kind: 'external', external } }) }] });
    const result = await prepareJiraTrackerLaunch('/repo', 'task');
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining('workspace = $2'), ['task', '/repo']);
    expect(h.refresh).toHaveBeenCalledWith('APP-1', ['customfield_7']);
    expect(result.draftInput).toContain('Local addition');
    expect(result.draftInput).toContain('Upstream details');
    expect(h.write.mock.calls[0][1]).toContain('Canonical tracker body');
    expect(h.write.mock.calls[0][2]).toMatchObject({ flag: 'wx', mode: 0o600 });
  });
  it('keeps unavailable canonical content and stale cached context explicit', async () => {
    h.policy.mockReturnValue({ known: false });
    h.refresh.mockRejectedValue(new Error('private-token'));
    const result = await prepareJiraTrackerLaunch('/repo', 'task');
    expect(result.draftInput).toContain('stale');
    expect(result.draftInput).toContain('2026-09-01');
    expect(result.draftInput).toContain('canonical body unavailable');
    expect(result.draftInput).not.toContain('private-token');
  });
  it('provides a durable complete continuation instead of truncating oversized evidence', async () => {
    h.local.mockResolvedValue('begin\n' + 'large body\n'.repeat(20000) + 'final acceptance criterion');
    const result = await prepareJiraTrackerLaunch('/repo', 'task');
    expect(result.draftInput.length).toBeLessThan(50000);
    expect(result.draftInput).toContain(result.contextPath);
    expect(result.draftInput).toContain('Read the entire file');
    expect(h.write.mock.calls[0][1]).toContain('final acceptance criterion');
  });
  it('counts the instructions and evidence delimiters against the exact launch budget', async () => {
    h.local.mockResolvedValue('');
    const empty = await prepareJiraTrackerLaunch('/repo', 'task');
    h.local.mockResolvedValue('x'.repeat(48_000 - empty.draftInput.length));
    const boundary = await prepareJiraTrackerLaunch('/repo', 'task');
    expect(boundary.draftInput.length).toBeLessThanOrEqual(48_000);
  });
  it('reads the authoritative team room and explicitly labels an inaccessible body cache as stale', async () => {
    h.shared = true;
    h.room.mockResolvedValueOnce('Team canonical body').mockResolvedValueOnce(null);
    const fresh = await prepareJiraTrackerLaunch('/repo', 'task');
    expect(h.room).toHaveBeenCalledWith('/repo', 'task');
    expect(fresh.draftInput).toContain('Team canonical body');
    const unavailable = await prepareJiraTrackerLaunch('/repo', 'task');
    expect(unavailable.draftInput).toContain('canonical body unavailable');
    expect(unavailable.draftInput).toContain('local cache may be stale');
    expect(unavailable.draftInput).toContain('Local addition');
  });
  it('leaves an oversized continuation readable from disk after preparation has returned', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    h.dataPath = await fs.mkdtemp('/tmp/jira-launch-evidence-');
    h.mkdir.mockImplementationOnce(fs.mkdir);
    h.write.mockImplementationOnce(fs.writeFile);
    h.local.mockResolvedValue('large\n'.repeat(20000) + 'final criterion');
    try {
      const result = await prepareJiraTrackerLaunch('/repo', 'task');
      expect(await fs.readFile(result.contextPath, 'utf8')).toContain('final criterion');
      expect((await fs.stat(result.contextPath)).mode & 0o777).toBe(0o600);
      expect(result.draftInput).toContain(result.contextPath);
    } finally { await fs.rm(h.dataPath, { recursive: true }); }
  });
  it('rejects wrong workspaces and mismatched Jira sites before upstream reads', async () => {
    h.query.mockResolvedValueOnce({ rows: [] });
    await expect(prepareJiraTrackerLaunch('/other', 'task')).rejects.toThrow('not found');
    h.query.mockResolvedValueOnce({ rows: [{ id: 'task', data: { origin: { kind: 'external', external: { ...external, url: 'https://other.atlassian.net/browse/APP-1' } } } }] });
    await expect(prepareJiraTrackerLaunch('/repo', 'task')).rejects.toThrow('site');
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
