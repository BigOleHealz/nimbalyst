import type { TrackerSnapshot } from '@nimbalyst/extension-sdk';

export const DEFAULT_JIRA_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
export interface JiraCredentials { siteUrl: string; email: string; apiToken: string }
export interface JiraProjectSettings { jql: string; autoSyncMinutes: number }
export interface JiraSyncResult { created: number; refreshed: number; skipped: number; errors: string[] }
/** Only these deliberately sanitized errors may be surfaced by the sync coordinator. */
export class JiraError extends Error {}
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
      if (response.status === 401) throw new JiraError('Jira credentials were rejected. Check your email and API token.');
      if (response.status === 403) throw new JiraError('Jira permission denied. Check your token and issue access.');
      if (response.status === 400) throw new JiraError('Jira rejected the request. Check your JQL in project settings.');
      if (response.status === 429) throw new JiraError('Jira rate limit reached. Try again later.');
      throw new JiraError(`Jira is unavailable or the issue cannot be read (HTTP ${response.status}).`);
    }
    try { return await response.json() as T; } catch { throw new JiraError('Jira returned an invalid response.'); }
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
