import React, { useEffect, useMemo, useState } from 'react';
import { calendarMonthDays, localCalendarDay, taskCalendarDay, taskCalendarEntries, type TaskCalendarEntry, type TrackerRecord } from '@nimbalyst/tracker-core';
import './TrackerCalendarView.css';
import { getRecordDisplayTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';

interface TrackerCalendarViewProps {
  items: readonly TrackerRecord[];
  onItemSelect?: (itemId: string) => void;
  selectedItemId?: string | null;
}

export function TrackerCalendarView({ items, onItemSelect, selectedItemId }: TrackerCalendarViewProps) {
  const [today, setToday] = useState(() => localCalendarDay(new Date()));
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(today);
  const [includeEarlier, setIncludeEarlier] = useState(false);
  const [showUndated, setShowUndated] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setToday(localCalendarDay(new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  const entries = useMemo(() => taskCalendarEntries(items), [items]);
  const byDay = useMemo(() => {
    const days = new Map<string, TaskCalendarEntry[]>();
    for (const entry of entries) days.set(entry.date, [...(days.get(entry.date) ?? []), entry]);
    return days;
  }, [entries]);
  const undated = useMemo(() => {
    const dated = new Set(entries.map(entry => entry.item.id));
    return items.filter(item => (item.primaryType === 'task' || item.typeTags.includes('task')) && !dated.has(item.id));
  }, [entries, items]);
  const agenda = entries.filter(entry => entry.date === selectedDay || (includeEarlier && entry.kind === 'by' && entry.date < selectedDay));
  const jumpToDay = (day: string) => {
    if (!taskCalendarDay(day)) return;
    setSelectedDay(day);
    const [year, monthNumber] = day.split('-').map(Number);
    setMonth(new Date(year, monthNumber - 1, 1));
  };
  const selectMonth = (offset: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + offset, 1);
    setMonth(next);
    setSelectedDay(localCalendarDay(next));
  };
  const entryButton = (entry: TaskCalendarEntry, compact = false) => (
    <button key={entry.key} type="button"
      className={`task-calendar-entry task-calendar-entry-${entry.kind}${selectedItemId === entry.item.id ? ' is-selected' : ''}`}
      title={`${entry.kind.toUpperCase()} ${entry.date}: ${getRecordDisplayTitle(entry.item)}`}
      onClick={() => onItemSelect?.(entry.item.id)}>
      <strong>{entry.kind.toUpperCase()}</strong>{' '}
      {!compact && <span>{entry.date}{entry.date < today && entry.kind === 'by' ? ' · Overdue' : ''} · </span>}
      {getRecordDisplayTitle(entry.item) || 'Untitled task'}
    </button>
  );

  return (
    <section className="task-calendar-view flex h-full min-h-0 flex-col bg-nim text-nim" aria-label="Task calendar">
      <div className="task-calendar-toolbar flex flex-wrap items-center gap-2 border-b border-nim px-3 py-2">
        <button type="button" className="task-calendar-control" aria-label="Previous month" onClick={() => selectMonth(-1)}>‹</button>
        <h2 className="text-sm font-semibold" aria-live="polite">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
        <button type="button" className="task-calendar-control" aria-label="Next month" onClick={() => selectMonth(1)}>›</button>
        <button type="button" className="task-calendar-control" onClick={() => jumpToDay(localCalendarDay(new Date()))}>Today</button>
        <label className="flex items-center gap-2 text-xs">Go to date <input aria-label="Go to date" type="date" value={selectedDay} onChange={event => jumpToDay(event.target.value)} className="rounded border border-nim bg-nim px-1 py-0.5" /></label>
        <span className="task-calendar-legend-on text-xs">ON · scheduled day</span>
        <span className="task-calendar-legend-by text-xs">BY · deadline</span>
      </div>
      <p className="select-text border-b border-nim px-3 py-2 text-xs text-nim-muted">Open a task to set its Scheduled Date (ON) and Due Date (BY). A task can have both.</p>
      <div className="task-calendar-content min-h-0 flex-1 overflow-auto">
        <div className="task-calendar-month">
          <div className="task-calendar-weekdays" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span key={index}>{new Date(2026, 10, 1 + index).toLocaleDateString(undefined, { weekday: 'short' })}</span>)}</div>
          <div className="task-calendar-days">
            {calendarMonthDays(month).map(date => {
              const day = localCalendarDay(date);
              const dayEntries = byDay.get(day) ?? [];
              return <div key={day} className={`task-calendar-day${date.getMonth() !== month.getMonth() ? ' is-outside' : ''}${selectedDay === day ? ' is-selected' : ''}`}>
                <button type="button" className="task-calendar-date" aria-label={day} aria-pressed={selectedDay === day} aria-current={today === day ? 'date' : undefined} onClick={() => jumpToDay(day)}>{date.getDate()}</button>
                {dayEntries.slice(0, 3).map(entry => entryButton(entry, true))}
                {dayEntries.length > 3 && <button type="button" className="task-calendar-more text-xs text-nim-muted" onClick={() => jumpToDay(day)}>+{dayEntries.length - 3} more</button>}
              </div>;
            })}
          </div>
        </div>
        <div className="task-calendar-agenda border-t border-nim p-3">
          <h3 className="select-text text-sm font-semibold">Tasks for {selectedDay}</h3>
          <label className="my-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={includeEarlier} onChange={event => setIncludeEarlier(event.target.checked)} />Include deadlines due before this day</label>
          <div className="task-calendar-agenda-items">{agenda.length ? agenda.map(entry => entryButton(entry)) : <p className="select-text text-xs text-nim-muted">No dated tasks for this day in the current view.</p>}</div>
          {undated.length > 0 && <div className="mt-3">
            <button type="button" className="task-calendar-control text-xs" aria-expanded={showUndated} onClick={() => setShowUndated(value => !value)}>{undated.length} task{undated.length === 1 ? '' : 's'} with no date</button>
            {showUndated && undated.map(item => <button type="button" key={item.id} className="task-calendar-undated block w-full px-2 py-1 text-left text-xs hover:bg-nim-hover" onClick={() => onItemSelect?.(item.id)}>{getRecordDisplayTitle(item) || 'Untitled task'}</button>)}
          </div>}
        </div>
      </div>
    </section>
  );
}
