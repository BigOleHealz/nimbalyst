import type { TrackerSnapshot } from '@nimbalyst/extension-sdk';

export const DEFAULT_JIRA_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
export interface JiraCredentials { siteUrl: string; email: string; apiToken: string }
export interface JiraProjectSettings { jql: string; autoSyncMinutes: number; acceptanceCriteriaFieldIds?: string[] }
export interface JiraSyncResult { created: number; refreshed: number; skipped: number; errors: string[] }
/** Only these deliberately sanitized errors may be surfaced by the sync coordinator. */
export class JiraError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
export interface JiraContextField {
  status: 'present' | 'absent' | 'unavailable' | 'failed';
  markdown: string;
}
export interface JiraLaunchContext {
  key: string;
  url: string;
  title?: string;
  attemptedAt: string;
  refreshedAt?: string;
  issueError?: string;
  description: JiraContextField;
  acceptanceCriteria: Array<JiraContextField & { id: string; name: string }>;
  fieldDiscovery: 'configured' | 'discovered' | 'failed';
  discoveryError?: string;
  comments: {
    status: 'complete' | 'partial' | 'unavailable' | 'failed';
    total?: number;
    items: Array<JiraContextField & { id?: string; author: string; created: string; updated?: string }>;
    error?: string;
  };
}

function contextField(fields: Record<string, unknown>, id: string): JiraContextField {
  if (!Object.prototype.hasOwnProperty.call(fields, id)) return { status: 'unavailable', markdown: '' };
  const value = fields[id];
  const markdown = adfToMarkdown(value);
  if (value != null && typeof value !== 'string' && !(typeof value === 'object' && 'type' in value)) {
    return { status: 'present', markdown: JSON.stringify(value, null, 2) };
  }
  return { status: markdown.trim() ? 'present' : 'absent', markdown };
}

function contextError(error: unknown): string {
  return error instanceof JiraError ? error.message : 'Jira context could not be read. Retry with an authorized Jira connection.';
}
function failureStatus(error: unknown): 'unavailable' | 'failed' {
  return error instanceof JiraError && (error.status === 401 || error.status === 403 || error.status === 404) ? 'unavailable' : 'failed';
}
interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
}

function safeLink(value: unknown): string {
  const url = String(value ?? '');
  return /^(https?:|mailto:)/i.test(url) ? url.replace(/[()\s]/g, (c) => encodeURIComponent(c)) : '';
}

/** Preserve text even for ADF node types this renderer does not yet recognize. */
export function adfToMarkdown(value: unknown): string {
  function render(node: AdfNode): string {
    const children = (node.content ?? []).map(render).join('');
    switch (node.type) {
      case 'text': {
        let text = (node.text ?? '').replace(/([\\`*_\[\]<>])/g, '\\$1');
        for (const mark of node.marks ?? []) {
          if (mark.type === 'strong') text = `**${text}**`;
          if (mark.type === 'em') text = `*${text}*`;
          if (mark.type === 'strike') text = `~~${text}~~`;
          if (mark.type === 'code') text = `\`${(node.text ?? '').replace(/`/g, '\\`')}\``;
          if (mark.type === 'link' && safeLink(mark.attrs?.href)) text = `[${text}](${safeLink(mark.attrs?.href)})`;
        }
        return text;
      }
      case 'hardBreak': return '  \n';
      case 'paragraph': return `${children}\n\n`;
      case 'heading': return `${'#'.repeat(Math.max(1, Math.min(6, Number(node.attrs?.level) || 1)))} ${children}\n\n`;
      case 'bulletList':
      case 'orderedList': return (node.content ?? []).map((item, index) => {
        const lines = render(item).trimEnd().split('\n');
        const prefix = node.type === 'bulletList' ? '- ' : `${Number(node.attrs?.order ?? 1) + index}. `;
        return prefix + lines.join(`\n${' '.repeat(prefix.length)}`);
      }).join('\n') + '\n\n';
      case 'blockquote': return children.trimEnd().split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
      case 'codeBlock': {
        const raw = (nodes: AdfNode[]): string => nodes.map(n => n.text ?? raw(n.content ?? [])).join('');
        const code = raw(node.content ?? []);
        const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(m => m[0].length + 1)));
        return `${fence}${String(node.attrs?.language ?? '').replace(/[^\w+-]/g, '')}\n${code}\n${fence}\n\n`;
      }
      case 'rule': return '---\n\n';
      case 'mention': return String(node.attrs?.text ?? node.attrs?.id ?? '');
      case 'emoji': return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
      case 'status': return String(node.attrs?.text ?? '');
      case 'date': {
        const date = new Date(Number(node.attrs?.timestamp));
        return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
      }
      case 'inlineCard':
      case 'blockCard': return safeLink(node.attrs?.url);
      case 'media': return `[Attachment: ${String(node.attrs?.alt ?? node.attrs?.id ?? 'attachment')}]`;
      case 'table': return (node.content ?? []).map(row => '| ' + (row.content ?? []).map(cell => render(cell).trim().replace(/\n+/g, '<br>').replace(/\|/g, '\\|')).join(' | ') + ' |').map((row, i) => i === 0 ? row + '\n| ' + (node.content?.[0]?.content ?? []).map(() => '---').join(' | ') + ' |' : row).join('\n') + '\n\n';
      default: return children;
    }
  }
  return value && typeof value === 'object' ? render(value as AdfNode).trim() : typeof value === 'string' ? value : '';
}

