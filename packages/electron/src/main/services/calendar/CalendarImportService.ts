import { createHash } from 'node:crypto';
import { CalendarApiError, CalendarClient } from './CalendarClient';
import { CalendarOAuth, validateCalendarClient } from './CalendarOAuth';
import { CalendarStore, type CalendarAccount, type CalendarStorage } from './CalendarStore';
import type { CalendarConnectOptions, CalendarImportRange, CalendarImportsSnapshot } from '../../../shared/calendarImports';
import { calendarAutoRefreshRange } from '../../../shared/calendarImports';

export function validateCalendarRange(input: CalendarImportRange): CalendarImportRange {
  const start = typeof input?.start === 'string' ? Date.parse(input.start) : NaN;
  const end = typeof input?.end === 'string' ? Date.parse(input.end) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 366 * 86400_000) {
    throw new Error('Choose a valid date range of at most one year, with the end after the start.');
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** All writes are serialized, including refresh-token rotation and disconnects. */
export class CalendarImportService {
  private busy = false;
  private connectionRevision = 0;
  constructor(
    private readonly storage: CalendarStorage = new CalendarStore(),
    private readonly client = new CalendarClient(),
    private readonly oauth = new CalendarOAuth(),
  ) {}

  snapshot(): CalendarImportsSnapshot {
    const data = this.storage.read();
    return {
      connections: data.accounts.map(({ id, provider, label, calendars, selectedCalendarIds, events, importedAt, range, autoRefresh, syncError }) => ({
        id, provider, label, calendars, selectedCalendarIds, events, importedAt, range, autoRefresh: autoRefresh ?? true, syncError,
      })),
      clients: Object.fromEntries(Object.entries(data.clients).map(([provider, client]) => [provider, { clientId: client.clientId, hasClientSecret: Boolean(client.clientSecret) }])),
    };
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('A calendar operation is already running. Finish or cancel it first.');
    this.busy = true;
    try { return await operation(); }
    finally { this.busy = false; }
  }

  cancelConnect(): Promise<void> {
    this.connectionRevision++;
    return this.oauth.cancel();
  }

  async connect(input: CalendarConnectOptions): Promise<CalendarImportsSnapshot> {
    return this.exclusive(async () => {
      const data = this.storage.read();
      const revision = this.connectionRevision;
      const config = validateCalendarClient(input);
      const savedClient = data.clients[config.provider];
      if (config.provider === 'google' && !config.clientSecret && savedClient?.clientId === config.clientId) config.clientSecret = savedClient.clientSecret;
      if (config.provider === 'google' && !config.clientSecret) throw new Error('Enter the client secret from your Google Desktop app registration.');
      const tokens = await this.oauth.authorize(config);
      const profile = await this.client.profile(config.provider, tokens.accessToken);
      const calendars = await this.client.calendars(config.provider, tokens.accessToken);
      if (revision !== this.connectionRevision) throw new Error('Calendar sign-in was canceled.');
      const id = createHash('sha256').update(`${config.provider}\n${profile.id}`).digest('hex');
      const existing = data.accounts.find(account => account.id === id);
      const account: CalendarAccount = {
        ...config, ...tokens, id, label: profile.label, calendars,
        selectedCalendarIds: existing?.selectedCalendarIds.filter(key => calendars.some(calendar => calendar.id === key)) ?? calendars.filter(calendar => calendar.primary).map(calendar => calendar.id),
        events: existing?.events ?? [], importedAt: existing?.importedAt, range: existing?.range,
        autoRefresh: existing?.autoRefresh ?? true,
      };
      data.accounts = [...data.accounts.filter(item => item.id !== id), account];
      data.clients[config.provider] = { clientId: config.clientId, clientSecret: config.clientSecret };
      this.storage.write(data);
      return this.snapshot();
    });
  }

  private account(id: string): CalendarAccount {
    const account = this.storage.read().accounts.find(item => item.id === id);
    if (!account) throw new Error('Calendar account not found. Reconnect the account.');
    return account;
  }

  private saveAccount(account: CalendarAccount): void {
    const data = this.storage.read();
    const index = data.accounts.findIndex(item => item.id === account.id);
    if (index < 0) throw new Error('This calendar account was disconnected. Reconnect it before importing.');
    data.accounts[index] = account;
    this.storage.write(data);
  }

  private async authenticated<T>(account: CalendarAccount, operation: (token: string) => Promise<T>): Promise<T> {
    const refresh = async () => {
      Object.assign(account, await this.oauth.refresh(account, account.refreshToken));
      // Persist rotated refresh tokens even if a later calendar request fails.
      this.saveAccount(account);
    };
    if (account.expiresAt <= Date.now() + 60_000) await refresh();
    try { return await operation(account.accessToken); }
    catch (error) {
      if (!(error instanceof CalendarApiError) || error.status !== 401) throw error;
      await refresh();
      return operation(account.accessToken);
    }
  }

  async listCalendars(id: string): Promise<CalendarImportsSnapshot> {
    return this.exclusive(async () => {
      const account = this.account(id);
      const calendars = await this.authenticated(account, token => this.client.calendars(account.provider, token));
      account.calendars = calendars;
      this.saveAccount(account);
      return this.snapshot();
    });
  }

  async importEvents(id: string, selectedIds: string[], inputRange?: CalendarImportRange): Promise<CalendarImportsSnapshot> {
    const range = inputRange === undefined ? calendarAutoRefreshRange() : validateCalendarRange(inputRange);
    if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 50 || selectedIds.some(value => typeof value !== 'string' || !value)) {
      throw new Error('Choose between one and 50 calendars to import.');
    }
    const calendarIds = [...new Set(selectedIds)];
    return this.exclusive(async () => {
      const account = this.account(id);
      await this.importAccount(account, calendarIds, range);
      return this.snapshot();
    });
  }

  private async importAccount(account: CalendarAccount, calendarIds: string[], range: CalendarImportRange): Promise<void> {
    const calendars = await this.authenticated(account, token => this.client.calendars(account.provider, token));
    if (calendarIds.some(key => !calendars.some(calendar => calendar.id === key))) throw new Error('A selected calendar is no longer available. Reload calendars and choose again.');
    const events: CalendarAccount['events'] = [];
    for (const calendarId of calendarIds) {
      events.push(...await this.authenticated(account, token => this.client.events(account.provider, token, calendarId, range)));
      if (events.length > 20_000) throw new Error('Choose fewer calendars or a shorter date range.');
    }
    // Commit only a complete snapshot; cancellation and moved events disappear together.
    this.saveAccount({ ...account, calendars, events, selectedCalendarIds: calendarIds, range, importedAt: new Date().toISOString(), syncError: undefined });
  }

  async setAutoRefresh(id: string, enabled: boolean): Promise<CalendarImportsSnapshot> {
    if (typeof enabled !== 'boolean') throw new Error('Automatic refresh requires a boolean value.');
    return this.exclusive(async () => {
      this.saveAccount({ ...this.account(id), autoRefresh: enabled, syncError: undefined });
      return this.snapshot();
    });
  }

  /** Skip occupied cycles rather than racing manual imports or token rotation. */
  async refreshAutomatically(now = new Date()): Promise<CalendarImportsSnapshot | undefined> {
    if (this.busy) return undefined;
    return this.exclusive(async () => {
      const range = calendarAutoRefreshRange(now);
      const accounts = this.storage.read().accounts.filter(account => account.autoRefresh !== false && account.selectedCalendarIds.length);
      for (const account of accounts) {
        try {
          await this.importAccount(account, account.selectedCalendarIds, range);
        } catch {
          // Keep the last successful events and any refresh-token rotation. Never broadcast provider response details.
          this.saveAccount({ ...this.account(account.id), syncError: 'Automatic refresh failed. Check your connection or reconnect this account. Your last successful agenda is unchanged.' });
        }
      }
      return this.snapshot();
    });
  }

  async disconnect(id: string): Promise<CalendarImportsSnapshot> {
    return this.exclusive(async () => {
      const data = this.storage.read();
      const account = this.account(id);
      data.accounts = data.accounts.filter(item => item.id !== id);
      if (!data.accounts.some(item => item.provider === account.provider)) delete data.clients[account.provider];
      this.storage.write(data);
      return this.snapshot();
    });
  }
}
