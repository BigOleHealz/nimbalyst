import { atom } from 'jotai';
import type { CalendarImportsSnapshot } from '../../../shared/calendarImports';

export const calendarImportsAtom = atom<CalendarImportsSnapshot>({ connections: [], clients: {} });
