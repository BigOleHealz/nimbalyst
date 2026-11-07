// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { mockQuery, mockGlobalRegistryGet } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGlobalRegistryGet: vi.fn((type: string) => {
    if (type === 'plan') {
      return {
        modes: { inline: false, fullDocument: true },
        roles: { workflowStatus: 'status' },
        fields: [{
          name: 'status',
          options: [
            { value: 'draft' },
            { value: 'completed' },
          ],
        }, {
          name: 'collection',
          type: 'relationship',
          relationshipTypeKey: 'in-collection',
          multiValue: true,
        }],
      };
    }
    return undefined;
  }),
}));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: mockQuery,
  },
}));

vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(),
  unsyncTrackerItem: vi.fn(),
  isTrackerSyncActive: vi.fn(() => false),
}));

vi.mock('../TrackerIdentityService', () => ({
  getCurrentIdentity: vi.fn(() => ({ displayName: 'Test User' })),
}));

vi.mock('../../../../../tracker-schema/src/TrackerDataModel', () => ({
  globalRegistry: {
    get: mockGlobalRegistryGet,
    getForWorkspace: (_workspacePath: string, type: string) => mockGlobalRegistryGet(type),
    hasWorkspaceLayer: () => true,
  },
}));

import { ElectronDocumentService } from '../ElectronDocumentService';
import { trackerItemToRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { buildFullDocumentTrackerId } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';

describe('ElectronDocumentService frontmatter compatibility', () => {
  let tempDir: string;
  let service: ElectronDocumentService;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frontmatter-compat-'));
    await fs.mkdir(path.join(tempDir, 'plans'), { recursive: true });
    service = new ElectronDocumentService(tempDir);
  });

  afterEach(async () => {
    service?.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('keeps discovered Markdown plans out of the tracker without changing the file', async () => {
    await fs.writeFile(
      path.join(tempDir, 'plans/example.md'),
      `---
title: Example plan
status: to-do
priority: high
trackerStatus:
  type: plan
---

# Body
`,
      'utf-8',
    );
    mockQuery.mockResolvedValue({ rows: [] });

    await service.refreshWorkspaceData();
    const items = await service.listTrackerItems();

    expect(items).toEqual([]);
    expect(await fs.readFile(path.join(tempDir, 'plans/example.md'), 'utf8')).toContain('# Body');
  });

  it.each([false, true])('hides previously indexed file cards and retains native and imported items (JSON text: %s)', async (jsonText) => {
    const rows = ['frontmatter', 'inline', null, 'native', 'import'].map((source, index) => ({
      id: `item-${index}`, type: 'task', source, workspace: tempDir,
      document_path: 'plans/example.md', source_ref: 'plans/example.md',
      data: jsonText ? JSON.stringify({ title: `Item ${index}`, status: 'to-do' }) : { title: `Item ${index}`, status: 'to-do' },
      last_indexed: new Date().toISOString(),
    }));
    mockQuery.mockResolvedValue({ rows });

    expect((await service.listTrackerItems()).map(item => item.id)).toEqual(['item-3', 'item-4']);
    expect((await service.getTrackerItemsByType('task')).map(item => item.id)).toEqual(['item-3', 'item-4']);
    expect((await service.getTrackerItemsByModule('plans/example.md')).map(item => item.id)).toEqual(['item-3', 'item-4']);
  });

  it('does not create or broadcast tracker cards when scanned Markdown changes', async () => {
    const relativePath = 'plans/example.md';
    const fullPath = path.join(tempDir, relativePath);
    await fs.writeFile(fullPath, '---\nplanStatus:\n  title: Example\n  status: draft\n---\nA task #task[status:to-do]\n');
    mockQuery.mockResolvedValue({ rows: [] });
    const listener = vi.fn();
    service.watchTrackerItems(listener);

    await service.refreshWorkspaceData();
    await fs.appendFile(fullPath, '\nAnother task #task[status:to-do]\n');
    await service.refreshFileMetadata(relativePath);

    expect(listener).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.filter(([sql]) => /INSERT INTO tracker_items|UPDATE tracker_items|DELETE FROM tracker_items/.test(sql))).toEqual([]);
  });

  it('normalizes the audited complete plan status only in its tracker projection', async () => {
    const relativePath = 'plans/git-changes-tab-density-mask-commit.md';
    const fileContent = `---
planStatus:
  title: Git changes tab density mask commit
  status: complete
---

# Body
`;
    await fs.writeFile(path.join(tempDir, relativePath), fileContent, 'utf-8');
    mockQuery.mockResolvedValue({ rows: [] });

    await service.refreshWorkspaceData();
    const items = await (service as any).listFullDocumentTrackerItemsFromMetadata();

    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('completed');
    expect(await fs.readFile(path.join(tempDir, relativePath), 'utf-8')).toBe(fileContent);
  });

  it('surfaces an unknown plan status as a read-only derived signal', async () => {
    const relativePath = 'plans/unknown-status.md';
    const fileContent = `---
planStatus:
  title: Unknown status
  status: finished
---

# Body
`;
    await fs.writeFile(path.join(tempDir, relativePath), fileContent, 'utf-8');
    mockQuery.mockResolvedValue({ rows: [] });

    await service.refreshWorkspaceData();
    const [item] = await (service as any).listFullDocumentTrackerItemsFromMetadata();
    const record = trackerItemToRecord(item);

    expect(record.fields.status).toBe('finished');
    expect(record.system.derivedSignals).toEqual([{
      kind: 'plan-invalid-status',
      reason: 'unrecognized-status',
      status: 'finished',
      validStatuses: ['draft', 'completed'],
    }]);
    expect(await fs.readFile(path.join(tempDir, relativePath), 'utf-8')).toBe(fileContent);
  });

  it('stores a file-backed relationship update only in canonical nested customFields', async () => {
    const relativePath = 'plans/example.md';
    const canonicalId = buildFullDocumentTrackerId('plan', relativePath);
    await fs.writeFile(
      path.join(tempDir, relativePath),
      `---
planStatus:
  title: Example plan
  status: draft
  collection:
    - itemId: milestone-a
---

# Body
`,
      'utf-8',
    );

    const state = {
      row: {
        id: canonicalId,
        type: 'plan',
        type_tags: ['plan'],
        data: JSON.stringify({
          title: 'Example plan',
          status: 'draft',
          customFields: {
            collection: [{ itemId: 'milestone-a' }],
          },
        }),
        workspace: tempDir,
        document_path: relativePath,
        line_number: 0,
        created: '2026-08-11T00:00:00.000Z',
        updated: '2026-08-11T00:00:00.000Z',
        last_indexed: '2026-08-11T00:00:00.000Z',
        sync_status: 'local',
        archived: false,
        archived_at: null,
        source: 'frontmatter',
        source_ref: relativePath,
        body_version: 0,
        content: JSON.stringify('# Body'),
      } as any,
    };

    mockQuery.mockImplementation(async (sql: string, params?: any[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT * FROM tracker_items WHERE id = $1')) {
        return { rows: params?.[0] === canonicalId ? [state.row] : [] };
      }
      if (normalized.startsWith('UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2')) {
        state.row = { ...state.row, data: params?.[0] };
        return { rows: [] };
      }
      throw new Error(`Unexpected query in test: ${normalized}`);
    });

    const updated = await service.updateTrackerItemInFile(canonicalId, {
      collection: [{ itemId: 'milestone-b' }],
      status: 'completed',
    });

    const stored = JSON.parse(state.row.data);
    expect(stored.customFields.collection).toEqual([{ itemId: 'milestone-b' }]);
    expect(stored.completedAt).toEqual(expect.any(String));
    expect(await fs.readFile(path.join(tempDir, relativePath), 'utf-8')).toContain('completedAt:');
    expect(stored).not.toHaveProperty('collection');
    expect(updated.customFields?.collection).toEqual([{ itemId: 'milestone-b' }]);
    expect(await fs.readFile(path.join(tempDir, relativePath), 'utf-8')).toContain('itemId: milestone-b');
  });

  it('creates a projection row when updating kanban sort order for a canonical plan id', async () => {
    const relativePath = 'plans/example.md';
    const canonicalId = buildFullDocumentTrackerId('plan', relativePath);
    await fs.writeFile(
      path.join(tempDir, relativePath),
      `---
title: Example plan
status: to-do
priority: high
trackerStatus:
  type: plan
---

# Body
`,
      'utf-8',
    );

    const state: {
      row: any | null;
    } = {
      row: null,
    };

    mockQuery.mockImplementation(async (sql: string, params?: any[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('SELECT * FROM tracker_items WHERE id = $1')) {
        return { rows: state.row && params?.[0] === canonicalId ? [state.row] : [] };
      }

      // The file->row lookup deliberately does NOT filter on `source`: a shared
      // file-backed item is promoted to `source = 'native'` but keeps its
      // `source_ref`, and filtering it out would mint a duplicate projection.
      if (normalized.includes('WHERE workspace = $1 AND source_ref = $2 AND type = $3')) {
        return { rows: state.row ? [state.row] : [] };
      }

      if (normalized.startsWith('SELECT id FROM tracker_items')) {
        return { rows: [] };
      }

      if (normalized.startsWith('INSERT INTO tracker_items (')) {
        state.row = {
          id: canonicalId,
          type: 'plan',
          type_tags: ['plan'],
          data: JSON.stringify({
            title: 'Example plan',
            status: 'to-do',
            priority: 'high',
          }),
          workspace: tempDir,
          document_path: relativePath,
          line_number: 0,
          created: '2026-05-20T00:00:00.000Z',
          updated: '2026-05-20T00:00:00.000Z',
          last_indexed: '2026-05-20T00:00:00.000Z',
          sync_status: 'local',
          archived: false,
          archived_at: null,
          source: 'frontmatter',
          source_ref: relativePath,
          body_version: 0,
          content: JSON.stringify('# Body'),
        };
        return { rows: [] };
      }

      if (normalized.startsWith('UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2')) {
        state.row = {
          ...state.row,
          data: params?.[0],
        };
        return { rows: [state.row] };
      }

      throw new Error(`Unexpected query in test: ${normalized}`);
    });

    const updated = await service.updateTrackerItem(canonicalId, {
      kanbanSortOrder: 'a0',
    });

    expect(updated.id).toBe(canonicalId);
    expect(updated.customFields?.kanbanSortOrder).toBe('a0');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tracker_items'),
      expect.arrayContaining([canonicalId, 'plan']),
    );
  });
});
