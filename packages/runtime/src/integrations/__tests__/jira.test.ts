// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { adfToMarkdown, JiraClient, DEFAULT_JIRA_JQL } from '../jira';

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Jira Cloud', () => {
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
