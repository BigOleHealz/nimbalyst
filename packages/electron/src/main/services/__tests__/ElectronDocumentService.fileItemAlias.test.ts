// @vitest-environment node
/**
 * The file-write handler sizes a shared file-backed item against the row the
 * write will land on. A placed view or agent can name that item by its
 * `fm:<type>:<path>` alias; the lookup has to resolve the alias to the stable
 * row, or an oversized edit skips the check and is written anyway.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: (...args: any[]) => state.db.query(...args) },
}));
vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(),
  unsyncTrackerItem: vi.fn(),
  isTrackerSyncActive: vi.fn(() => false),
}));
vi.mock('../MainBodyDocService', () => ({ applyHeadlessBodyMarkdown: vi.fn() }));
vi.mock('../../utils/store', () => ({ getWorkspaceState: () => ({}), isAnalyticsEnabled: () => false }));

import { ElectronDocumentService } from '../ElectronDocumentService';

let service: ElectronDocumentService | null = null;
let close: () => Promise<void> = async () => {};
afterEach(async () => {
  service?.destroy();
  service = null;
  await close();
});

async function createHarness() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-fm-alias-'));
  const sqlite = new SQLiteDatabase({
    dbDir: path.join(directory, 'db'),
    schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
    log: () => {},
  });
  await sqlite.initialize();
  state.db = { query: createSQLiteStoreAdapter(sqlite).query };
  close = async () => {
    await sqlite.close();
    await fs.rm(directory, { recursive: true, force: true });
  };
  service = new ElectronDocumentService(directory);
  return { directory, documentService: service };
}

describe('file-backed tracker item compatibility', () => {
  it('resolves fm:<type>:<path> to the stable row the write lands on', async () => {
    const { directory, documentService } = await createHarness();
    await state.db.query(
      `INSERT INTO tracker_items (id, type, type_tags, data, workspace, document_path, sync_status, archived, source, source_ref, created, updated, last_indexed)
       VALUES ('plan_stable', 'plan', $1, $2, $3, 'plans/sync.md', 'synced', FALSE, 'frontmatter', 'plans/sync.md', NOW(), NOW(), NOW())`,
      [JSON.stringify(['plan']), JSON.stringify({ title: 'Sync engine', status: 'active' }), directory],
    );

    // The handler used to look the alias up as a literal id and found nothing.
    expect((await state.db.query('SELECT id FROM tracker_items WHERE id = $1', ['fm:plan:plans/sync.md'])).rows).toEqual([]);
    expect((await documentService.findTrackerRowForPublicId('fm:plan:plans/sync.md'))?.id).toBe('plan_stable');
    expect((await documentService.findTrackerRowForPublicId('plan_stable'))?.id).toBe('plan_stable');
  });

  it.each([false, true])('keeps explicit file imports visible and deduplicated (existing projection: %s)', async (existingProjection) => {
    const { directory, documentService } = await createHarness();
    const relativePath = 'example.md';
    const fileContent = '---\nplanStatus:\n  title: Example plan\n  status: draft\n---\n\n# Body\n';
    await fs.writeFile(path.join(directory, relativePath), fileContent);
    const id = 'fm:plan:example.md';
    if (existingProjection) {
      await documentService.ensureTrackerProjection(id);
      expect(await documentService.listTrackerItems()).toEqual([]);
      // Retained projection links continue to resolve even while hidden.
      expect((await documentService.getTrackerItemById(id))?.title).toBe('Example plan');
    }

    const imported = await documentService.importTrackerItemFromFile(relativePath);

    expect(imported).toMatchObject({ skipped: false, item: { id, source: 'import', title: 'Example plan' } });
    expect((await documentService.listTrackerItems()).map(item => item.id)).toEqual([id]);
    expect(await documentService.importTrackerItemFromFile(relativePath)).toEqual({ item: null, skipped: true });
    // An unchanged legacy projection can be explicitly imported too, without
    // re-stamping its content modification time or leaving the card hidden.
    await state.db.query("UPDATE tracker_items SET source = 'frontmatter' WHERE id = $1", [id]);
    const before = (await state.db.query('SELECT updated FROM tracker_items WHERE id = $1', [id])).rows[0].updated;
    expect(await documentService.listTrackerItems()).toEqual([]);
    expect(await documentService.importTrackerItemFromFile(relativePath)).toMatchObject({ item: { source: 'import' }, skipped: false });
    expect((await state.db.query('SELECT updated FROM tracker_items WHERE id = $1', [id])).rows[0].updated).toEqual(before);
    expect((await state.db.query('SELECT id FROM tracker_items WHERE workspace = $1', [directory])).rows).toHaveLength(1);
    expect(await fs.readFile(path.join(directory, relativePath), 'utf8')).toBe(fileContent);
  });
});
