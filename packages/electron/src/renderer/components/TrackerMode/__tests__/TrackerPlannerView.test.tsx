// @vitest-environment jsdom
import React, { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import { TrackerPlannerView } from '../TrackerPlannerView';

beforeAll(() => loadBuiltinTrackers());
const record = (id: string, fields: Record<string, unknown> = {}) => ({ id, primaryType: 'task', typeTags: ['task'], source: 'native', archived: false, syncStatus: 'local', system: { workspace: '/test', createdAt: '2026-11-01', updatedAt: '2026-11-01' }, fields: { title: id, status: 'to-do', ...fields } }) as TrackerRecord;

describe('planner interactions', () => {
  it('pans from a node without mistaking the completed drag for a ticket click', () => {
    const items = [record('Drag-safe ticket')];
    const open = vi.fn();
    render(<TrackerPlannerView items={items} allItems={items} onItemSelect={open} />);
    const viewport = screen.getByTestId('tracker-dag-viewport');
    Object.assign(viewport, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    const node = screen.getByRole('button', { name: 'Open ticket Drag-safe ticket, To Do' });
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 30 });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      return event;
    };
    fireEvent(node, pointer('pointerdown', 30));
    fireEvent(viewport, pointer('pointermove', 100));
    fireEvent(viewport, pointer('pointerup', 100));
    fireEvent.click(node, { detail: 1 });
    expect(open).not.toHaveBeenCalled();
    fireEvent(node, pointer('pointerdown', 100));
    fireEvent(node, pointer('pointerup', 100));
    fireEvent.click(node, { detail: 1 });
    expect(open).toHaveBeenCalledWith('Drag-safe ticket');
  });

  it('opens selected graph tickets in the host sidebar and keeps the graph active', () => {
    const items = [record('Configure checkout', { status: 'in-progress', description: 'Connect the existing payment flow.' }), record('Verify checkout', { dependsOn: [{ itemId: 'Configure checkout' }], description: 'Verify successful and failed payments.' })];
    function Host() {
      const [selected, setSelected] = useState<string | null>(null);
      const item = items.find(candidate => candidate.id === selected);
      return <><TrackerPlannerView items={items} allItems={items} selectedItemId={selected} onItemSelect={setSelected} />{item && <aside aria-label="Ticket details"><h2>{String(item.fields.title)}</h2><p>{String(item.fields.description)}</p><button onClick={() => setSelected(null)}>Close ticket details</button></aside>}</>;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Open ticket Verify checkout, To Do' }));
    expect(screen.getByRole('complementary', { name: 'Ticket details' }).textContent).toContain('Verify successful and failed payments.');
    expect(screen.getByRole('button', { name: 'Open ticket Verify checkout, To Do' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Dependency graph' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Next ready ticket' }));
    expect(screen.getByRole('complementary', { name: 'Ticket details' }).textContent).toContain('Connect the existing payment flow.');
    fireEvent.click(screen.getByRole('button', { name: 'Close ticket details' }));
    expect(screen.queryByRole('complementary', { name: 'Ticket details' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Dependency graph' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps cyclic tickets inspectable and updates node status labels from live records', () => {
    const items = [record('a', { dependsOn: [{ itemId: 'b' }] }), record('b', { dependsOn: [{ itemId: 'a' }] })];
    const open = vi.fn();
    const { rerender } = render(<TrackerPlannerView items={items} allItems={items} onItemSelect={open} />);
    expect(screen.getByRole('status').textContent).toContain('cyclic link(s)');
    fireEvent.click(screen.getByRole('button', { name: 'Open ticket a, To Do' }));
    expect(open).toHaveBeenCalledWith('a');
    const changed = [record('a', { status: 'in-review' }), items[1]];
    rerender(<TrackerPlannerView items={changed} allItems={changed} onItemSelect={open} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open ticket a, In Review' }));
    expect(open).toHaveBeenLastCalledWith('a');
  });

  it('opens real tickets, filters readiness, and collapses hierarchy after switching views', () => {
    const parent = record('Release checkout', { dueDate: '2026-12-11' });
    const child = record('Prove test payments', { parentTask: { itemId: parent.id }, dueDate: '2026-12-04' });
    const open = vi.fn();
    render(<TrackerPlannerView items={[parent, child]} allItems={[parent, child]} onItemSelect={open} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Suggested order' }));
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
