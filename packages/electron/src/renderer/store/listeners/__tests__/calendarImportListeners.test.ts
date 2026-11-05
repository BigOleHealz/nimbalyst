import { createStore } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import { calendarImportsAtom } from '../../atoms/calendarImports';
import { initCalendarImportListeners } from '../calendarImportListeners';

afterEach(() => { vi.unstubAllGlobals(); });

it('delivers background changes to the agenda store and removes the subscription on cleanup', () => {
  let receive!: (snapshot: any) => void;
  const unsubscribe = vi.fn();
  vi.stubGlobal('window', { electronAPI: { on: vi.fn((channel, callback) => {
    expect(channel).toBe('calendar-imports:changed'); receive = callback; return unsubscribe;
  }) } });
  const target = createStore();
  const cleanup = initCalendarImportListeners(target);
  const snapshot = { clients: {}, connections: [] };
  receive(snapshot);
  expect(target.get(calendarImportsAtom)).toBe(snapshot);
  cleanup();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
