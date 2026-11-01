// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';

const h = vi.hoisted(() => ({ query: vi.fn(), update: vi.fn(), comment: vi.fn(), head: vi.fn(), status: vi.fn() }));
vi.mock('../gitClient', () => ({ createGit: () => ({ revparse: h.head, status: h.status }) }));
vi.mock('electron-log/main', () => ({ default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({ query: h.query }) }));
vi.mock('../ElectronDocumentService', () => ({ ElectronDocumentService: class { updateTrackerItem = h.update; } }));
vi.mock('../../mcp/tools/trackerToolHandlers', () => ({ handleTrackerAddComment: h.comment }));
import { applyPrMergeToTrackers } from '../PrTrackerLifecycle';

beforeEach(() => { vi.resetAllMocks(); h.head.mockResolvedValue('head'); h.status.mockResolvedValue({ isClean: () => true }); loadBuiltinTrackers(); });

it('closes a task when its referenced PR merges, without reopening cancelled work', async () => {
  h.query.mockResolvedValue({ rows: [
    { id: 'task', type: 'task', workspace: '/repo', data: { title: 'Task', status: 'in-review', linkedPullRequests: [{ remote: 'owner/repo', number: 1 }] } },
    { id: 'cancelled', type: 'task', workspace: '/repo', data: { title: 'Cancelled', status: 'wont-do', linkedPullRequests: [{ remote: 'owner/repo', number: 1 }] } },
  ] });
  await applyPrMergeToTrackers('/repo', 'owner/repo', 1);
  expect(h.update).toHaveBeenCalledExactlyOnceWith('task', { status: 'done' });
});

it('does not close a task with another PR still open', async () => {
  h.query.mockResolvedValueOnce({ rows: [
    { id: 'task', type: 'task', workspace: '/repo', data: { status: 'in-review', linkedPullRequests: [{ remote: 'owner/repo', number: 1 }, { remote: 'owner/repo', number: 2 }] } },
  ] }).mockResolvedValueOnce({ rows: [{ remote: 'owner/repo', number: 2, state: 'open' }] });
  await applyPrMergeToTrackers('/repo', 'owner/repo', 1);
  expect(h.update).not.toHaveBeenCalled();
});


it.each(['object', 'string'])('matches tasks through a clean merged session branch with %s metadata', async format => {
  const metadata = { linkedTrackerItemIds: ['task'] };
  h.query.mockResolvedValueOnce({ rows: [{ id: 'task', type: 'task', workspace: '/repo', data: { status: 'in-review' } }] })
    .mockResolvedValueOnce({ rows: [{ path: '/wt', metadata: format === 'string' ? JSON.stringify(metadata) : metadata }] });
  await applyPrMergeToTrackers('/repo', 'owner/repo', 1, { headRef: 'feature', headSha: 'head', automatic: true });
  expect(h.update).toHaveBeenCalledExactlyOnceWith('task', { status: 'done' });
});

it.each(['new-head', 'dirty'])('does not close branch-associated tasks with %s after an earlier merge', async reason => {
  h.query.mockResolvedValueOnce({ rows: [{ id: 'task', type: 'task', workspace: '/repo', data: { status: 'in-review' } }] })
    .mockResolvedValueOnce({ rows: [{ path: '/wt', metadata: { linkedTrackerItemIds: ['task'] } }] });
  if (reason === 'new-head') h.head.mockResolvedValue('new-head');
  else h.status.mockResolvedValue({ isClean: () => false });
  await applyPrMergeToTrackers('/repo', 'owner/repo', 1, { headRef: 'feature', headSha: 'head', automatic: true });
  expect(h.update).not.toHaveBeenCalled();
});

it('closes a task after all its PRs merge, and skips a task already done on later polls', async () => {
  const task = { id: 'task', type: 'task', workspace: '/repo', data: { status: 'in-review', linkedPullRequests: [{ remote: 'owner/repo', number: 1 }, { remote: 'owner/repo', number: 2 }] } };
  h.query.mockResolvedValueOnce({ rows: [task] }).mockResolvedValueOnce({ rows: [{ remote: 'owner/repo', number: 2, state: 'merged' }] });
  await applyPrMergeToTrackers('/repo', 'owner/repo', 1, { automatic: true });
  expect(h.update).toHaveBeenCalledExactlyOnceWith('task', { status: 'done' });
  h.query.mockResolvedValueOnce({ rows: [{ ...task, data: { ...task.data, status: 'done' } }] });
  await applyPrMergeToTrackers('/repo', 'owner/repo', 1, { automatic: true });
  expect(h.update).toHaveBeenCalledTimes(1);
  expect(h.comment).toHaveBeenCalledTimes(1);
});
