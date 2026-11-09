// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import { buildTrackerPlan, planDate, planHierarchy } from '../trackerPlan';
import { buildTicketDag, connectedTicketIds, ticketDagStatus } from '../trackerDag';
import { globalRegistry } from '@nimbalyst/tracker-schema';

beforeAll(() => loadBuiltinTrackers());
const ref = (itemId: string) => ({ itemId, trackerType: 'task' });
export function record(id: string, fields: Record<string, unknown> = {}, archived = false): TrackerRecord {
  return { id, primaryType: 'task', typeTags: ['task'], source: 'native', archived, syncStatus: 'local',
    system: { workspace: '/test', createdAt: '2026-11-01', updatedAt: '2026-11-01' },
    fields: { title: id, status: 'to-do', priority: 'medium', ...fields } } as TrackerRecord;
}

describe('ticket planning', () => {
  it('retains completed tickets and their graph links without making them actionable or blocking parent closeout', () => {
    const items = [
      record('done', { status: 'done', parentTask: ref('parent'), dueDate: '2020-01-01' }),
      record('parent'), record('next', { dependsOn: [ref('done')] }),
      record('inverse done', { status: 'done', blocks: [ref('inverse next')] }), record('inverse next'),
      record('archived done', { status: 'done' }, true), record('cancelled', { status: 'cancelled' }),
    ];
    const rows = buildTrackerPlan(items);
    expect(rows.find(row => row.item.id === 'done')).toMatchObject({ completed: true, ready: false, held: false, conflict: false });
    expect(rows.find(row => row.item.id === 'parent')).toMatchObject({ ready: true, childIds: ['done'] });
    expect(rows.find(row => row.item.id === 'next')).toMatchObject({ ready: true, prerequisiteIds: ['done'] });
    expect(rows.some(row => row.item.id === 'archived done' || row.item.id === 'cancelled')).toBe(false);
    const dag = buildTicketDag(rows, new Set(rows.map(row => row.item.id)));
    expect(dag.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'done', target: 'parent', kind: 'subtask' }),
      expect.objectContaining({ source: 'done', target: 'next', kind: 'dependency' }),
      expect.objectContaining({ source: 'inverse done', target: 'inverse next', kind: 'dependency' }),
    ]));
    expect(items[0].fields.status).toBe('done');
  });

  it('orders prerequisites and children before parent closeout, propagating urgent deadlines backwards', () => {
    const rows = buildTrackerPlan([
      record('parent', { dueDate: '2026-11-06' }),
      record('child', { parentTask: ref('parent'), dependsOn: [ref('setup')] }),
      record('setup', { priority: 'low' }),
      record('unrelated', { dueDate: '2026-11-10', priority: 'critical' }),
    ]);
    expect(rows.map(row => row.item.id)).toEqual(['setup', 'child', 'parent', 'unrelated']);
    expect(rows[0]).toMatchObject({ ready: true, effectiveDue: '2026-11-06', deadlineSourceId: 'parent' });
    expect(rows[1]).toMatchObject({ ready: false, depth: 1, effectiveDue: '2026-11-06' });
    expect(rows[2].childIds).toEqual(['child']);
  });

  it('satisfies closed dependencies using the full corpus while retaining hidden open prerequisites', () => {
    const rows = buildTrackerPlan([
      record('closed', { status: 'done' }, true),
      record('ready', { dependsOn: [ref('closed')] }),
      record('hidden-child', { parentTask: ref('parent') }), record('parent'),
    ]);
    expect(rows.find(row => row.item.id === 'ready')).toMatchObject({ ready: true, prerequisiteIds: [] });
    expect(rows.find(row => row.item.id === 'parent')).toMatchObject({ ready: false, prerequisiteIds: ['hidden-child'] });
    expect(rows.some(row => row.item.id === 'closed')).toBe(false);
  });

  it('holds missing links, cycles and their downstream dependents without losing tickets', () => {
    const rows = buildTrackerPlan([
      record('a', { dependsOn: [ref('b')] }), record('b', { dependsOn: [ref('a')] }),
      record('downstream', { dependsOn: [ref('a')] }),
      record('missing', { dependsOn: [ref('absent')] }), record('free'),
    ]);
    expect(rows[0]).toMatchObject({ item: { id: 'free' }, ready: true, held: false });
    expect(rows.slice(1).every(row => row.held && !row.ready)).toBe(true);
    expect(rows.find(row => row.item.id === 'missing')?.unresolvedIds).toEqual(['absent']);
    expect(rows).toHaveLength(5);
  });

  it('uses inverse-only hierarchy, reports conflicting dates, and preserves recorded dates', () => {
    const child = record('child', { dueDate: '2026-11-12', scheduledDate: '2026-11-10' });
    const rows = buildTrackerPlan([record('parent', { subtasks: [ref('child')], dueDate: '2026-11-06' }), child]);
    expect(rows[0]).toMatchObject({ parentId: 'parent', conflict: true, effectiveDue: '2026-11-06', due: '2026-11-12' });
    expect(child.fields.dueDate).toBe('2026-11-12');
  });

  it('keeps undated work visible and orders equal deadlines by priority deterministically', () => {
    const rows = buildTrackerPlan([record('low', { dueDate: '2026-11-10', priority: 'low' }), record('high', { dueDate: '2026-11-10', priority: 'high' }), record('undated')]);
    expect(rows.map(row => row.item.id)).toEqual(['high', 'low', 'undated']);
    expect(rows[2].effectiveDue).toBeNull();
  });

  it('keeps unfinished archived children as closeout prerequisites and respects future start dates', () => {
    const rows = buildTrackerPlan([
      record('parent'), record('archived child', { parentTask: ref('parent') }, true),
      record('future', { scheduledDate: '2026-11-10' }),
    ], new Date(2026, 10, 5));
    expect(rows.find(row => row.item.id === 'parent')).toMatchObject({ held: true, prerequisiteIds: ['archived child'] });
    expect(rows.find(row => row.item.id === 'future')).toMatchObject({ ready: false, held: false });
  });

  it('collapses a parent without dropping independent roots and keeps malformed hierarchy cycles inspectable', () => {
    const rows = buildTrackerPlan([record('parent'), record('child', { parentTask: ref('parent') }), record('root')]);
    expect(planHierarchy(rows, new Set()).map(row => row.item.id)).toEqual(['parent', 'child', 'root']);
    expect(planHierarchy(rows, new Set(['parent'])).map(row => row.item.id)).toEqual(['parent', 'root']);
    const cyclic = buildTrackerPlan([record('a', { parentTask: ref('b') }), record('b', { parentTask: ref('a') })]);
    expect(cyclic.every(row => row.held)).toBe(true);
    expect(planHierarchy(cyclic, new Set())).toHaveLength(2);
  });

  it('validates calendar dates without UTC shifts or overflow', () => {
    expect(planDate('2026-11-05')).toBe('2026-11-05');
    expect(planDate('2026-11-05T00:00:00Z')).toBe('2026-11-05');
    expect(planDate('2026-02-30')).toBeNull();
    expect(planDate('')).toBeNull();
  });
});

