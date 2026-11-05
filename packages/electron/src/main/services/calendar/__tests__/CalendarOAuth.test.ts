// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
import { CalendarOAuth, validateCalendarClient } from '../CalendarOAuth';

const client = { provider: 'google' as const, clientId: 'test.apps.googleusercontent.com', clientSecret: 'app-secret' };

it('uses PKCE and state, ignores an unrelated callback and exchanges only the valid code', async () => {
  let challenge = '';
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = init!.body as URLSearchParams;
    expect(body.get('code')).toBe('valid-code');
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge);
    return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }));
  });
  const browser = vi.fn(async (value: string) => {
    const auth = new URL(value);
    expect(auth.origin).toBe('https://accounts.google.com');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('scope')).toContain('calendar.readonly');
    challenge = auth.searchParams.get('code_challenge')!;
    const callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ state: 'wrong', code: 'invalid' }).toString();
    expect((await fetch(callback)).status).toBe(404);
    callback.search = new URLSearchParams({ state: auth.searchParams.get('state')!, code: 'valid-code' }).toString();
    expect((await fetch(callback)).status).toBe(200);
  });
  expect(await new CalendarOAuth(request, browser).authorize(client)).toMatchObject({ accessToken: 'access', refreshToken: 'refresh' });
  expect(request).toHaveBeenCalledTimes(1);
});

it('allows canceling a pending connection and closes the callback listener', async () => {
  let opened!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  let callback = '';
  const oauth = new CalendarOAuth(vi.fn(), async value => { callback = new URL(value).searchParams.get('redirect_uri')!; opened(); });
  const result = oauth.authorize(client);
  await ready;
  await oauth.cancel();
  await expect(result).rejects.toThrow('canceled');
  await expect(fetch(callback)).rejects.toThrow();
});

it('retains a refresh token when the provider does not rotate it and sanitizes token errors', async () => {
  const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 })))
    .mockResolvedValueOnce(new Response('private-secret', { status: 400 }));
  const oauth = new CalendarOAuth(request);
  expect(await oauth.refresh(client, 'original')).toMatchObject({ accessToken: 'new', refreshToken: 'original' });
  await expect(oauth.refresh(client, 'original')).rejects.toThrow('rejected or expired');
});

it('rejects unknown providers and invalid application registrations', () => {
  expect(() => validateCalendarClient({ provider: 'toString', clientId: 'x' } as any)).toThrow('supported');
  expect(() => validateCalendarClient({ ...client, clientId: 'https://attacker.example' })).toThrow('Desktop app');
});

it('uses the Microsoft native redirect and sends no client secret', async () => {
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = init!.body as URLSearchParams;
    expect(new URL(body.get('redirect_uri')!).hostname).toBe('localhost');
    expect(body.has('client_secret')).toBe(false);
    return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }));
  });
  const browser = async (value: string) => {
    const auth = new URL(value);
    expect(auth.searchParams.get('scope')).toBe('offline_access User.Read Calendars.Read');
    const callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.hostname = '127.0.0.1';
    callback.search = new URLSearchParams({ state: auth.searchParams.get('state')!, code: 'valid' }).toString();
    await fetch(callback);
  };
  await expect(new CalendarOAuth(request, browser).authorize({
    provider: 'microsoft', clientId: '11111111-1111-4111-8111-111111111111',
  })).resolves.toMatchObject({ accessToken: 'access' });
});
