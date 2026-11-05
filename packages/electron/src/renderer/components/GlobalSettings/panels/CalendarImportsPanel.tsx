import React, { useEffect, useState } from 'react';
import { useAtom } from 'jotai';
import { calendarImportsAtom } from '../../../store/atoms/calendarImports';
import {
  CALENDAR_PROVIDERS,
  type CalendarConnectOptions,
  type CalendarConnection,
  type CalendarImportsSnapshot,
  type CalendarProvider,
} from '../../../../shared/calendarImports';
import { calendarEventDay, calendarEventOrder, calendarImportRange, localCalendarDate } from './calendarAgenda';

const buttonClass = 'rounded border border-nim px-3 py-2 text-sm hover:bg-nim-hover disabled:opacity-50';
const inputClass = 'rounded border border-nim bg-nim-secondary px-3 py-2 text-sm text-nim disabled:opacity-50';
const providerName = (id: CalendarProvider) => CALENDAR_PROVIDERS.find(item => item.id === id)?.name ?? id;

export function CalendarImportsPanel(): React.JSX.Element {
  const [snapshot, setSnapshot] = useAtom(calendarImportsAtom);
  const [provider, setProvider] = useState<CalendarProvider>('google');
  const [clients, setClients] = useState<Partial<Record<CalendarProvider, { clientId: string; clientSecret?: string }>>>({});
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const [from, setFrom] = useState(() => localCalendarDate(new Date()));
  const [through, setThrough] = useState(() => { const date = new Date(); date.setDate(date.getDate() + 30); return localCalendarDate(date); });
  const [busy, setBusy] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const applySnapshot = (next: CalendarImportsSnapshot) => {
    setSnapshot(next);
  };

  useEffect(() => {
    setSelection(previous => Object.fromEntries(snapshot.connections.map(account => [account.id,
      (previous[account.id] ?? account.selectedCalendarIds).filter(id => account.calendars.some(calendar => calendar.id === id)),
    ])));
  }, [snapshot.connections]);

  useEffect(() => {
    let canceled = false;
    void window.electronAPI.invoke('calendar-imports:get').then((next: CalendarImportsSnapshot) => {
      if (!canceled) applySnapshot(next);
    }).catch((failure: unknown) => {
      if (!canceled) setError(failure instanceof Error ? failure.message : 'Calendar imports could not be loaded.');
    }).finally(() => { if (!canceled) setBusy(false); });
    return () => { canceled = true; };
  }, []);

  const run = async (operation: () => Promise<CalendarImportsSnapshot>, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try { applySnapshot(await operation()); setMessage(success); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The calendar operation failed. Retry when ready.'); }
    finally { setBusy(false); setConnecting(false); }
  };

  const client = clients[provider] ?? { clientId: snapshot.clients[provider]?.clientId ?? '' };
  const setClient = (changes: { clientId?: string; clientSecret?: string }) => setClients(previous => ({ ...previous, [provider]: { ...client, ...changes } }));
  const chosenCalendars = (account: CalendarConnection) => selection[account.id] ?? account.selectedCalendarIds;
  const connect = async () => {
    setConnecting(true);
    const options: CalendarConnectOptions = { provider, ...client };
    await run(() => window.electronAPI.invoke('calendar-imports:connect', options), 'Account connected. Choose calendars below, then import events.');
    setClients(previous => ({ ...previous, [provider]: { clientId: client.clientId } }));
  };

  const entries = snapshot.connections.flatMap(account => account.events.map(event => ({ account, event })))
    .sort((left, right) => calendarEventOrder(left.event) - calendarEventOrder(right.event) || left.event.title.localeCompare(right.event.title));
  const grouped = new Map<string, typeof entries>();
  for (const entry of entries) {
    const day = calendarEventDay(entry.event);
    grouped.set(day, [...(grouped.get(day) ?? []), entry]);
  }

  return <section className="calendar-imports-panel space-y-6 text-nim select-text" aria-label="Calendar imports">
    <header className="calendar-imports-header space-y-2">
      <h2 className="text-lg font-semibold">Calendar imports</h2>
      <p className="text-sm text-nim-muted">Connect calendar accounts, choose calendars, and import their events into one agenda. Refresh an import to pick up changed or canceled events.</p>
      <p className="text-sm text-nim-muted">Automatic refresh runs every 5 minutes while Nimbalyst is open, on startup, and after wake or reconnect. It includes 7 days back through 90 days ahead.</p>
      <p className="text-xs text-nim-muted">Calendar access is read-only. Connections and imported events are encrypted on this computer. Each import replaces that account’s previous agenda snapshot for the selected calendars and dates.</p>
    </header>

    <details className="calendar-add-account rounded border border-nim p-4" open={snapshot.connections.length === 0}>
      <summary className="cursor-pointer font-medium">Add calendar account</summary>
    <form className="calendar-connect-form mt-3 space-y-3" onSubmit={event => { event.preventDefault(); void connect(); }}>
      <label className="block space-y-1 text-sm"><span>Provider</span><select className={`${inputClass} w-full`} disabled={busy} value={provider} onChange={event => setProvider(event.target.value as CalendarProvider)}>
        {CALENDAR_PROVIDERS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <details className="calendar-provider-setup rounded border border-nim p-3 text-sm">
        <summary className="cursor-pointer font-medium">Connection setup for {providerName(provider)}</summary>
        {provider === 'google' ? <div className="mt-3 space-y-2 text-nim-muted">
          <p>Create an OAuth Desktop app in Google Cloud, enable the Google Calendar API, and configure the consent screen. While the app is in testing, add your Google account as a test user.</p>
          <p>Copy the client ID and client secret from the Desktop app registration into the fields below. The browser will ask you to sign in and approve calendar read access.</p>
          <a className="underline" href="https://developers.google.com/identity/protocols/oauth2/native-app" target="_blank" rel="noreferrer">Google Desktop app setup</a>
        </div> : <div className="mt-3 space-y-2 text-nim-muted">
          <p>Register an app in Microsoft Entra with the account types you use. Add a Mobile and desktop application platform with the redirect URI <code>http://localhost/auth/callback</code>.</p>
          <p>Add delegated Microsoft Graph permissions <code>Calendars.Read</code> and <code>User.Read</code>. Enter the application client ID below. Your organization may require an administrator’s approval.</p>
          <a className="underline" href="https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app" target="_blank" rel="noreferrer">Microsoft application registration</a>
        </div>}
      </details>
      <label className="block space-y-1 text-sm"><span>Application client ID</span><input className={`${inputClass} w-full`} value={client.clientId} autoComplete="off" disabled={busy} onChange={event => setClient({ clientId: event.target.value })} /></label>
      {provider === 'google' && <label className="block space-y-1 text-sm"><span>Google Desktop app client secret</span><input className={`${inputClass} w-full`} type="password" autoComplete="new-password" value={client.clientSecret ?? ''} disabled={busy} placeholder={snapshot.clients.google?.hasClientSecret ? 'Saved securely; leave blank to keep for this client ID' : 'From the Google Desktop app registration'} onChange={event => setClient({ clientSecret: event.target.value })} /></label>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClass} disabled={busy || !client.clientId.trim()}>Connect account</button>
        {connecting && <><span className="text-sm text-nim-muted">Complete sign-in in your browser.</span><button type="button" className={buttonClass} onClick={() => void window.electronAPI.invoke('calendar-imports:cancel-connect').catch(() => setError('Could not cancel sign-in. Try again.'))}>Cancel sign-in</button></>}
      </div>
    </form>
    </details>

    <section className="calendar-import-controls space-y-3" aria-label="Connected calendars">
      <h3 className="font-medium">Connected accounts</h3>
      {snapshot.connections.some(account => account.autoRefresh === false) && <div className="flex flex-wrap gap-3">
        <label className="space-y-1 text-sm"><span className="block">From</span><input className={inputClass} type="date" disabled={busy} value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label className="space-y-1 text-sm"><span className="block">Through</span><input className={inputClass} type="date" disabled={busy} value={through} onChange={event => setThrough(event.target.value)} /></label>
      </div>}
      <p className="text-xs text-nim-muted">Pause automatic refresh for an account to import a custom date range of up to one year. Recurring meetings are imported as individual occurrences.</p>
      {snapshot.connections.length === 0 && <p className="text-sm text-nim-muted">Add an account above to choose calendars.</p>}
      {snapshot.connections.map(account => <details key={account.id} className="calendar-account-card space-y-3 rounded border border-nim p-4" open={!account.importedAt}>
        <summary className="cursor-pointer text-sm"><span className="font-medium">{account.label}</span><span className="ml-2 text-nim-muted">{providerName(account.provider)} · {account.events.length} {account.events.length === 1 ? 'event' : 'events'}</span>{account.syncError && <span className="ml-2 text-nim-error">Refresh failed</span>}</summary>
        <label className="flex gap-2 text-sm"><input type="checkbox" disabled={busy} checked={account.autoRefresh !== false} onChange={event => void run(() => window.electronAPI.invoke('calendar-imports:auto-refresh', { accountId: account.id, enabled: event.target.checked }), 'Automatic refresh preference saved.')} />Automatic refresh for {account.label}</label>
        {account.autoRefresh !== false && <p className="text-xs text-nim-muted">Every 5 minutes · startup and wake · 7 days back through 90 days ahead. Apply calendar selections with Refresh now.</p>}
        <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-sm">Calendars for {account.label}</legend>
          {account.calendars.map(calendar => <label className="flex gap-2 text-sm" key={calendar.id}>
            <input type="checkbox" checked={chosenCalendars(account).includes(calendar.id)} onChange={event => {
              const checked = event.target.checked;
              setSelection(previous => ({ ...previous, [account.id]: checked ? [...(previous[account.id] ?? account.selectedCalendarIds), calendar.id] : (previous[account.id] ?? account.selectedCalendarIds).filter(id => id !== calendar.id) }));
            }} />{calendar.name}{calendar.primary ? ' (primary)' : ''}
          </label>)}
          {!account.calendars.length && <p className="text-sm text-nim-muted">No readable calendars found.</p>}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} disabled={busy || !chosenCalendars(account).length || (account.autoRefresh === false && (!from || !through))} onClick={() => void run(() => window.electronAPI.invoke('calendar-imports:import', { accountId: account.id, calendarIds: chosenCalendars(account), range: account.autoRefresh === false ? calendarImportRange(from, through) : undefined }), `Imported events for ${account.label}.`)}>{account.autoRefresh !== false ? 'Refresh now' : account.importedAt ? 'Refresh import' : 'Import events'}</button>
          <button className={buttonClass} disabled={busy} onClick={() => void run(() => window.electronAPI.invoke('calendar-imports:calendars', account.id), 'Calendar list updated.')}>Reload calendars</button>
          <button className={buttonClass} disabled={busy} onClick={() => void run(() => window.electronAPI.invoke('calendar-imports:disconnect', account.id), 'Account disconnected and its imported events removed from this agenda.')}>Disconnect</button>
        </div>
        {account.importedAt && <p className="text-xs text-nim-muted">{account.events.length} {account.events.length === 1 ? 'event' : 'events'} · Last imported {new Date(account.importedAt).toLocaleString()}{account.range ? ` · ${new Date(account.range.start).toLocaleDateString()}–${new Date(new Date(account.range.end).getTime() - 1).toLocaleDateString()}` : ''}</p>}
        {account.syncError && <p className="text-sm text-nim-error" role="alert">{account.syncError}</p>}
      </details>)}
    </section>

    {busy && <p className="text-sm text-nim-muted" role="status">{connecting ? 'Waiting for calendar sign-in…' : 'Loading calendars…'}</p>}
    {message && <p className="text-sm" role="status">{message}</p>}
    {error && <p className="text-sm text-nim-error" role="alert">{error}</p>}

    <section className="calendar-unified-agenda space-y-4" aria-label="Unified calendar agenda">
      <h3 className="font-medium">Unified agenda</h3>
      <p className="text-xs text-nim-muted">Times are shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}. Each account’s last successful import stays visible until refreshed or disconnected.</p>
      {entries.length === 0 && <p className="text-sm text-nim-muted">Your imported events will appear here.</p>}
      {[...grouped].map(([day, dayEntries]) => <section key={day} className="calendar-agenda-day space-y-2">
        <h4 className="text-sm font-medium">{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h4>
        {dayEntries.map(({ account, event }) => <details key={`${account.id}/${event.calendarId}/${event.id}`} className="calendar-agenda-event rounded border border-nim p-3">
          <summary className="cursor-pointer text-sm"><span className="font-medium">{event.title}</span><span className="ml-2 text-nim-muted">{event.allDay ? 'All day' : `${new Date(event.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}–${new Date(event.end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}</span></summary>
          <div className="mt-2 space-y-2 text-sm">
            <p className="text-nim-muted">{account.label} · {account.calendars.find(calendar => calendar.id === event.calendarId)?.name ?? 'Calendar'}</p>
            {event.location && <p>{event.location}</p>}
            {event.description && <p className="whitespace-pre-wrap break-words">{event.description}</p>}
            {event.url && <button className={buttonClass} onClick={() => void window.electronAPI.invoke('calendar-imports:open-event', { accountId: account.id, calendarId: event.calendarId, eventId: event.id }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not open the original event.'))}>Open original event</button>}
          </div>
        </details>)}
      </section>)}
    </section>
  </section>;
}