describe('ticket execution DAG', () => {
  it('directs dependencies and child closeout from earlier to later stages', () => {
    const plan = buildTrackerPlan([
      record('parent', { dueDate: '2026-11-12' }),
      record('child', { parentTask: ref('parent'), dependsOn: [ref('setup')] }),
      record('setup'),
    ]);
    const dag = buildTicketDag(plan, new Set(['parent', 'child', 'setup']));
    expect(dag.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'setup', target: 'child', kind: 'dependency' }),
      expect.objectContaining({ source: 'child', target: 'parent', kind: 'subtask' }),
    ]));
    const nodes = new Map(dag.nodes.map(node => [node.id, node]));
    for (const edge of dag.edges) {
      expect(nodes.get(edge.source)!.stage).toBeLessThan(nodes.get(edge.target)!.stage);
      expect(nodes.get(edge.source)!.x).toBeLessThan(nodes.get(edge.target)!.x);
    }
  });

  it('retains full-graph stages and hidden-prerequisite explanations under filters', () => {
    const plan = buildTrackerPlan([record('first'), record('second', { dependsOn: [ref('first')] }), record('third', { dependsOn: [ref('second')] })]);
    const dag = buildTicketDag(plan, new Set(['third']));
    expect(dag.nodes).toHaveLength(1);
    expect(dag.nodes[0]).toMatchObject({ id: 'third', stage: 2, outsidePrerequisiteCount: 1, row: { ready: false } });
    expect(dag.edges).toEqual([]);
  });

  it('keeps branching work parallel without overlapping nodes and traces only the selected path', () => {
    const plan = buildTrackerPlan([
      record('start'), record('left', { dependsOn: [ref('start')] }),
      record('right', { dependsOn: [ref('start')] }), record('end', { dependsOn: [ref('left'), ref('right')] }), record('independent'),
    ]);
    const dag = buildTicketDag(plan, new Set(plan.map(row => row.item.id)));
    const left = dag.nodes.find(node => node.id === 'left')!;
    const right = dag.nodes.find(node => node.id === 'right')!;
    expect(left.stage).toBe(right.stage);
    expect(left.y).not.toBe(right.y);
    expect(connectedTicketIds(dag, 'left')).toEqual(new Set(['start', 'left', 'end']));
    expect(new Set(dag.nodes.map(node => `${node.x}:${node.y}`)).size).toBe(dag.nodes.length);
  });

  it('exposes real cycles while omitting cyclic arrows and preserving downstream order', () => {
    const plan = buildTrackerPlan([record('a', { dependsOn: [ref('b')] }), record('b', { dependsOn: [ref('a')] }), record('after', { dependsOn: [ref('b')] }), record('free')]);
    const dag = buildTicketDag(plan, new Set(plan.map(row => row.item.id)));
    expect(dag.cycleEdges).toHaveLength(2);
    expect(dag.nodes.filter(node => node.inCycle).map(node => node.id).sort()).toEqual(['a', 'b']);
    expect(dag.edges).toEqual([expect.objectContaining({ source: 'b', target: 'after' })]);
    expect(dag.nodes.find(node => node.id === 'after')!.stage).toBeGreaterThan(dag.nodes.find(node => node.id === 'b')!.stage);
  });

  it('uses configured workflow status labels and colors, including renamed status fields', () => {
    const model = globalRegistry.get('task')!;
    const type = 'dag-status-fixture';
    globalRegistry.register({ ...model, type, roles: { ...model.roles, workflowStatus: 'phase' }, fields: model.fields.map(field => field.name === 'status' ? { ...field, name: 'phase', options: [{ value: 'in-progress', label: 'Building', color: '#123456', category: 'started' }] } : field) });
    const custom = { ...record('custom', { phase: 'in-progress' }), primaryType: type };
    expect(ticketDagStatus(custom)).toEqual({ value: 'in-progress', label: 'Building', color: '#123456' });
    expect(ticketDagStatus(record('review', { status: 'in-review' })).label).toBe('In Review');
    expect(ticketDagStatus(record('done', { status: 'done' })).label).toBe('Done');
  });
});
