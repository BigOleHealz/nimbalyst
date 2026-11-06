// @vitest-environment jsdom
import React, { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import { TrackerPlannerView } from '../TrackerPlannerView';

beforeAll(() => loadBuiltinTrackers());
const record = (id: string, fields: Record<string, unknown> = {}) => ({ id, primaryType: 'task', typeTags: ['task'], source: 'native', archived: false, syncStatus: 'local', system: { workspace: '/test', createdAt: '2026-11-01', updatedAt: '2026-11-01' }, fields: { title: id, status: 'to-do', ...fields } }) as TrackerRecord;

describe('planner interactions', () => {
  it('cancels the first sidebar open when a pointer double-click requests the menu', async () => {
    vi.useFakeTimers();
    try {
      const items = [record('Double-click target')];
      const select = vi.fn();
      render(<TrackerPlannerView items={items} allItems={items} onItemSelect={select} />);
      const target = screen.getByRole('button', { name: 'Open ticket Double-click target, To Do' });
      fireEvent.click(target, { detail: 1 });
      fireEvent.click(target, { detail: 2 });
      fireEvent.doubleClick(target, { detail: 2, clientX: 80, clientY: 100 });
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(select).not.toHaveBeenCalled();
      expect(screen.getByTestId('tracker-row-context-menu').textContent).toContain('Set Status');
    } finally { vi.useRealTimers(); }
  });

  describe.each(['Dependency graph', 'Hierarchy timeline', 'Suggested order'])('%s ticket menu', mode => {
    it.each(['right-click', 'double-click'])('opens the shared Tracker actions on %s', async gesture => {
      const items = [record('First ticket'), record('Menu target')];
      const onLaunchSession = vi.fn();
      const onOpenDocument = vi.fn();
      render(<TrackerPlannerView items={items} allItems={items} onItemSelect={vi.fn()} menuActions={{ onLaunchSession, onOpenDocument, onArchiveItems: vi.fn(), onDeleteItems: vi.fn(), confirmDelete: vi.fn().mockResolvedValue(false) }} />);
      fireEvent.click(screen.getByRole('tab', { name: mode }));
      const target = screen.getByRole('button', { name: mode === 'Dependency graph' ? 'Open ticket Menu target, To Do' : mode === 'Suggested order' ? /\d+ Menu target/ : /^Menu target$/ });
      if (gesture === 'right-click') fireEvent.contextMenu(target, { clientX: 80, clientY: 100 });
      else fireEvent.doubleClick(target, { clientX: 80, clientY: 100 });
      await screen.findByTestId('tracker-row-context-menu');
      expect(screen.getByText('1 item selected').textContent).toBe('1 item selected');
      expect(screen.getByText('Set Status').textContent).toBe('Set Status');
      expect(screen.getByText('Set Priority').textContent).toBe('Set Priority');
      expect(screen.getByTestId('tracker-row-context-archive').textContent).toContain('Archive');
      expect(screen.getByTestId('tracker-row-context-delete').textContent).toContain('Delete');
      fireEvent.click(screen.getByTestId('tracker-row-context-launch-session'));
      expect(onLaunchSession).toHaveBeenCalledWith('Menu target');
      expect(screen.queryByTestId('tracker-row-context-menu')).toBeNull();
      fireEvent.contextMenu(target, { clientX: 80, clientY: 100 });
      fireEvent.click(await screen.findByTestId('tracker-row-context-open-document'));
      expect(onOpenDocument).toHaveBeenCalledWith('Menu target');
    });
  });

  it('writes status and priority only to the context-clicked ticket using the Tracker write path', async () => {
    const previousAPI = (window as any).electronAPI;
    const updateTrackerItems = vi.fn(async ({ entries }: { entries: Array<{ itemId: string }> }) => ({ success: true, results: entries.map(entry => ({ itemId: entry.itemId, success: true })) }));
    (window as any).electronAPI = { documentService: { updateTrackerItems } };
    try {
      const items = [record('Already selected'), record('Change this ticket')];
      render(<TrackerPlannerView items={items} allItems={items} selectedItemId="Already selected" onItemSelect={vi.fn()} />);
      const target = screen.getByRole('button', { name: 'Open ticket Change this ticket, To Do' });
      fireEvent.contextMenu(target, { clientX: 80, clientY: 100 });
      fireEvent.mouseEnter((await screen.findByText('Set Status')).parentElement!);
      fireEvent.click(await screen.findByRole('button', { name: 'In Review' }));
      await waitFor(() => expect(updateTrackerItems).toHaveBeenCalledWith({ entries: [expect.objectContaining({ itemId: 'Change this ticket', storeUpdates: { status: 'in-review' } })] }));
      fireEvent.contextMenu(target, { clientX: 80, clientY: 100 });
      fireEvent.mouseEnter((await screen.findByText('Set Priority')).parentElement!);
      fireEvent.click(await screen.findByRole('button', { name: 'High' }));
      await waitFor(() => expect(updateTrackerItems).toHaveBeenLastCalledWith({ entries: [expect.objectContaining({ itemId: 'Change this ticket', storeUpdates: { priority: 'high' } })] }));
    } finally { (window as any).electronAPI = previousAPI; }
  });

  it('keeps delete confirmation, archive targeting, and Escape dismissal identical to Tracker actions', async () => {
    const items = [record('Protected ticket')];
    const confirmDelete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onDeleteItems = vi.fn();
    const onArchiveItems = vi.fn();
    render(<TrackerPlannerView items={items} allItems={items} onItemSelect={vi.fn()} menuActions={{ confirmDelete, onDeleteItems, onArchiveItems }} />);
    const target = screen.getByRole('button', { name: 'Open ticket Protected ticket, To Do' });
    fireEvent.contextMenu(target, { clientX: 80, clientY: 100 });
    fireEvent.click(await screen.findByTestId('tracker-row-context-delete'));
    await waitFor(() => expect(confirmDelete).toHaveBeenCalledWith(1));
    expect(onDeleteItems).not.toHaveBeenCalled();
    fireEvent.contextMenu(target, { clientX: 80, clientY: 100 });
    fireEvent.click(await screen.findByTestId('tracker-row-context-delete'));
    await waitFor(() => expect(onDeleteItems).toHaveBeenCalledWith(['Protected ticket']));
    fireEvent.contextMenu(target, { clientX: 80, clientY: 100 });
    fireEvent.click(await screen.findByTestId('tracker-row-context-archive'));
    expect(onArchiveItems).toHaveBeenCalledWith(['Protected ticket'], true);
    fireEvent.contextMenu(target, { clientX: 80, clientY: 100 });
    await screen.findByTestId('tracker-row-context-menu');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('tracker-row-context-menu')).toBeNull();
  });

  it('pans from a node without mistaking the completed drag for a ticket click', async () => {
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
    await waitFor(() => expect(open).toHaveBeenCalledWith('Drag-safe ticket'));
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
