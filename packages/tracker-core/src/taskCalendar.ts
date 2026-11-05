import type { TrackerRecord } from './trackerRecord.js';
import type { TrackerCoreContext } from './context.js';
import { statusCategoryOfItem, TERMINAL_CATEGORIES } from './trackerStatusCategory.js';

export type TaskDateKind = 'on' | 'by';
export interface TaskCalendarEntry {
  key: string;
  item: TrackerRecord;
  kind: TaskDateKind;
  date: string;
}

/** Calendar days stay local; parsing YYYY-MM-DD with Date would shift them in western timezones. */
export function localCalendarDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function taskCalendarDay(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : localCalendarDay(value);
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.\d+)?Z)?$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  return localCalendarDay(date) === day ? day : null;
}

export function isActiveCalendarTask(item: TrackerRecord, context: TrackerCoreContext = { getTypeModel: () => undefined }): boolean {
  return (item.primaryType === 'task' || item.typeTags.includes('task'))
    && !item.archived && !TERMINAL_CATEGORIES.has(statusCategoryOfItem(context, item.primaryType, name => item.fields[name]));
}

/** A task may have both a scheduled work day and a separate deadline. */
export function taskCalendarEntries(items: readonly TrackerRecord[]): TaskCalendarEntry[] {
  return items.flatMap(item => {
    if (item.primaryType !== 'task' && !item.typeTags.includes('task')) return [];
    const entries: TaskCalendarEntry[] = [];
    for (const [field, kind] of [['scheduledDate', 'on'], ['dueDate', 'by']] as const) {
      const date = taskCalendarDay(item.fields[field]);
      if (date) entries.push({ key: JSON.stringify([item.id, kind, date]), item, kind, date });
    }
    return entries;
  }).sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === 'on' ? -1 : 1) || String(a.item.fields.title).localeCompare(String(b.item.fields.title)));
}

export function calendarMonthDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
  const weeks = Math.ceil((first.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
  return Array.from({ length: weeks * 7 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
}
