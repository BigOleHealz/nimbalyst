// @vitest-environment jsdom
import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import { computeReadiness } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerReadiness';
import { getRecordStatus } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { KanbanBoard } from '../KanbanBoard';

// jsdom has no layout viewport for virtua. Keep the real board/card/actions.
vi.mock('virtua', () => ({ VList: ({ data, children }: { data: TrackerRecord[]; children: (record: TrackerRecord, index: number) => React.ReactNode }) => <>{data.map(children)}</> }));

beforeAll(() => loadBuiltinTrackers());
const record = (id: string, fields = {}) => ({ id, issueKey: `TEST-${id}`, primaryType: 'task', typeTags: ['task'], source: 'native', archived: false, syncStatus: 'local', system: { workspace: '/test', createdAt: '2026-11-05', updatedAt: '2026-11-05' }, fields: { title: id, status: 'to-do', ...fields } }) as TrackerRecord;

describe('Kanban dependency placement', () => {
  it('moves a ticket out of Blocked on live completion and back on reopen without changing its status', () => {
    const blocker = record('blocker');
    const dependent = record('dependent', { status: 'in-progress', dependsOn: [{ itemId: blocker.id }] });
    const onItemSelect = vi.fn();
    const store = createStore();
    const board = (items: TrackerRecord[]) => <Provider store={store}><KanbanBoard filterType="task" overrideItems={[dependent]} readinessByItemId={computeReadiness(items, getRecordStatus)} onItemSelect={onItemSelect} /></Provider>;
    const { rerender } = render(board([blocker, dependent]));
    const lane = () => screen.getByTestId('tracker-kanban-column-dependency:blocked');
    expect(within(lane()).getAllByTestId('tracker-kanban-card').map(card => card.dataset.itemId)).toEqual(['dependent']);
    fireEvent.click(screen.getByLabelText('Open blocker TEST-blocker: blocker'));
    expect(onItemSelect).toHaveBeenCalledExactlyOnceWith('blocker');
    rerender(board([record('blocker', { status: 'done' }), dependent]));
    expect(within(lane()).queryAllByTestId('tracker-kanban-card')).toHaveLength(0);
    expect(within(screen.getByTestId('tracker-kanban-column-in-progress')).getAllByTestId('tracker-kanban-card').map(card => card.dataset.itemId)).toEqual(['dependent']);
    expect(screen.queryByLabelText(/Open blocker/)).toBeNull();
    expect(dependent.fields.status).toBe('in-progress');
    rerender(board([blocker, dependent]));
    expect(within(lane()).getAllByTestId('tracker-kanban-card').map(card => card.dataset.itemId)).toEqual(['dependent']);
  });

  it('keeps filtered blockers effective while respecting the existing visibility scope', () => {
    const blocker = { ...record('private-blocker'), primaryType: 'bug', typeTags: ['bug'] };
    const dependent = record('dependent', { dependsOn: [{ itemId: blocker.id }] });
    render(<Provider><KanbanBoard filterType="task" overrideItems={[dependent]} readinessByItemId={computeReadiness([blocker, dependent], getRecordStatus)} blockerScope={{ type: 'task' }} onItemSelect={vi.fn()} /></Provider>);
    expect(within(screen.getByTestId('tracker-kanban-column-dependency:blocked')).getAllByTestId('tracker-kanban-card')).toHaveLength(1);
    expect(screen.getByText('A bug outside this view · to-do').textContent).toContain('outside this view');
    expect(screen.queryByLabelText(/private-blocker/)).toBeNull();
  });

  it('explains dependency cycles directly on the blocked card', () => {
    const item = record('cycle', { dependsOn: [{ itemId: 'cycle' }] });
    render(<Provider><KanbanBoard filterType="task" overrideItems={[item]} readinessByItemId={computeReadiness([item], getRecordStatus)} /></Provider>);
    expect(screen.getByText('Dependency cycle: change a dependency to unblock this work.').textContent).toContain('Dependency cycle');
  });
});
