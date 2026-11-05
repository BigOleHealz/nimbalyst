import { createHash, randomBytes } from 'node:crypto';
import { shell } from 'electron';
import { startAuthCallbackLoopback } from '../auth/AuthCallbackLoopback';
import type { CalendarConnectOptions, CalendarProvider } from '../../../shared/calendarImports';

export interface CalendarTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export const CALENDAR_OAUTH = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email https://www.googleapis.com/auth/calendar.readonly',
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access User.Read Calendars.Read',
  },
} as const;

export function validateCalendarClient(input: CalendarConnectOptions): CalendarConnectOptions {
  if (!input || !Object.hasOwn(CALENDAR_OAUTH, input.provider)) throw new Error('Choose a supported calendar provider.');
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
  if (!clientId || clientId.length > 300 || /[\s\x00-\x1f]/.test(clientId)) throw new Error('Enter the OAuth application client ID.');
  if (input.provider === 'google' && !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Use a Google Desktop app client ID.');
  if (input.provider === 'microsoft' && !/^[a-f0-9-]{36}$/i.test(clientId)) throw new Error('Use the Microsoft application client ID.');
  const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : undefined;
  return { provider: input.provider, clientId, ...(input.provider === 'google' && clientSecret ? { clientSecret } : {}) };
}

export class CalendarOAuth {
  private cancelPending?: () => Promise<void>;

  constructor(private readonly request: typeof fetch = fetch, private readonly openBrowser = (url: string) => shell.openExternal(url)) {}

  async cancel(): Promise<void> {
    await this.cancelPending?.();
  }

  private async tokens(provider: CalendarProvider, body: URLSearchParams, previousRefresh?: string): Promise<CalendarTokens> {
    let response: Response;
    try {
      response = await this.request(CALENDAR_OAUTH[provider].token, {
        method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch { throw new Error('Calendar sign-in could not reach the provider. Check your connection and retry.'); }
    if (!response.ok) throw new Error('Calendar sign-in was rejected or expired. Check the application setup and reconnect.');
    let data: any;
    try { data = await response.json(); } catch { throw new Error('The provider returned an unreadable sign-in response.'); }
    const refreshToken = data.refresh_token || previousRefresh;
    if (typeof data.access_token !== 'string' || !data.access_token || typeof refreshToken !== 'string' || !refreshToken || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new Error('The provider did not grant a renewable calendar connection. Reconnect and approve calendar read access.');
    }
    return { accessToken: data.access_token, refreshToken, expiresAt: Date.now() + data.expires_in * 1000 };
  }

  async authorize(config: CalendarConnectOptions): Promise<CalendarTokens> {
    if (this.cancelPending) throw new Error('A calendar sign-in is already open. Finish or cancel it first.');
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    let code: string | undefined;
    let rejected = false;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const callback = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    // Cancellation may arrive before the browser launch finishes.
    void callback.catch(() => {});
    const listener = await startAuthCallbackLoopback({
      state, ttlMs: 180_000,
      onCallback: async value => {
        const url = new URL(value);
        rejected = Boolean(url.searchParams.get('error'));
        code = url.searchParams.get('code') || undefined;
        return { success: Boolean(code) && !rejected, affectsSyncIdentity: false };
      },
      onClose: () => {
        if (code && !rejected) resolveCode(code);
        else rejectCode(new Error('Calendar sign-in was canceled, denied, or timed out. Retry when ready.'));
      },
    });
    this.cancelPending = () => listener.close();
    const redirect = new URL(listener.callbackBaseUrl);
    // Microsoft ignores the ephemeral port for registered localhost native redirects.
    if (config.provider === 'microsoft') redirect.hostname = 'localhost';
    const redirectUri = redirect.toString();
    const url = new URL(CALENDAR_OAUTH[config.provider].authorize);
    url.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: CALENDAR_OAUTH[config.provider].scope, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      ...(config.provider === 'google' ? { access_type: 'offline', prompt: 'consent select_account' } : { prompt: 'select_account' }),
    }).toString();
    try {
      try { await this.openBrowser(url.toString()); }
      catch { throw new Error('The sign-in browser could not be opened. Retry the connection.'); }
      const authCode = await callback;
      const body = new URLSearchParams({ client_id: config.clientId, code: authCode, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
      if (config.clientSecret) body.set('client_secret', config.clientSecret);
      return await this.tokens(config.provider, body);
    } finally {
      await listener.close();
      this.cancelPending = undefined;
    }
  }

  async refresh(config: CalendarConnectOptions, refreshToken: string): Promise<CalendarTokens> {
    const body = new URLSearchParams({ client_id: config.clientId, refresh_token: refreshToken, grant_type: 'refresh_token' });
    if (config.clientSecret) body.set('client_secret', config.clientSecret);
    if (config.provider === 'microsoft') body.set('scope', CALENDAR_OAUTH.microsoft.scope);
    return this.tokens(config.provider, body, refreshToken);
  }
}
