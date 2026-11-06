// @vitest-environment jsdom
import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import { TrackerPlannerView } from '../TrackerPlannerView';

beforeAll(() => loadBuiltinTrackers());
const record = (id: string, fields: Record<string, unknown> = {}) => ({ id, primaryType: 'task', typeTags: ['task'], source: 'native', archived: false, syncStatus: 'local', system: { workspace: '/test', createdAt: '2026-11-01', updatedAt: '2026-11-01' }, fields: { title: id, status: 'to-do', ...fields } }) as TrackerRecord;

describe('planner interactions', () => {
  it('opens real tickets, filters readiness, and collapses hierarchy after switching views', () => {
    const parent = record('Release checkout', { dueDate: '2026-12-11' });
    const child = record('Prove test payments', { parentTask: { itemId: parent.id }, dueDate: '2026-12-04' });
    const open = vi.fn();
    render(<TrackerPlannerView items={[parent, child]} allItems={[parent, child]} onItemSelect={open} />);
    fireEvent.click(screen.getByRole('button', { name: /1 Prove test payments/ }));
    expect(open).toHaveBeenLastCalledWith(child.id);
    fireEvent.click(screen.getByLabelText('Ready now only'));
    expect(screen.queryByRole('button', { name: /2 Release checkout/ })).toBeNull();
    fireEvent.click(screen.getByLabelText('Ready now only'));
    fireEvent.click(screen.getByRole('tab', { name: 'Hierarchy timeline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Release checkout' }));
    expect(screen.queryByRole('button', { name: /^Open Prove test payments/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Release checkout' }));
    fireEvent.click(screen.getByRole('button', { name: /^Open Prove test payments/ }));
    expect(open).toHaveBeenLastCalledWith(child.id);
    fireEvent.change(screen.getByLabelText('Timeline scale'), { target: { value: '1' } });
    expect((screen.getByLabelText('Timeline scale') as HTMLSelectElement).value).toBe('1');
  });
});
