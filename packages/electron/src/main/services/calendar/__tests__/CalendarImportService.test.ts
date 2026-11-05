// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: {}, safeStorage: {}, shell: {} }));
import { CalendarImportService, validateCalendarRange } from '../CalendarImportService';
import { CalendarApiError } from '../CalendarClient';
import type { CalendarData } from '../CalendarStore';

const range = { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' };
const event = { id: 'meeting', calendarId: 'work', title: 'Meeting', start: '2026-11-03T14:00:00Z', end: '2026-11-03T15:00:00Z', allDay: false };
let data: CalendarData;
let client: any;
let oauth: any;
let service: CalendarImportService;
beforeEach(() => {
  data = { version: 1, clients: {}, accounts: [{ id: 'account', provider: 'google', label: 'me@example.com', clientId: 'test.apps.googleusercontent.com', clientSecret: 'client-secret', accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000, calendars: [{ id: 'work', name: 'Work', primary: true }], selectedCalendarIds: ['work'], events: [event] }] };
  client = { calendars: vi.fn(async () => data.accounts[0].calendars), events: vi.fn(async () => [event]), profile: vi.fn(async () => ({ id: 'person', label: 'me@example.com' })) };
  oauth = { refresh: vi.fn(async () => ({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresAt: Date.now() + 3600_000 })), authorize: vi.fn(async () => ({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600_000 })), cancel: vi.fn() };
  service = new CalendarImportService({ read: () => structuredClone(data), write: next => { data = structuredClone(next); } }, client, oauth);
});

it('returns event snapshots and client presence without returning credentials', () => {
  data.clients.google = { clientId: 'test.apps.googleusercontent.com', clientSecret: 'secret' };
  const snapshot = service.snapshot();
  expect(snapshot.connections[0].events).toEqual([event]);
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['accessToken', 'refreshToken', 'client-secret', '"clientSecret"']) expect(serialized).not.toContain(secret);
  expect(snapshot.clients.google).toEqual({ clientId: 'test.apps.googleusercontent.com', hasClientSecret: true });
});

it('replaces a successful snapshot so repeat imports do not duplicate events and cancellations disappear', async () => {
  await service.importEvents('account', ['work', 'work'], range);
  expect(data.accounts[0].events).toHaveLength(1);
  expect(client.events).toHaveBeenCalledTimes(1);
  client.events.mockResolvedValue([]);
  await service.importEvents('account', ['work'], range);
  expect(data.accounts[0].events).toEqual([]);
  expect(data.accounts[0].importedAt).toEqual(expect.any(String));
});

it('preserves the old agenda if any selected calendar fails after another succeeds', async () => {
  data.accounts[0].calendars.push({ id: 'other', name: 'Other', primary: false });
  client.events.mockResolvedValueOnce([{ ...event, id: 'new' }]).mockRejectedValueOnce(new Error('Access denied'));
  await expect(service.importEvents('account', ['work', 'other'], range)).rejects.toThrow('Access denied');
  expect(data.accounts[0].events).toEqual([event]);
});

it('persists rotated refresh tokens even when a later import fails', async () => {
  data.accounts[0].expiresAt = 0;
  client.events.mockRejectedValue(new Error('Offline'));
  await expect(service.importEvents('account', ['work'], range)).rejects.toThrow('Offline');
  expect(data.accounts[0].refreshToken).toBe('rotated-refresh');
  expect(data.accounts[0].events).toEqual([event]);
});

it('refreshes once after a 401 and rejects concurrent writes', async () => {
  client.calendars.mockRejectedValueOnce(new CalendarApiError(401)).mockResolvedValueOnce(data.accounts[0].calendars);
  let finish!: (events: typeof event[]) => void;
  client.events.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const importing = service.importEvents('account', ['work'], range);
  await vi.waitFor(() => expect(client.events).toHaveBeenCalled());
  await expect(service.disconnect('account')).rejects.toThrow('already running');
  finish([event]);
  await importing;
  expect(oauth.refresh).toHaveBeenCalledTimes(1);
});

it('keeps multiple providers together and removes only the disconnected account', async () => {
  data.accounts.push({ ...data.accounts[0], id: 'microsoft-account', provider: 'microsoft' });
  const snapshot = await service.disconnect('account');
  expect(snapshot.connections.map(account => account.id)).toEqual(['microsoft-account']);
});

