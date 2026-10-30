// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { adfToMarkdown, JiraClient, DEFAULT_JIRA_JQL } from '../jira';

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Jira Cloud', () => {
  it('refreshes launch evidence with discovered acceptance fields and every comment page', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response([{ id: 'customfield_912', name: 'Acceptance Criteria' }]))
      .mockResolvedValueOnce(response({ key: 'APP-1', fields: { summary: 'Complete', description: doc('Details'), customfield_912: doc('- passes') }, names: { customfield_912: 'Acceptance Criteria' } }))
      .mockResolvedValueOnce(response({ startAt: 0, comments: [{ id: '1', author: { displayName: 'Alice' }, created: '2026-10-01', body: doc('First') }], total: 2 }))
      .mockResolvedValueOnce(response({ startAt: 1, comments: [{ id: '2', author: { displayName: 'Bob' }, created: '2026-10-02', body: doc('Second') }], total: 2 }));
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, fetcher);
    const context = await client.launchContext('APP-1');
    expect(context.description).toMatchObject({ status: 'present', markdown: 'Details' });
    expect(context.acceptanceCriteria).toEqual([{ id: 'customfield_912', name: 'Acceptance Criteria', status: 'present', markdown: '- passes' }]);
    expect(context.comments).toMatchObject({ status: 'complete', total: 2, items: [{ author: 'Alice', created: '2026-10-01' }, { author: 'Bob', created: '2026-10-02' }] });
    expect(fetcher.mock.calls[1][0]).toContain('customfield_912');
    expect(fetcher.mock.calls[3][0]).toContain('startAt=1');
  });

  it('retains successful pages when later comments fail and distinguishes absent from unavailable fields', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ key: 'APP-1', fields: { summary: 'Partial', description: null, customfield_7: null } }))
      .mockResolvedValueOnce(response({ comments: [{ id: '1', created: 'now', body: doc('keep') }], total: 2 }))
      .mockResolvedValueOnce(response({}, 403));
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, fetcher);
    const context = await client.launchContext('APP-1', ['customfield_7', 'customfield_8']);
    expect(context.description.status).toBe('absent');
    expect(context.acceptanceCriteria.map(f => f.status)).toEqual(['absent', 'unavailable']);
    expect(context.comments).toMatchObject({ status: 'partial', total: 2, items: [{ markdown: 'keep' }], error: expect.stringContaining('permission') });
  });

  it('keeps description criteria when discovery is inaccessible instead of claiming no criteria exist', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(response({ key: 'APP-1', fields: { summary: 'Embedded criteria', description: '## Acceptance criteria\n\n- Retain [links](https://example.com)\n\n```ts\nrun();\n```' } }))
      .mockResolvedValueOnce(response({ comments: [], total: 0 }));
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, fetcher);
    const context = await client.launchContext('APP-1');
    expect(context.fieldDiscovery).toBe('failed');
    expect(context.discoveryError).toContain('permission');
    expect(context.description.markdown).toContain('```ts\nrun();\n```');
    expect(context.comments).toMatchObject({ status: 'complete', total: 0, items: [] });
  });

  it('labels inaccessible issues separately from failed network requests while retaining comment evidence', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({}, 403))
      .mockResolvedValueOnce(response({}, 403));
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, fetcher);
    const inaccessible = await client.launchContext('APP-1', ['customfield_1']);
    expect(inaccessible.refreshedAt).toBeUndefined();
    expect(inaccessible.description.status).toBe('unavailable');
    expect(inaccessible.comments.status).toBe('unavailable');
    fetcher.mockRejectedValue(new Error('secret transport details'));
    const failed = await client.launchContext('APP-1', ['customfield_1']);
    expect(failed.description.status).toBe('failed');
    expect(failed.comments.status).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain('secret transport details');
  });

  it('does not report repeated or prematurely empty comment pages as complete', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ key: 'APP-1', fields: { summary: 'Comments', description: '' } }))
      .mockResolvedValueOnce(response({ startAt: 0, comments: [{ id: '1', created: 'today', body: doc('first') }], total: 2 }))
      .mockResolvedValueOnce(response({ startAt: 0, comments: [{ id: '1', created: 'today', body: doc('first') }], total: 2 }));
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, fetcher);
    const context = await client.launchContext('APP-1', ['customfield_1']);
    expect(context.comments.status).toBe('partial');
    expect(context.comments.items).toHaveLength(1);
    expect(context.comments.error).toContain('repeated');
  });
  it('converts structured descriptions without losing unsupported node children', () => {
    expect(adfToMarkdown({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Details' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [doc('first').content[0]] }] },
      { type: 'panel', content: [doc('Important').content[0]] },
      { type: 'paragraph', content: [{ type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
    ] })).toContain('## Details\n\n- first\n\nImportant\n\n[docs](https://example.com)');
  });

  it('paginates search and all comments and builds native task snapshots', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ issues: [{ key: 'APP-1', fields: { summary: 'First', description: doc('Full details') } }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(response({ comments: [{ author: { displayName: 'Alice' }, created: '2026-01-01', body: doc('Hello') }], total: 2 }))
      .mockResolvedValueOnce(response({ comments: [{ author: { displayName: 'Bob' }, created: '2026-01-02', body: doc('Second') }], total: 2 }))
      .mockResolvedValueOnce(response({ issues: [], isLast: true }));
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net/', email: 'me@example.com', apiToken: 'secret' }, fetcher);
    const snapshots = [];
    for await (const issue of client.search(DEFAULT_JIRA_JQL)) snapshots.push(await client.snapshot(issue));
    expect(snapshots[0]).toMatchObject({ primaryType: 'task', title: 'APP-1 First', external: { externalId: 'APP-1', url: 'https://team.atlassian.net/browse/APP-1' } });
    expect(snapshots[0].body).toContain('Full details');
    expect(snapshots[0].body).toContain('Alice — 2026-01-01');
    expect(snapshots[0].body).toContain('Bob — 2026-01-02');
    expect(JSON.parse(fetcher.mock.calls[3][1].body).nextPageToken).toBe('next');
    expect(fetcher.mock.calls[2][0]).toContain('startAt=1');
  });

  it.each([[401, 'credentials'], [403, 'permission'], [400, 'JQL'], [429, 'rate limit'], [500, 'unavailable']])('reports HTTP %s without echoing server secrets', async (status, message) => {
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, vi.fn().mockResolvedValue(response({ errorMessages: ['secret'] }, status)));
    await expect(client.request('/rest/api/3/search/jql')).rejects.toThrow(message);
  });

  it('sanitizes transport errors and refuses unsafe site URLs', async () => {
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, vi.fn().mockRejectedValue(new Error('secret')));
    await expect(client.request('/rest/api/3/myself')).rejects.toThrow('network');
    expect(() => new JiraClient({ siteUrl: 'http://team.atlassian.net', email: 'me', apiToken: 'secret' })).toThrow('HTTPS');
  });

  it('preserves code, table cells, mentions, and nested lists in ADF', () => {
    const markdown = adfToMarkdown({ type: 'doc', content: [
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const x = `value`;' }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [doc('Name').content[0]] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [doc('A|B').content[0]] }] }] },
      { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Alice' } }, { type: 'hardBreak' }, { type: 'status', attrs: { text: 'Review' } }] },
      { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [doc('Parent').content[0], { type: 'bulletList', content: [{ type: 'listItem', content: [doc('Child').content[0]] }] }] }] },
    ] });
    expect(markdown).toContain('```ts\nconst x = `value`;\n```');
    expect(markdown).toContain('| Name |\n| --- |\n| A\\|B |');
    expect(markdown).toContain('@Alice  \nReview');
    expect(markdown).toContain('3. Parent\n   \n   - Child');
  });

  it('does not forward credentials through redirects and detects non-progressing pages', async () => {
    const fetcher = vi.fn().mockImplementation(async () => response({ issues: [], nextPageToken: 'same' }));
    const client = new JiraClient({ siteUrl: 'https://team.atlassian.net', email: 'me', apiToken: 'secret' }, fetcher);
    await expect(async () => { for await (const _issue of client.search('mine')) { /* consume */ } }).rejects.toThrow('repeated search page');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: `Basic ${btoa('me:secret')}` } });
    fetcher.mockImplementation(async () => response({ comments: [], total: 1 }));
    await expect(client.snapshot({ key: 'APP-1', fields: { summary: 'First' } })).rejects.toThrow('all comments');
  });
});
