// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { LinearClient, issueSnapshot } from '../LinearClient';

const request = vi.fn();
beforeEach(() => request.mockReset());
const respond = (data: unknown) => request.mockResolvedValueOnce({ ok: true, json: async () => ({ data }) });

it('uses the personal key header and cursor variables without interpolating search text', async () => {
  respond({ projects: { nodes: [{ id: 'p', name: 'Project' }], pageInfo: { hasNextPage: true, endCursor: 'next' } } });
  const client = new LinearClient('private-key', request);
  expect(await client.projects('cursor')).toMatchObject({ nodes: [{ id: 'p' }], nextCursor: 'next' });
  const init = request.mock.calls[0][1];
  expect(init.headers.Authorization).toBe('private-key');
  expect(JSON.parse(init.body).variables).toEqual({ after: 'cursor' });
  respond({ issues: { nodes: [], pageInfo: { hasNextPage: false } } });
  await client.issues({ projectId: 'p', cursor: 'c', search: '"query', state: 'closed' });
  const payload = JSON.parse(request.mock.calls[1][1].body);
  expect(payload.variables).toMatchObject({ after: 'c', filter: { project: { id: { eq: 'p' } }, title: { containsIgnoreCase: '"query' }, state: { type: { in: ['completed', 'canceled'] } } } });
  expect(payload.query).not.toContain('"query');
});

it.each([
  { ok: false, status: 401, json: async () => ({}) },
  { ok: true, json: async () => ({ data: { viewer: {} }, errors: [{ message: 'private-key secret detail' }] }) },
])('fails closed on HTTP or partial GraphQL errors without leaking response details', async response => {
  request.mockResolvedValueOnce(response);
  await expect(new LinearClient('private-key', request).viewer()).rejects.toThrow(/Linear/);
  request.mockResolvedValueOnce(response);
  await expect(new LinearClient('private-key', request).viewer()).rejects.not.toThrow('private-key');
});

it('maps workflow types, priority, markdown, labels and immutable issue identity', () => {
  const snapshot = issueSnapshot({ id: 'uuid', identifier: 'APP-7', title: 'Ticket', description: '## Details\nText', url: 'https://linear.app/team/issue/APP-7', state: { name: 'Review', type: 'started' }, priority: 1, labels: { nodes: [{ name: 'bug' }] }, project: { name: 'Project', url: 'https://linear.app/project' }, assignee: { name: 'Pat' }, createdAt: 'created', updatedAt: 'updated' });
  expect(snapshot).toMatchObject({ primaryType: 'task', title: 'APP-7 Ticket', status: 'in-progress', priority: 'critical', labels: ['bug'], external: { providerId: 'linear', externalId: 'uuid', urn: 'linear://issue/uuid', stateSnapshot: 'in-progress' } });
  expect(snapshot.body).toContain('## Details\nText');
  expect(snapshot.body).toContain('Project');
  expect(issueSnapshot({ id: 'x', identifier: 'X-1', title: 'Done', url: '', state: { name: 'Done', type: 'completed' }, priority: 0, createdAt: '', updatedAt: '' }).status).toBe('done');
});

it('fetches all labels before producing a snapshot and refuses repeated cursors', async () => {
  const issue = { id: 'uuid', identifier: 'APP-1', title: 'Ticket', url: '', state: { type: 'canceled', name: 'Canceled' }, priority: 4, labels: { nodes: [{ name: 'first' }], pageInfo: { hasNextPage: true, endCursor: 'next' } } };
  respond({ issue });
  respond({ issue: { labels: { nodes: [{ name: 'last' }], pageInfo: { hasNextPage: false } } } });
  const client = new LinearClient('key', request);
  expect(await client.snapshot('uuid')).toMatchObject({ status: 'wont-do', priority: 'low', labels: ['first', 'last'] });
  expect(JSON.parse(request.mock.calls[1][1].body).variables).toEqual({ id: 'uuid', after: 'next' });
  respond({ issue });
  respond({ issue: { labels: issue.labels } });
  await expect(client.snapshot('uuid')).rejects.toThrow('invalid label cursor');
});

it('does not silently truncate incomplete pages and sanitizes network errors', async () => {
  respond({ projects: { nodes: [], pageInfo: { hasNextPage: true } } });
  const client = new LinearClient('key', request);
  await expect(client.projects()).rejects.toThrow('incomplete page cursor');
  request.mockRejectedValueOnce(new Error('key and private response'));
  await expect(client.viewer()).rejects.toThrow('could not be reached');
});
