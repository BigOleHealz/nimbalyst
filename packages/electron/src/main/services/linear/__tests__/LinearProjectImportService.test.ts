// @vitest-environment node
import { mkdtemp, readFile, writeFile, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LinearProjectImportService } from '../LinearProjectImportService';

let root: string;
const project = { id: '11111111-1111-4111-8111-111111111111', name: 'My Project', description: 'Summary', content: 'Long description', url: 'https://linear.app/project', state: 'started' };
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'linear-import-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('creates one workspace per project, imports every page, isolates failures and reuses it after rename', async () => {
  const client = { project: vi.fn(async () => project), issues: vi.fn().mockResolvedValueOnce({ nodes: [{ id: 'a' }, { id: 'bad' }], nextCursor: 'next' }).mockResolvedValueOnce({ nodes: [{ id: 'b' }] }) };
  const importIssue = vi.fn(async (_workspace: string, id: string) => { if (id === 'bad') throw new Error('ticket unavailable'); return { created: id === 'a' }; });
  const remember = vi.fn();
  const service = new LinearProjectImportService(client as never, importIssue, remember);
  const result = await service.importProject(root, project.id);
  expect(result).toMatchObject({ created: 1, skipped: 1, errors: ['bad: ticket unavailable'] });
  expect(result.workspacePath).toBe(join(root, `my-project--${project.id}`));
  expect(client.issues).toHaveBeenLastCalledWith({ projectId: project.id, cursor: 'next', state: 'all' });
  expect(importIssue.mock.calls.map(call => call[0])).toEqual([result.workspacePath, result.workspacePath, result.workspacePath]);
  expect(await readFile(join(result.workspacePath, 'README.md'), 'utf8')).toContain('Long description');
  expect(remember).toHaveBeenCalledWith(result.workspacePath, 'My Project');
  await writeFile(join(result.workspacePath, 'README.md'), 'Local edit');
  client.project.mockResolvedValue({ ...project, name: 'Renamed' });
  client.issues.mockResolvedValue({ nodes: [] });
  expect((await service.importProject(root, project.id)).workspacePath).toBe(result.workspacePath);
  expect(await readFile(join(result.workspacePath, 'README.md'), 'utf8')).toBe('Local edit');
});

it('refuses existing unrelated directories and invalid project ids without writing into them', async () => {
  const client = { project: vi.fn(async () => project) };
  const service = new LinearProjectImportService(client as never, vi.fn(), vi.fn());
  await expect(service.importProject(root, '../escape')).rejects.toThrow('project ID');
  const target = join(root, `my-project--${project.id}`);
  await mkdir(target);
  await writeFile(join(target, 'README.md'), 'Existing data');
  await expect(service.importProject(root, project.id)).rejects.toThrow('existing');
  expect(await readFile(join(target, 'README.md'), 'utf8')).toBe('Existing data');
});

it('reports a later-page failure with completed counts so retry can resume safely', async () => {
  const client = { project: vi.fn(async () => project), issues: vi.fn().mockResolvedValueOnce({ nodes: [{ id: 'a' }], nextCursor: 'next' }).mockRejectedValueOnce(new Error('Linear rate limited')) };
  const result = await new LinearProjectImportService(client as never, async () => ({ created: true }), vi.fn()).importProject(root, project.id);
  expect(result).toMatchObject({ created: 1, errors: ['Linear rate limited'] });
});
