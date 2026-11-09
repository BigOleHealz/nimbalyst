// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ directory: '', available: true }));
vi.mock('electron', () => ({ app: { getPath: () => h.directory, isReady: () => true }, safeStorage: {
  encryptString: (text: string) => Buffer.from('encrypted:' + Buffer.from(text).toString('base64')),
  decryptString: (bytes: Buffer) => { if (!bytes.toString().startsWith('encrypted:')) throw new Error('unreadable'); return Buffer.from(bytes.toString().slice(10), 'base64').toString(); },
} }));
vi.mock('../../credentials/providerCredentials', () => ({ isProviderEncryptionAvailable: () => h.available }));
import { CalendarStore, type CalendarData } from '../CalendarStore';

afterEach(() => { if (h.directory) rmSync(h.directory, { recursive: true, force: true }); h.available = true; });

it('writes encrypted snapshots and refuses to overwrite an unreadable account store', () => {
  h.directory = mkdtempSync(join(tmpdir(), 'calendar-store-'));
  const store = new CalendarStore();
  const data = { version: 1 as const, clients: { google: { clientId: 'client', clientSecret: 'private-secret' } }, accounts: [] };
  store.write(data);
  const file = join(h.directory, 'calendar-imports/accounts.bin');
  expect(readFileSync(file, 'utf8')).not.toContain('private-secret');
  expect(store.read()).toEqual(data);
  writeFileSync(file, 'corrupted original');
  expect(() => store.read()).toThrow('could not be read');
  expect(readFileSync(file, 'utf8')).toBe('corrupted original');
});

it('fails closed when secure storage is unavailable', () => {
  h.directory = mkdtempSync(join(tmpdir(), 'calendar-store-'));
  h.available = false;
  expect(() => new CalendarStore().read()).toThrow('secure storage');
  expect(() => new CalendarStore().write({ version: 1, clients: {}, accounts: [] })).toThrow('secure storage');
});

it('preserves automatic refresh preferences and failure status across encrypted reloads', () => {
  h.directory = mkdtempSync(join(tmpdir(), 'calendar-store-'));
  const data: CalendarData = { version: 1, clients: {}, accounts: [{
    id: 'account', provider: 'google', label: 'me@example.test', clientId: 'client', accessToken: 'access', refreshToken: 'refresh', expiresAt: 1,
    calendars: [], selectedCalendarIds: [], events: [], autoRefresh: false, syncError: 'Reconnect this account.',
    meetingNotes: [{ calendarId: 'work', eventId: 'meeting', id: 'note-1', text: 'Private preparation', createdAt: '2026-11-07T12:00:00Z' }],
  }] };
  new CalendarStore().write(data);
  expect(new CalendarStore().read()).toEqual(data);
});
