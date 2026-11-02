import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { LinearClient } from './LinearClient';
import type { LinearProjectImportResult } from '../../../shared/linear';

export function requireLinearProjectId(value: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new Error('A valid Linear project ID is required.');
}

/** Creates ordinary local workspaces; native tracker creation owns storage and bodies. */
export class LinearProjectImportService {
  constructor(
    private readonly client: LinearClient,
    private readonly importIssue: (workspacePath: string, id: string) => Promise<{ created: boolean }>,
    private readonly rememberWorkspace: (workspacePath: string, name: string) => void,
  ) {}

  async importProject(destination: string, projectId: string): Promise<LinearProjectImportResult> {
    requireLinearProjectId(projectId);
    projectId = projectId.toLowerCase();
    if (typeof destination !== 'string' || !isAbsolute(destination)) throw new Error('Choose an absolute destination folder.');
    const root = await realpath(destination);
    if (!(await lstat(root)).isDirectory()) throw new Error('Choose a destination folder.');
    const project = await this.client.project(projectId);
    if (project.id.toLowerCase() !== projectId) throw new Error('Linear returned a different project. Retry the import.');
    // Keep readable folder names and locate prior imports by immutable UUID
    // suffix, so project renames do not create a second workspace.
    const suffix = `--${projectId}`;
    const matches = (await readdir(root)).filter(name => name.endsWith(suffix));
    if (matches.length > 1) throw new Error('Multiple existing folders match this Linear project. Choose another destination.');
    const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
    const workspacePath = join(root, matches[0] ?? `${slug}${suffix}`);
    const marker = join(workspacePath, '.linear-project.json');
    try {
      await mkdir(workspacePath);
      await writeFile(marker, JSON.stringify({ projectId, url: project.url }), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await lstat(workspacePath);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (await lstat(marker)).isSymbolicLink()) throw new Error('unsafe');
        if (JSON.parse(await readFile(marker, 'utf8')).projectId !== projectId) throw new Error('mismatch');
      } catch { throw new Error('The existing destination does not belong to this Linear project. Choose another folder.'); }
    }
    try {
      await writeFile(join(workspacePath, 'README.md'), `# ${project.name}\n\n[View in Linear](${project.url})\n\n${[project.description, project.content].filter(Boolean).join('\n\n')}\n`, { flag: 'wx' });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    this.rememberWorkspace(workspacePath, project.name);
    const result: LinearProjectImportResult = { projectId, name: project.name, workspacePath, created: 0, skipped: 0, errors: [] };
    let cursor: string | undefined;
    const seen = new Set<string>();
    try {
      do {
        const page = await this.client.issues({ projectId, cursor, state: 'all' });
        for (const issue of page.nodes) {
          try {
            const imported = await this.importIssue(workspacePath, issue.id);
            if (imported.created) result.created++; else result.skipped++;
          } catch (error) { result.errors.push(`${issue.identifier ?? issue.id}: ${error instanceof Error ? error.message : 'Ticket import failed.'}`); }
        }
        cursor = page.nextCursor;
        if (cursor) {
          if (seen.has(cursor)) throw new Error('Linear repeated a page cursor. Retry the import.');
          seen.add(cursor);
        }
      } while (cursor);
    } catch (error) { result.errors.push(error instanceof Error ? error.message : 'Linear project import failed.'); }
    return result;
  }
}