it('validates ranges and unavailable calendars before replacing saved events', async () => {
  expect(() => validateCalendarRange({ start: range.end, end: range.start })).toThrow('valid date range');
  expect(() => validateCalendarRange({ start: range.start, end: '2030-01-01' })).toThrow('at most one year');
  await expect(service.importEvents('account', ['missing'], range)).rejects.toThrow('no longer available');
  expect(data.accounts[0].events).toEqual([event]);
});

it('reconnecting the same account preserves its agenda and avoids a duplicate connection', async () => {
  const input = { provider: 'google' as const, clientId: 'test.apps.googleusercontent.com', clientSecret: 'secret' };
  const first = await service.connect(input);
  const firstId = first.connections.find(account => account.id !== 'account')!.id;
  await service.importEvents(firstId, ['work'], range);
  const second = await service.connect(input);
  expect(second.connections).toHaveLength(2);
  expect(second.connections.find(account => account.id === firstId)!.events).toEqual([event]);
});

it('canceling while account metadata loads prevents a late connection from being saved', async () => {
  let finish!: (profile: { id: string; label: string }) => void;
  client.profile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = service.connect({ provider: 'google', clientId: 'test.apps.googleusercontent.com', clientSecret: 'secret' });
  await vi.waitFor(() => expect(client.profile).toHaveBeenCalled());
  await service.cancelConnect();
  finish({ id: 'late-account', label: 'late@example.com' });
  await expect(pending).rejects.toThrow('canceled');
  expect(data.accounts).toHaveLength(1);
});

it('automatically refreshes existing Google and Microsoft selections with a rolling local-day range', async () => {
  data.accounts.push({ ...data.accounts[0], id: 'microsoft-account', provider: 'microsoft' });
  await service.refreshAutomatically(new Date(2026, 10, 5, 14));
  const rolling = { start: new Date(2026, 9, 29).toISOString(), end: new Date(2027, 1, 4).toISOString() };
  expect(client.events).toHaveBeenCalledTimes(2);
  expect(data.accounts.map(account => account.range)).toEqual([rolling, rolling]);
  await service.refreshAutomatically(new Date(2026, 10, 6, 14));
  expect(data.accounts[0].range?.start).toBe(new Date(2026, 9, 30).toISOString());
});

it('skips paused and unselected accounts and persists the automatic refresh preference', async () => {
  await service.setAutoRefresh('account', false);
  await service.refreshAutomatically();
  expect(client.events).not.toHaveBeenCalled();
  expect(service.snapshot().connections[0].autoRefresh).toBe(false);
  await service.setAutoRefresh('account', true);
  data.accounts[0].selectedCalendarIds = [];
  await service.refreshAutomatically();
  expect(client.events).not.toHaveBeenCalled();
  await expect(service.setAutoRefresh('account', 'yes' as any)).rejects.toThrow('boolean');
});

it('keeps a failed account snapshot, reports a safe error, and continues refreshing other accounts', async () => {
  data.accounts.push({ ...data.accounts[0], id: 'other-account' });
  client.events.mockRejectedValueOnce(new Error('provider failure with secret detail')).mockResolvedValueOnce([]);
  await service.refreshAutomatically();
  expect(data.accounts[0].events).toEqual([event]);
  expect(service.snapshot().connections[0].syncError).toContain('Automatic refresh failed');
  expect(JSON.stringify(service.snapshot())).not.toContain('secret detail');
  expect(data.accounts[1].events).toEqual([]);
  await service.refreshAutomatically();
  expect(service.snapshot().connections[0].syncError).toBeUndefined();
});

it('does not start a background refresh while a manual import owns the service', async () => {
  let finish!: (events: typeof event[]) => void;
  client.events.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const manual = service.importEvents('account', ['work'], range);
  await vi.waitFor(() => expect(client.events).toHaveBeenCalledTimes(1));
  expect(await service.refreshAutomatically()).toBeUndefined();
  expect(client.events).toHaveBeenCalledTimes(1);
  finish([event]);
  await manual;
});

it('uses the rolling range for a manual refresh without an explicit custom range', async () => {
  await service.importEvents('account', ['work']);
  expect(data.accounts[0].range).toBeDefined();
  expect(client.events).toHaveBeenCalledWith('google', 'access', 'work', data.accounts[0].range);
});
