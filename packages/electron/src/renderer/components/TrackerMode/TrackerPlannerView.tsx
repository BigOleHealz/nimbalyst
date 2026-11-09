import { clientSessionClass } from '@nimbalyst/runtime/core/clientSessionHighlight';
import React, { useEffect, useMemo, useState } from 'react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getRecordStatus, getRecordDisplayTitle as getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { buildTrackerPlan, planHierarchy, type PlanRow } from './trackerPlan';
import { TrackerDagView } from './TrackerDagView';
import { usePlannerTicketMenu, type PlannerTicketActions } from './usePlannerTicketMenu';
import './TrackerPlannerView.css';

interface Props {
  items: TrackerRecord[];
  allItems: TrackerRecord[];
  selectedItemId?: string | null;
  onItemSelect: (id: string) => void;
  menuActions?: PlannerTicketActions;
}

const dateNumber = (date: string) => Date.parse(`${date}T00:00:00Z`);
const DAY = 86400000;
const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function TrackerPlannerView({ items, allItems, selectedItemId, onItemSelect, menuActions }: Props) {
  const [mode, setMode] = useState<'dag' | 'queue' | 'timeline'>('dag');
  const [readyOnly, setReadyOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(7);
  const ticketMenu = usePlannerTicketMenu(allItems, onItemSelect, Boolean(selectedItemId), menuActions);
  useEffect(() => ticketMenu.close(), [mode, ticketMenu.close]);
  const plan = useMemo(() => buildTrackerPlan(allItems), [allItems]);
  const visibleIds = useMemo(() => new Set(items.map(item => item.id)), [items]);
  const visible = useMemo(() => plan.filter(row => visibleIds.has(row.item.id)), [plan, visibleIds]);
  const filtered = useMemo(() => visible.filter(row => !readyOnly || row.ready), [visible, readyOnly]);
  const graphIds = useMemo(() => new Set(filtered.map(row => row.item.id)), [filtered]);
  const rows = mode === 'timeline' ? planHierarchy(filtered, collapsed) : filtered;
  const corpus = useMemo(() => new Map(allItems.map(item => [item.id, item])), [allItems]);
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const dates = filtered.flatMap(row => [row.start, row.effectiveDue].filter((date): date is string => Boolean(date))).map(dateNumber);
  const first = Math.min(dateNumber(todayKey), ...dates);
  const last = Math.max(first + 13 * DAY, ...dates);
  // Bound the number of axis cells for unusually distant deadlines.
  const step = Math.max(zoom, Math.ceil((last - first) / DAY / 180));
  const slots = Math.ceil((last - first) / DAY / step) + 1;
  const width = Math.max(600, slots * 64);
  const span = slots * step * DAY;
  const position = (date: string) => (dateNumber(date) - first) / span * 100;
  const reference = (id: string) => {
    const item = corpus.get(id);
    return item ? getRecordTitle(item) : 'Unavailable linked ticket';
  };
  const openReference = (id: string) => corpus.has(id) && onItemSelect(id);
  const explanation = (row: PlanRow) => row.completed
    ? 'Completed. This ticket satisfies its dependent work.'
    : row.ready ? 'Ready to start. Completed prerequisites are satisfied.'
    : row.held
    ? 'On hold: unavailable links, a relationship cycle, or work blocked by one.'
    : row.childIds.length ? 'Complete the subtasks before closing this parent.'
      : row.prerequisiteIds.length ? 'Complete the linked prerequisites first.'
        : row.start && row.start > todayKey ? `Scheduled for ${dateLabel(row.start)}.`
          : row.effectiveDue ? 'Ready to start. Earlier deadlines come first, then priority.' : 'Ready to start. No deadline is recorded.';

  const ticket = (row: PlanRow, index: number) => (
    <div className="tracker-planner-ticket" style={mode === 'timeline' ? { paddingLeft: Math.min(row.depth, 8) * 16 + 10 } : undefined}>
      {mode === 'timeline' && row.childIds.length > 0 && <button type="button" className="tracker-planner-collapse" aria-label={`${collapsed.has(row.item.id) ? 'Expand' : 'Collapse'} ${getRecordTitle(row.item)}`} aria-expanded={!collapsed.has(row.item.id)} onClick={() => setCollapsed(previous => {
        const next = new Set(previous);
        if (next.has(row.item.id)) next.delete(row.item.id); else next.add(row.item.id);
        return next;
      })}>{collapsed.has(row.item.id) ? '▸' : '▾'}</button>}
      <div className="tracker-planner-ticket-content">
        <button type="button" className="tracker-planner-title" onClick={event => ticketMenu.select(event, row.item.id)}>
          {mode === 'queue' && <span className="tracker-planner-rank">{row.completed || row.held ? '—' : index + 1}</span>}
          {getRecordTitle(row.item)}
        </button>
        <div className="tracker-planner-meta select-text">
          <span>{getRecordStatus(row.item).replace(/-/g, ' ')}</span>
          <span className={row.ready || row.completed ? 'tracker-planner-ready' : ''}>{row.completed ? 'Completed' : row.held ? 'Needs attention' : row.ready ? 'Ready now' : row.prerequisiteIds.length ? `${row.prerequisiteIds.length} prerequisite${row.prerequisiteIds.length === 1 ? '' : 's'}` : 'Scheduled'}</span>
          {row.effectiveDue ? <span className={!row.completed && row.effectiveDue < todayKey ? 'tracker-planner-late' : ''}>{!row.completed && row.effectiveDue < todayKey ? 'Overdue · ' : ''}{row.due === row.effectiveDue ? 'Due ' : 'Needed by '}{dateLabel(row.effectiveDue)}</span> : <span>No due date</span>}
          {row.conflict && <span className="tracker-planner-late">Date conflict{row.due ? ` · own due ${dateLabel(row.due)}` : ''}</span>}
        </div>
        <p className="tracker-planner-reason select-text">{explanation(row)}</p>
        {row.parentId && <button className="tracker-planner-reference" type="button" disabled={!corpus.has(row.parentId)} onClick={() => openReference(row.parentId!)}>Parent: {reference(row.parentId)}</button>}
        {row.effectiveDue && row.deadlineSourceId !== row.item.id && <button className="tracker-planner-reference" type="button" onClick={() => openReference(row.deadlineSourceId)}>Deadline from: {reference(row.deadlineSourceId)}</button>}
        {row.prerequisiteIds.length > 0 && <details className="tracker-planner-dependencies"><summary>Prerequisites ({row.prerequisiteIds.length})</summary>{row.prerequisiteIds.map(id => <button className="tracker-planner-reference" type="button" key={id} disabled={!corpus.has(id)} onClick={() => openReference(id)}>{reference(id)}{!visibleIds.has(id) ? ' · outside this view' : ''}</button>)}</details>}
        {row.unresolvedIds.length > 0 && <p className="tracker-planner-late select-text">{row.unresolvedIds.length} unavailable link(s); check the ticket relationships.</p>}
      </div>
    </div>
  );

  return <section className="tracker-planner-view" aria-label="Ticket planner">
    <div className="tracker-planner-controls">
      <div role="tablist" aria-label="Planner visualization">
        <button type="button" role="tab" aria-selected={mode === 'dag'} onClick={() => setMode('dag')}>Dependency graph</button>
        <button type="button" role="tab" aria-selected={mode === 'queue'} onClick={() => setMode('queue')}>Suggested order</button>
        <button type="button" role="tab" aria-selected={mode === 'timeline'} onClick={() => setMode('timeline')}>Hierarchy timeline</button>
      </div>
      <label><input type="checkbox" checked={readyOnly} onChange={event => setReadyOnly(event.target.checked)} /> Ready now only</label>
      {mode === 'timeline' && <label>Scale <select aria-label="Timeline scale" value={zoom} onChange={event => setZoom(Number(event.target.value))}><option value={1}>Days</option><option value={7}>Weeks</option><option value={30}>30 days</option></select></label>}
      <span className="tracker-planner-summary">{visible.filter(row => !row.completed).length} open · {visible.filter(row => row.completed).length} completed · {visible.filter(row => row.ready).length} ready · {visible.filter(row => row.held).length} on hold</span>
    </div>
    <p className="tracker-planner-guide select-text">{mode === 'dag' ? 'Follow arrows from prerequisites to the work they unlock. Subtasks precede parent closeout; earlier deadlines order independent paths. Select a node to inspect its ticket in the right sidebar.' : 'Subtasks and dependencies first; earlier deadlines next, then priority. “Needed by” comes from a parent or dependent. Dates are unchanged. Timeline bars use recorded start dates; markers show deadlines.'}</p>
    {rows.length === 0 ? <div className="tracker-planner-empty select-text">{readyOnly ? 'No tickets are ready in this view. Turn off the ready filter to inspect their prerequisites.' : 'No tickets match the current Tracker filters.'}</div>
      : mode === 'dag' ? <div className="tracker-planner-dag-panel" role="tabpanel" aria-label="Dependency graph"><TrackerDagView plan={plan} visibleIds={graphIds} selectedItemId={selectedItemId} onItemSelect={onItemSelect} onItemClick={ticketMenu.select} onItemContextMenu={ticketMenu.open} /></div>
      : <div className="tracker-planner-scroll" role="tabpanel" aria-label={mode === 'queue' ? 'Suggested order' : 'Hierarchy timeline'}>
        {mode === 'timeline' && <div className="tracker-planner-axis" style={{ minWidth: width + 340 }}><div className="tracker-planner-axis-label">Ticket hierarchy</div><div className="tracker-planner-axis-dates" style={{ width }}>{Array.from({ length: slots }, (_, index) => <span key={index} style={{ left: `${index / slots * 100}%` }}>{new Date(first + index * step * DAY).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>)}</div></div>}
        {rows.map((row, index) => <div key={row.item.id} className={`${clientSessionClass(row.item)} tracker-planner-row ${row.completed ? 'tracker-planner-row-completed' : ''} ${mode === 'timeline' ? 'tracker-planner-timeline-row' : ''} ${selectedItemId === row.item.id ? 'tracker-planner-selected' : ''}`} style={mode === 'timeline' ? { minWidth: width + 340 } : undefined} onContextMenu={event => ticketMenu.open(event, row.item.id)} onDoubleClick={event => ticketMenu.open(event, row.item.id)}>
          {ticket(row, index)}
          {mode === 'timeline' && <div className="tracker-planner-track" style={{ width }}>
            <span className="tracker-planner-today" style={{ left: `${position(todayKey)}%` }} title="Today" />
            {row.effectiveDue ? <button type="button" className={`tracker-planner-marker ${row.ready || row.completed ? 'tracker-planner-marker-ready' : ''} ${row.held || row.conflict ? 'tracker-planner-marker-warning' : ''}`} style={{ left: `${position(row.start && row.start <= row.effectiveDue ? row.start : row.effectiveDue)}%`, width: row.start && row.start < row.effectiveDue ? `${(dateNumber(row.effectiveDue) - dateNumber(row.start)) / span * 100}%` : 14 }} onClick={event => ticketMenu.select(event, row.item.id)} aria-label={`Open ${getRecordTitle(row.item)}, ${row.due === row.effectiveDue ? 'due' : 'needed by'} ${dateLabel(row.effectiveDue)}`} /> : <span className="tracker-planner-undated">No due date</span>}
          </div>}
        </div>)}
      </div>}
    {ticketMenu.menu}
  </section>;
}
