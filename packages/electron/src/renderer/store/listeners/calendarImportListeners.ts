import { store } from '@nimbalyst/runtime/store';
import type { CalendarImportsSnapshot } from '../../../shared/calendarImports';
import { calendarImportsAtom } from '../atoms/calendarImports';
import type { createStore } from 'jotai';

export function initCalendarImportListeners(target: ReturnType<typeof createStore> = store): () => void {
  if (!window.electronAPI) return () => {};
  return window.electronAPI.on('calendar-imports:changed', (snapshot: CalendarImportsSnapshot) => {
    target.set(calendarImportsAtom, snapshot);
  });
}
