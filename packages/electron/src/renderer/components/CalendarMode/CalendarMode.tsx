import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { calendarMonthDays } from '@nimbalyst/tracker-core';
import { calendarImportsAtom, loadCalendarImportsAtom } from '../../store/atoms/calendarImports';
import { localCalendarDate } from '../GlobalSettings/panels/calendarAgenda';
import { calendarEntries, calendarEventTime, calendarViewKey, entriesForDay, type CalendarViewEntry } from './calendarView';
import './CalendarMode.css';

interface CalendarModeProps {
  onManageAccounts: () => void;
}

export function CalendarMode({ onManageAccounts }: CalendarModeProps): React.JSX.Element {
  const snapshot = useAtomValue(calendarImportsAtom);
  const setSnapshot = useSetAtom(calendarImportsAtom);
  const load = useSetAtom(loadCalendarImportsAtom);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(() => localCalendarDate(new Date()));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hiddenCalendars, setHiddenCalendars] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let canceled = false;
    void load().catch(() => {
      if (!canceled) setError('Calendars could not be loaded. Open Manage accounts to check your connections.');
    }).finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [load]);

  const entries = useMemo(() => calendarEntries(snapshot.connections).filter(entry => !hiddenCalendars.has(calendarViewKey(entry.account.id, entry.event.calendarId))), [snapshot.connections, hiddenCalendars]);
  const monthDays = useMemo(() => calendarMonthDays(month), [month]);
  const eventsByDay = useMemo(() => new Map(monthDays.map(date => {
    const day = localCalendarDate(date);
    return [day, entriesForDay(entries, day)];
  })), [monthDays, entries]);
  const dayEntries = eventsByDay.get(selectedDay) ?? [];
  const selected = dayEntries.find(entry => entry.key === selectedKey);
  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const today = localCalendarDate(new Date());
  const chooseDay = (day: string) => {
    const date = new Date(`${day}T00:00:00`);
    setMonth(previous => previous.getFullYear() === date.getFullYear() && previous.getMonth() === date.getMonth() ? previous : new Date(date.getFullYear(), date.getMonth(), 1));
    setSelectedDay(day);
    setSelectedKey(null);
  };
  const changeMonth = (offset: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + offset, 1);
    setMonth(next);
    setSelectedDay(localCalendarDate(next));
    setSelectedKey(null);
  };
  const chooseEvent = (entry: CalendarViewEntry, day: string) => {
    chooseDay(day);
    setSelectedKey(entry.key);
  };
  const refresh = async () => {
    setRefreshing(true); setError('');
    const failures: string[] = [];
    try {
      for (const account of snapshot.connections.filter(account => account.selectedCalendarIds.length)) {
        try {
          setSnapshot(await window.electronAPI.invoke('calendar-imports:import', { accountId: account.id, calendarIds: account.selectedCalendarIds, range: account.autoRefresh === false ? account.range : undefined }));
        } catch { failures.push(account.label); }
      }
      if (failures.length) setError(`Could not refresh ${failures.join(', ')}. The last successful events remain visible. Check Manage accounts.`);
    } finally { setRefreshing(false); }
  };
  const openOriginal = async (entry: CalendarViewEntry) => {
    try { await window.electronAPI.invoke('calendar-imports:open-event', { accountId: entry.account.id, calendarId: entry.event.calendarId, eventId: entry.event.id }); }
    catch { setError('The original event could not be opened.'); }
  };
  const eventButton = (entry: CalendarViewEntry, day: string, compact: boolean) => <button key={entry.key} type="button"
    className={`calendar-mode-event${entry.event.allDay ? ' is-all-day' : ''}${entry.key === selectedKey ? ' is-selected' : ''}`}
    style={{ '--calendar-color': entry.account.provider === 'google' ? 'var(--nim-info)' : 'var(--nim-primary)' } as React.CSSProperties}
    aria-label={compact ? `${entry.event.title}, ${calendarEventTime(entry.event)}, ${entry.account.label}` : undefined}
    onClick={() => chooseEvent(entry, day)}>
    <span className="calendar-mode-event-time">{calendarEventTime(entry.event)}</span>
    <span className="calendar-mode-event-title">{entry.event.title}</span>
    {!compact && <span className="calendar-mode-event-source">{entry.account.label}</span>}
  </button>;

  return <section className="calendar-mode flex h-full min-h-0 flex-col bg-nim text-nim select-text" aria-label="Calendar">
    <header className="calendar-mode-header flex flex-wrap items-center gap-3 border-b border-nim px-4 py-3">
      <h1 className="text-lg font-semibold">Calendar</h1>
      <div className="calendar-mode-navigation flex items-center gap-2">
        <button type="button" className="calendar-mode-control" aria-label="Previous month" onClick={() => changeMonth(-1)}>‹</button>
        <h2 className="text-sm font-medium" aria-live="polite">{monthLabel}</h2>
        <button type="button" className="calendar-mode-control" aria-label="Next month" onClick={() => changeMonth(1)}>›</button>
        <button type="button" className="calendar-mode-control" onClick={() => chooseDay(localCalendarDate(new Date()))}>Today</button>
      </div>
      <div className="calendar-mode-actions ml-auto flex gap-2">
        <button type="button" className="calendar-mode-control" disabled={loading || refreshing || !snapshot.connections.some(account => account.selectedCalendarIds.length)} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh now'}</button>
        <button type="button" className="calendar-mode-control" onClick={onManageAccounts}>Manage accounts</button>
      </div>
    </header>
    <div className="calendar-mode-calendars border-b border-nim px-4 py-2">
      <div className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Visible calendars">
        {snapshot.connections.flatMap(account => account.calendars.filter(calendar => account.selectedCalendarIds.includes(calendar.id)).map(calendar => {
          const key = calendarViewKey(account.id, calendar.id);
          return <label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!hiddenCalendars.has(key)} aria-label={`Show ${calendar.name} — ${account.label}`} onChange={event => {
            const checked = event.target.checked;
            setHiddenCalendars(previous => { const next = new Set(previous); if (checked) next.delete(key); else next.add(key); return next; });
          }} /><span>{calendar.name}</span><span className="text-nim-muted">{account.label}</span></label>;
        }))}
      </div>
      <p className="mt-1 text-xs text-nim-muted">{Intl.DateTimeFormat().resolvedOptions().timeZone} · Read-only · Account selections and automatic refresh are managed in settings.</p>
      {snapshot.connections.map(account => account.syncError && <p key={account.id} className="mt-1 text-xs text-nim-error" role="alert">{account.label}: {account.syncError}</p>)}
    </div>
    {error && <p className="calendar-mode-error border-b border-nim px-4 py-2 text-sm text-nim-error" role="alert">{error}</p>}
    {loading && <p className="px-4 py-2 text-sm text-nim-muted" role="status">Loading calendar…</p>}
    {!loading && !snapshot.connections.length && <p className="px-4 py-3 text-sm text-nim-muted">Connect a calendar account to see your events.</p>}
    <div className="calendar-mode-layout min-h-0 flex-1">
      <section className="calendar-mode-month min-h-0 overflow-auto" aria-label={monthLabel}>
        <div className="calendar-mode-weekdays" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span key={index}>{new Date(2026, 10, 1 + index).toLocaleDateString(undefined, { weekday: 'short' })}</span>)}</div>
        <div className="calendar-mode-days">
          {monthDays.map(date => {
            const day = localCalendarDate(date);
            const events = eventsByDay.get(day) ?? [];
            return <div key={day} className={`calendar-mode-day${date.getMonth() !== month.getMonth() ? ' is-outside' : ''}${day === selectedDay ? ' is-selected' : ''}`}>
              <button type="button" className="calendar-mode-date" aria-label={day} aria-current={today === day ? 'date' : undefined} aria-pressed={day === selectedDay} onClick={() => chooseDay(day)}>{date.getDate()}</button>
              {events.slice(0, 3).map(entry => eventButton(entry, day, true))}
              {events.length > 3 && <button className="calendar-mode-more" type="button" onClick={() => chooseDay(day)}>+{events.length - 3} more</button>}
            </div>;
          })}
        </div>
      </section>
      <aside className="calendar-mode-agenda min-h-0 overflow-auto p-4" aria-label="Day agenda">
        <h3 className="mb-3 text-sm font-semibold">{new Date(`${selectedDay}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h3>
        {dayEntries.length ? dayEntries.map(entry => eventButton(entry, selectedDay, false)) : <p className="text-sm text-nim-muted">No imported events for this day.</p>}
        {selected && <section className="calendar-mode-event-details mt-4 space-y-3 border-t border-nim pt-4" aria-label="Event details">
          <h4 className="font-semibold">{selected.event.title}</h4>
          <p className="text-sm text-nim-muted">{selected.account.label} · {selected.account.calendars.find(calendar => calendar.id === selected.event.calendarId)?.name ?? 'Calendar'}</p>
          <p className="text-sm">{selected.event.allDay ? 'All day' : `${new Date(selected.event.start).toLocaleString()} – ${new Date(selected.event.end).toLocaleString()}`}</p>
          {selected.event.location && <p className="text-sm">{selected.event.location}</p>}
          {selected.event.description && <p className="whitespace-pre-wrap break-words text-sm">{selected.event.description}</p>}
          {selected.event.url && <button type="button" className="calendar-mode-control" onClick={() => void openOriginal(selected)}>Open original event</button>}
        </section>}
      </aside>
    </div>
  </section>;
}
