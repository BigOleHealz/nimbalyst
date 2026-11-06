import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getWorkflowStatusOptions } from '@nimbalyst/tracker-schema';
import { TrackerRowContextMenu, type TrackerRowContextMenuProps } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerRowContextMenu';
import { useTrackerRows } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/useTrackerRows';

export type PlannerTicketActions = Pick<TrackerRowContextMenuProps,
  'onOpenDocument' | 'onCopyDeepLink' | 'getLinkedSessions' | 'onOpenSession' |
  'onLaunchSession' | 'onLaunchWorktree' | 'onArchiveItems' | 'onDeleteItems' | 'confirmDelete'>;

/** Use the Tracker's own menu and mutation handlers for every Planner surface. */
export function usePlannerTicketMenu(items: TrackerRecord[], onItemSelect: (id: string) => void, hasDetailPanel: boolean, actions: PlannerTicketActions = {}) {
  // The type is stable here: changing it on a right-click would clear the
  // selection. The menu below derives options from the selected ticket itself.
  const rows = useTrackerRows({ items, activeTypeFilter: 'all' });
  const itemById = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  const selectedId = [...rows.selectedIds][0];
  const selectedItem = selectedId ? itemById.get(selectedId) : undefined;
  const pendingClick = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingClick = useCallback(() => {
    if (pendingClick.current !== null) clearTimeout(pendingClick.current);
    pendingClick.current = null;
  }, []);
  const close = useCallback(() => { cancelPendingClick(); rows.closeContextMenu(); }, [cancelPendingClick, rows.closeContextMenu]);
  const options = selectedItem ? getWorkflowStatusOptions(selectedItem.primaryType) : [];
  const editable = selectedItem ? rows.isItemEditable(selectedItem) : false;

  const open = useCallback((event: React.MouseEvent, itemId: string) => {
    cancelPendingClick();
    event.preventDefault();
    event.stopPropagation();
    if (!itemById.has(itemId)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    rows.openContextMenuForIds([itemId], {
      x: event.clientX || rect.left + Math.min(rect.width / 2, 100),
      y: event.clientY || rect.top + Math.min(rect.height / 2, 40),
    });
  }, [cancelPendingClick, itemById, rows.openContextMenuForIds]);

  const select = useCallback((event: React.MouseEvent, itemId: string) => {
    cancelPendingClick();
    if (event.detail > 1) return;
    if (hasDetailPanel || event.detail === 0) { onItemSelect(itemId); return; }
    // Opening the first sidebar resizes the graph. Let a pointer double-click
    // finish before moving its target; keyboard activation remains immediate.
    pendingClick.current = setTimeout(() => { pendingClick.current = null; onItemSelect(itemId); }, 500);
  }, [cancelPendingClick, hasDetailPanel, onItemSelect]);

  useEffect(() => () => cancelPendingClick(), [cancelPendingClick, onItemSelect]);

  useEffect(() => {
    if (!rows.contextAnchor) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rows.contextAnchor, close]);

  return {
    open,
    select,
    close,
    menu: <TrackerRowContextMenu
      {...actions}
      anchor={selectedItem ? rows.contextAnchor : null}
      refs={rows.contextRefs}
      floatingStyles={rows.contextFloatingStyles}
      selectedIds={rows.selectedIds}
      activeTypeFilter={selectedItem?.primaryType ?? 'all'}
      statusOptions={options}
      onSetStatus={rows.handleBulkStatusUpdate}
      onSetPriority={rows.handleBulkPriorityUpdate}
      onArchiveItems={editable ? actions.onArchiveItems : undefined}
      onDeleteItems={editable ? actions.onDeleteItems : undefined}
      closeContextMenu={close}
      clearSelection={() => rows.setSelectedIds(new Set())}
    />,
  };
}