export function normalizeJiraSite(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid Jira HTTPS site URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Enter the Jira HTTPS site URL without a path or credentials.');
  }
  return url.origin;
}

export interface JiraIssue { key: string; fields: { summary: string; description?: unknown } }
interface JiraComment { author?: { displayName?: string }; created: string; body?: unknown }

export class JiraClient {
  readonly siteUrl: string;
  constructor(private credentials: JiraCredentials, private fetcher: typeof fetch = fetch) {
    this.siteUrl = normalizeJiraSite(credentials.siteUrl);
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.siteUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Basic ${btoa(Array.from(new TextEncoder().encode(`${this.credentials.email}:${this.credentials.apiToken}`), byte => String.fromCharCode(byte)).join(''))}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new JiraError('Jira network request failed. Check your connection and site URL.'); }
    if (!response.ok) {
      if (response.status === 401) throw new JiraError('Jira credentials were rejected. Check your email and API token.', 401);
      if (response.status === 403) throw new JiraError('Jira permission denied. Check your token and issue access.', 403);
      if (response.status === 400) throw new JiraError('Jira rejected the request. Check your JQL in project settings.');
      if (response.status === 429) throw new JiraError('Jira rate limit reached. Try again later.');
      throw new JiraError(`Jira is unavailable or the issue cannot be read (HTTP ${response.status}).`, response.status);
    }
    try { return await response.json() as T; } catch { throw new JiraError('Jira returned an invalid response.'); }
  }

  /** Read-only launch refresh; successful pages survive a partial upstream failure. */
  async launchContext(key: string, configuredFieldIds?: string[]): Promise<JiraLaunchContext> {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(key)) throw new JiraError('Invalid Jira issue key.');
    let mapping = (configuredFieldIds ?? []).map(id => ({ id, name: id }));
    const context: JiraLaunchContext = {
      key, url: `${this.siteUrl}/browse/${key}`, attemptedAt: new Date().toISOString(),
      description: { status: 'failed', markdown: '' }, acceptanceCriteria: [],
      fieldDiscovery: mapping.length ? 'configured' : 'discovered',
      comments: { status: 'failed', items: [] },
    };
    if (!mapping.length) {
      try {
        const fields = await this.request<Array<{ id: string; name: string }>>('/rest/api/3/field');
        if (!Array.isArray(fields)) throw new JiraError('Jira returned an invalid field list.');
        mapping = fields.filter(f => typeof f.id === 'string' && typeof f.name === 'string' && /^acceptance[\s_-]*criteria$/i.test(f.name.trim()));
      } catch (error) {
        context.fieldDiscovery = 'failed'; context.discoveryError = contextError(error);
      }
    }
    // Validate configured ids before interpolating them into the request.
    if (mapping.some(f => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.id))) throw new JiraError('Invalid Jira acceptance criteria field mapping.');
    try {
      const fields = ['summary', 'description', ...mapping.map(f => f.id)];
      const issue = await this.request<JiraIssue & { names?: Record<string, string> }>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}&expand=names`);
      if (issue.key !== key || typeof issue.fields?.summary !== 'string') throw new JiraError('Jira returned an invalid issue.');
      context.title = issue.fields.summary;
      context.refreshedAt = new Date().toISOString();
      context.description = contextField(issue.fields, 'description');
      context.acceptanceCriteria = mapping.map(f => ({ id: f.id, name: issue.names?.[f.id] ?? f.name, ...contextField(issue.fields, f.id) }));
    } catch (error) {
      context.issueError = contextError(error);
      context.description = { status: failureStatus(error), markdown: '' };
      context.acceptanceCriteria = mapping.map(f => ({ ...f, status: failureStatus(error), markdown: '' }));
    }
    let startAt = 0;
    const seenIds = new Set<string>();
    try {
      while (true) {
        const page = await this.request<{ comments: Array<JiraComment & { id?: string; updated?: string }>; total: number; startAt?: number }>(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
        if (!Array.isArray(page.comments) || !Number.isInteger(page.total) || page.total < 0 || (page.startAt !== undefined && page.startAt !== startAt)) throw new JiraError('Jira returned an invalid or repeated comment page.');
        context.comments.total = page.total;
        for (const comment of page.comments) {
          if (comment.id && seenIds.has(comment.id)) throw new JiraError('Jira returned a repeated comment. Retry the launch refresh.');
          if (comment.id) seenIds.add(comment.id);
          context.comments.items.push({ id: comment.id, author: comment.author?.displayName ?? 'Unknown author', created: comment.created ?? 'Timestamp unavailable', updated: comment.updated, ...contextField(comment as unknown as Record<string, unknown>, 'body') });
        }
        startAt += page.comments.length;
        if (startAt >= page.total) break;
        if (!page.comments.length) throw new JiraError('Jira comments pagination stopped before all comments were read.');
      }
      context.comments.status = 'complete';
    } catch (error) {
      context.comments.status = context.comments.items.length ? 'partial' : failureStatus(error);
      context.comments.error = contextError(error);
    }
    return context;
  }

  async *search(jql: string): AsyncGenerator<JiraIssue> {
    let nextPageToken: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.request<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>('/rest/api/3/search/jql', {
        jql, maxResults: 100, fields: ['summary', 'description'], ...(nextPageToken ? { nextPageToken } : {}),
      });
      if (!Array.isArray(page.issues)) throw new JiraError('Jira returned an invalid search page.');
      for (const issue of page.issues) yield issue;
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
      if (nextPageToken && seen.has(nextPageToken)) throw new JiraError('Jira returned a repeated search page. Retry sync.');
      if (nextPageToken) seen.add(nextPageToken);
    } while (nextPageToken);
  }

  async snapshot(issue: JiraIssue): Promise<TrackerSnapshot> {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(issue?.key) || typeof issue.fields?.summary !== 'string') throw new JiraError('Jira returned an invalid issue.');
    const comments: JiraComment[] = [];
    let startAt = 0;
    while (true) {
      const page = await this.request<{ comments: JiraComment[]; total: number }>(`/rest/api/3/issue/${encodeURIComponent(issue.key)}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
      if (!Array.isArray(page.comments) || !Number.isFinite(page.total)) throw new JiraError('Jira returned an invalid comment page.');
      comments.push(...page.comments);
      startAt += page.comments.length;
      if (startAt >= page.total) break;
      if (!page.comments.length) throw new JiraError('Jira comments pagination stopped before all comments were read.');
    }
    const title = `${issue.key} ${issue.fields.summary}`;
    const url = `${this.siteUrl}/browse/${issue.key}`;
    const body = [adfToMarkdown(issue.fields.description), `[${issue.key}](${url})`, ...(comments.length ? ['## Jira comments', ...comments.map(c => `### ${c.author?.displayName ?? 'Unknown author'} — ${c.created}\n\n${adfToMarkdown(c.body)}`)] : [])].filter(Boolean).join('\n\n');
    return { primaryType: 'task', title, body, status: 'open', external: { providerId: 'jira', externalId: issue.key, urn: `jira://${new URL(this.siteUrl).host}/${issue.key}`, url, titleSnapshot: title, stateSnapshot: 'open' } };
  }
}
