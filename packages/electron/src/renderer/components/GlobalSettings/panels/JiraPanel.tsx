import React, { useEffect, useState } from 'react';
import { DEFAULT_JIRA_JQL, type JiraSyncResult } from '@nimbalyst/runtime/integrations/jira';

export function jiraSyncSummary(result: JiraSyncResult): string {
  return `${result.created} imported, ${result.refreshed} refreshed, ${result.skipped} skipped (active sessions)${result.errors.length ? `; ${result.errors.length} errors` : ''}`;
}

export function JiraPanel({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [jql, setJql] = useState(DEFAULT_JIRA_JQL);
  const [autoSyncMinutes, setAutoSyncMinutes] = useState(0);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.invoke('jira:get-settings', workspacePath).then((value) => {
      if (cancelled) return;
      const settings = value as { siteUrl: string; email: string; hasToken: boolean; jql: string; autoSyncMinutes: number; lastResult?: JiraSyncResult };
      setSiteUrl(settings.siteUrl); setEmail(settings.email); setHasToken(settings.hasToken);
      setJql(settings.jql); setAutoSyncMinutes(settings.autoSyncMinutes);
      if (settings.lastResult) { setMessage(jiraSyncSummary(settings.lastResult)); setErrors(settings.lastResult.errors); }
    }).catch(error => { if (!cancelled) setErrors([String(error.message ?? error)]); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [workspacePath]);

  const save = async (sync: boolean) => {
    setBusy(true); setErrors([]); setMessage('');
    try {
      await window.electronAPI.invoke('jira:save-settings', { workspacePath, credentials: { siteUrl, email, apiToken }, settings: { jql, autoSyncMinutes } });
      setApiToken(''); setHasToken(true); setMessage('Jira settings saved.');
      if (sync) {
        const result = await window.electronAPI.invoke('jira:sync', workspacePath) as JiraSyncResult;
        setMessage(jiraSyncSummary(result)); setErrors(result.errors);
      }
    } catch (error) { setErrors([error instanceof Error ? error.message : 'Jira request failed.']); }
    finally { setBusy(false); }
  };
  const inputClass = 'w-full rounded border border-nim bg-nim-secondary px-3 py-2 text-sm text-nim';
  return <div className="jira-settings-panel space-y-4 text-nim select-text">
    <h2 className="text-lg font-semibold">Jira Cloud</h2>
    <p className="text-sm text-nim-muted">Site, email, and API token are encrypted using your OS credential storage and shared across projects. JQL and the sync schedule apply to this project. Sync imports native tasks and refreshes their descriptions and comments, skipping tasks with running or waiting sessions.</p>
    <label className="block space-y-1 text-sm">Jira site URL<input className={inputClass} type="url" placeholder="https://your-team.atlassian.net" value={siteUrl} onChange={e => setSiteUrl(e.target.value)} /></label>
    <label className="block space-y-1 text-sm">Email<input className={inputClass} type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
    <label className="block space-y-1 text-sm">API token<input className={inputClass} type="password" autoComplete="new-password" placeholder={hasToken ? 'Saved securely; leave blank to keep' : 'API token'} value={apiToken} onChange={e => setApiToken(e.target.value)} /></label>
    <label className="block space-y-1 text-sm">JQL<textarea className={inputClass} rows={3} value={jql} onChange={e => setJql(e.target.value)} /></label>
    <label className="block space-y-1 text-sm">Auto-sync interval in minutes (0 = off)<input className={inputClass} type="number" min={0} max={10080} step={1} value={autoSyncMinutes} onChange={e => setAutoSyncMinutes(Number(e.target.value))} /></label>
    <p className="text-xs text-nim-muted">Auto-sync runs while Nimbalyst is open. Jira controls which issues and comments your account can read. Synced descriptions and comments replace the imported task body.</p>
    <div className="flex gap-2"><button className="rounded border border-nim px-3 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={() => void save(false)}>Save</button><button className="rounded bg-nim-primary px-3 py-2 text-sm text-white disabled:opacity-50" disabled={busy} onClick={() => void save(true)}>{busy ? 'Working…' : 'Sync Jira'}</button></div>
    {message && <p role="status" className="text-sm">{message}</p>}
    {errors.length > 0 && <div role="alert" className="text-sm text-nim-error space-y-1">{errors.map((error, i) => <p key={i}>{error}</p>)}</div>}
  </div>;
}
