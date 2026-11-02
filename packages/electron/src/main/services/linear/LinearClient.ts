import type { TrackerSnapshot } from '@nimbalyst/extension-sdk';
import type { LinearPage, LinearProject } from '../../../shared/linear';

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  state: { name: string; type: string };
  priority: number;
  labels?: { nodes: { name: string }[]; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } };
  project?: { name: string; url: string } | null;
  assignee?: { name: string } | null;
  creator?: { name: string; email?: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const ISSUE_SUMMARY = 'id identifier title url updatedAt state { name type }';

function page<T>(connection: Connection<T>): LinearPage<T> {
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) throw new Error('Linear returned an invalid page.');
  if (connection.pageInfo.hasNextPage && !connection.pageInfo.endCursor) throw new Error('Linear returned an incomplete page cursor.');
  return { nodes: connection.nodes, ...(connection.pageInfo.hasNextPage ? { nextCursor: connection.pageInfo.endCursor! } : {}) };
}

/** Read-only client. Credentials enter only through the encrypted Settings store. */
export class LinearClient {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {
    if (!apiKey?.trim()) throw new Error('Connect Linear in Application Settings → Linear first.');
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher('https://api.linear.app/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: this.apiKey },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
    } catch { throw new Error('Linear could not be reached. Check your connection and retry.'); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Linear access denied. Check your API key and project access.');
      if (response.status === 429) throw new Error('Linear rate limited the request. Wait and retry the import.');
      throw new Error(`Linear request failed (HTTP ${response.status}). Retry the import.`);
    }
    let result: { data?: T; errors?: unknown[] };
    try { result = await response.json(); }
    catch { throw new Error('Linear returned an unreadable response.'); }
    // GraphQL can return partial data with HTTP 200. Never silently import it.
    if (result.errors?.length || !result.data) throw new Error('Linear could not complete the query. Check API key permissions and retry.');
    return result.data;
  }

  async viewer(): Promise<{ name: string }> {
    const result = await this.query<{ viewer: { name: string } }>('query LinearViewer { viewer { name } }');
    return result.viewer;
  }

  async projects(cursor?: string): Promise<LinearPage<LinearProject>> {
    const result = await this.query<{ projects: Connection<LinearProject> }>(`query LinearProjects($after: String) { projects(first: 50, after: $after, includeArchived: true) { nodes { id name description url state } ${PAGE_INFO} } }`, { after: cursor });
    return page(result.projects);
  }

  async project(id: string): Promise<LinearProject> {
    const result = await this.query<{ project: LinearProject | null }>('query LinearProject($id: String!) { project(id: $id) { id name description content url state } }', { id });
    if (!result.project) throw new Error('Linear project is unavailable.');
    return result.project;
  }

  async issues(args: { projectId?: string; cursor?: string; search?: string; state?: 'open' | 'closed' | 'all'; limit?: number }): Promise<LinearPage<LinearIssue>> {
    const filter: Record<string, unknown> = {};
    if (args.projectId) filter.project = { id: { eq: args.projectId } };
    if (args.search?.trim()) filter.title = { containsIgnoreCase: args.search.trim() };
    if (args.state && args.state !== 'all') filter.state = { type: { [args.state === 'closed' ? 'in' : 'nin']: ['completed', 'canceled'] } };
    const result = await this.query<{ issues: Connection<LinearIssue> }>(`query LinearIssues($after: String, $first: Int!, $filter: IssueFilter) { issues(first: $first, after: $after, filter: $filter, includeArchived: true) { nodes { ${ISSUE_SUMMARY} } ${PAGE_INFO} } }`, { after: args.cursor, first: Math.min(100, Math.max(1, args.limit ?? 50)), filter });
    return page(result.issues);
  }

  async snapshot(id: string): Promise<TrackerSnapshot> {
    const result = await this.query<{ issue: LinearIssue | null }>(`query LinearIssue($id: String!) { issue(id: $id) { ${ISSUE_SUMMARY} description priority createdAt creator { name email } assignee { name } project { name url } labels(first: 100) { nodes { name } ${PAGE_INFO} } } }`, { id });
    if (!result.issue) throw new Error('Linear ticket is unavailable.');
    const issue = result.issue;
    const labels = [...(issue.labels?.nodes ?? [])];
    let info = issue.labels?.pageInfo;
    const seen = new Set<string>();
    while (info?.hasNextPage) {
      const after = info.endCursor;
      if (!after || seen.has(after)) throw new Error('Linear returned an invalid label cursor.');
      seen.add(after);
      const more = await this.query<{ issue: { labels: Connection<{ name: string }> } }>(`query LinearIssueLabels($id: String!, $after: String!) { issue(id: $id) { labels(first: 100, after: $after) { nodes { name } ${PAGE_INFO} } } }`, { id, after });
      labels.push(...more.issue.labels.nodes);
      info = more.issue.labels.pageInfo;
    }
    return issueSnapshot({ ...issue, labels: { nodes: labels } });
  }
}

export function issueSnapshot(issue: LinearIssue): TrackerSnapshot {
  const status = ({ started: 'in-progress', completed: 'done', canceled: 'wont-do' } as Record<string, string>)[issue.state.type] ?? 'to-do';
  const title = `${issue.identifier} ${issue.title}`;
  const metadata = [issue.project ? `Linear project: [${issue.project.name}](${issue.project.url})` : '', issue.assignee ? `Assigned to: ${issue.assignee.name}` : ''].filter(Boolean);
  return {
    primaryType: 'task', title, body: [issue.description ?? '', ...metadata].filter(Boolean).join('\n\n'), status,
    priority: ({ 1: 'critical', 2: 'high', 3: 'medium', 4: 'low' } as Record<number, string>)[issue.priority],
    labels: issue.labels?.nodes.map(label => label.name) ?? [],
    authorIdentity: issue.creator ? { displayName: issue.creator.name, email: issue.creator.email ?? null } : null,
    upstreamCreatedAt: issue.createdAt, upstreamUpdatedAt: issue.updatedAt,
    external: { providerId: 'linear', externalId: issue.id, urn: `linear://issue/${issue.id}`, url: issue.url, titleSnapshot: title, stateSnapshot: status },
  };
}
