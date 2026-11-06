import { atom } from 'jotai';
import type { CalendarImportsSnapshot } from '../../../shared/calendarImports';

export const calendarImportsAtom = atom<CalendarImportsSnapshot>({ connections: [], clients: {} });

/** Both calendar surfaces share hydration; a late read must not replace a newer background update. */
export const loadCalendarImportsAtom = atom(null, async (get, set) => {
  const before = get(calendarImportsAtom);
  const snapshot: CalendarImportsSnapshot = await window.electronAPI.invoke('calendar-imports:get');
  if (get(calendarImportsAtom) === before) set(calendarImportsAtom, snapshot);
});
