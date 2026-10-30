// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { resolveColumnsForType } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import { matchesFilterSet, type TrackerFilterOp, type TrackerFilterSet } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerFilters';
import { createTrackerFilterFields, getTrackerHeaderFilterValue } from '../createTrackerFilterFields';
import { buildHeaderFilterFields } from '../trackerHeaderFilterFields';
import { TrackerFilterValueMenu } from '../TrackerFilterValueMenu';

const record = (id: string, fields: Record<string, unknown>): TrackerRecord => ({
  id, primaryType: 'task', typeTags: ['task'], source: 'native', archived: false, syncStatus: 'local',
  fields: { title: id, status: 'to-do', ...fields },
  system: { workspace: '/project', createdAt: '', updatedAt: '' },
});
const rows = [
  record('parent', {}),
  record('child-a', { parentTask: { itemId: 'parent', title: 'Ship search' } }),
  record('child-b', { parentTask: { itemId: 'parent', title: 'Ship search' }, status: 'in-progress' }),
  record('other-child', { parentTask: { itemId: 'parent-other', title: 'Other work' } }),
];

beforeAll(loadBuiltinTrackers);

describe('parent task board filter', () => {
  it.each(['task', ''])('offers a parent picker and filters exact children in the %s view', schemaType => {
    const columns = resolveColumnsForType(schemaType);
    const getValue = (item: TrackerRecord, field: string) => getTrackerHeaderFilterValue(item, field, columns, {});
    const fields = buildHeaderFilterFields(createTrackerFilterFields(columns, schemaType, globalRegistry.getAll()), rows, getValue);
    const parent = fields.find(field => field.id === 'parentTask')!;
    expect(parent.options).toEqual(expect.arrayContaining([{ value: 'parent', label: 'Ship search', count: 2 }]));

    let filters: TrackerFilterSet | null = null;
    const onSelect = vi.fn((value: unknown, op: TrackerFilterOp = '=') => { filters = { clauses: [{ field: 'parentTask', op, value }] }; });
    const { unmount } = render(<TrackerFilterValueMenu field={parent} anchorRect={null} onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tracker-filter-option-parent'));
    expect(onSelect).toHaveBeenCalledWith('parent', '=');
    const saved = JSON.parse(JSON.stringify(filters));
    expect(rows.filter(item => matchesFilterSet(saved, field => getValue(item, field))).map(item => item.id)).toEqual(['child-a', 'child-b']);
    unmount();
  });

  it('can show top-level tasks with an empty parent filter', () => {
    const columns = resolveColumnsForType('task');
    const filters: TrackerFilterSet = { clauses: [{ field: 'parentTask', op: 'is-empty' }] };
    expect(rows.filter(item => matchesFilterSet(filters, field => getTrackerHeaderFilterValue(item, field, columns, {}))).map(item => item.id)).toEqual(['parent']);
  });

  it('respects a workspace schema that removes task hierarchy fields', () => {
    const task = globalRegistry.get('task')!;
    const customized = { ...task, fields: task.fields.filter(field => field.name !== 'parentTask') };
    expect(createTrackerFilterFields(resolveColumnsForType(''), '', [customized]).some(field => field.id === 'parentTask')).toBe(false);
  });
});
