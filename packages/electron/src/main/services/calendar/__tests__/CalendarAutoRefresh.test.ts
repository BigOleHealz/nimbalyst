// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../NetworkAvailability', () => ({ onNetworkAvailable: vi.fn() }));
import { CalendarAutoRefresh } from '../CalendarAutoRefresh';

afterEach(() => { vi.useRealTimers(); });

it('refreshes at startup, every five minutes, and on the existing wake/network signal; stops cleanly', async () => {
  vi.useFakeTimers();
  let wake!: () => void;
  const unsubscribe = vi.fn();
  const snapshot = { clients: {}, connections: [] };
  const refresh = vi.fn(async () => snapshot);
  const changed = vi.fn();
  const scheduler = new CalendarAutoRefresh(refresh, changed, vi.fn(), callback => { wake = callback; return unsubscribe; });
  scheduler.start();
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenLastCalledWith(snapshot);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(3);
  scheduler.stop();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('coalesces concurrent triggers and retries after a failed cycle without clearing the agenda', async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const refresh = vi.fn<() => Promise<any>>().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
  const failure = vi.fn();
  const changed = vi.fn();
  const scheduler = new CalendarAutoRefresh(refresh, changed, failure, () => () => {});
  scheduler.start();
  await scheduler.refresh();
  expect(refresh).toHaveBeenCalledTimes(1);
  reject(new Error('Vault locked'));
  await vi.advanceTimersByTimeAsync(0);
  expect(failure).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  scheduler.stop();
});

it('does not broadcast a completion after shutdown', async () => {
  let finish!: (snapshot: any) => void;
  const refresh = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const changed = vi.fn();
  const scheduler = new CalendarAutoRefresh(refresh, changed, vi.fn(), () => () => {});
  scheduler.start();
  scheduler.stop();
  finish({ connections: [], clients: {} });
  await Promise.resolve();
  expect(changed).not.toHaveBeenCalled();
});
