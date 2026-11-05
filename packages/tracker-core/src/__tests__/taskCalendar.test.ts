// @vitest-environment node
process.env.TZ = 'America/New_York';
import { expect, it } from 'vitest';
import { calendarMonthDays, isActiveCalendarTask, localCalendarDay, taskCalendarDay, taskCalendarEntries } from '../taskCalendar';
import type { TrackerRecord } from '../trackerRecord.js';
const task = (fields: Record<string, unknown>): TrackerRecord => ({ id: 'a', primaryType: 'task', typeTags: ['task'], fields, archived: false, source: 'native', syncStatus: 'local', system: { workspace: '/project', createdAt: '', updatedAt: '' } });
it('validates dates without normalizing impossible days or shifting date-only values', () => {
  expect(taskCalendarDay('2026-02-29')).toBeNull();
  expect(taskCalendarDay('2028-02-29')).toBe('2028-02-29');
  expect(taskCalendarDay('2026-11-05T00:00:00.000Z')).toBe('2026-11-05');
  expect(taskCalendarDay('2026-13-01')).toBeNull();
  expect(taskCalendarDay(new Date('invalid'))).toBeNull();
  expect(taskCalendarDay('')).toBeNull();
  expect(localCalendarDay(new Date(2026, 10, 5, 23, 59))).toBe('2026-11-05');
  expect(localCalendarDay(new Date('2026-11-06T04:59:00Z'))).toBe('2026-11-05');
});
it('keeps scheduled days and deadlines distinct, including both dates on one task', () => {
  expect(taskCalendarEntries([task({ scheduledDate: '2026-11-05', dueDate: '2026-11-06' })]).map(({ kind, date }) => ({ kind, date }))).toEqual([{ kind: 'on', date: '2026-11-05' }, { kind: 'by', date: '2026-11-06' }]);
  expect(taskCalendarEntries([task({ dueDate: '2026-11-05' })])[0].kind).toBe('by');
  expect(taskCalendarEntries([{ ...task({ dueDate: '2026-11-05' }), primaryType: 'bug', typeTags: ['bug'] }])).toEqual([]);
});
it('uses declared workflow categories for custom finished states and keeps approved tasks active', () => {
  const context = { getTypeModel: () => ({ type: 'task', roles: { workflowStatus: 'state' }, fields: [{ name: 'state', type: 'select', options: [{ value: 'delivered', category: 'done' as const }] }] }) };
  expect(isActiveCalendarTask(task({ state: 'delivered' }), context)).toBe(false);
  expect(isActiveCalendarTask(task({ status: 'approved' }))).toBe(true);
  expect(isActiveCalendarTask({ ...task({}), archived: true })).toBe(false);
});
it('fills complete Sunday-to-Saturday weeks across year, leap-day and month boundaries', () => {
  const february = calendarMonthDays(new Date(2028, 1, 1));
  expect(february[0].getDay()).toBe(0);
  expect(february.at(-1)!.getDay()).toBe(6);
  expect(february.map(localCalendarDay)).toContain('2028-02-29');
  expect(calendarMonthDays(new Date(2026, 11, 1)).map(localCalendarDay)).toContain('2027-01-02');
});
