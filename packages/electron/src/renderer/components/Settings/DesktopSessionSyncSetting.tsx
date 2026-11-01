import React, { useState } from 'react';
import { useAtom } from 'jotai';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { SettingsToggle } from '../GlobalSettings/SettingsToggle';
import type { DesktopSessionSyncResult, DesktopSyncCounts } from '../../../shared/externalSessions';

const describe = (name: string, counts: DesktopSyncCounts) => `${name}: ${counts.synced} synced, ${counts.unchanged} up to date, ${counts.unavailable} unavailable, ${counts.conflicts} continued or changed, ${counts.failed} failed.`;

export function DesktopSessionSyncSetting() {
  const [enabled, setEnabled] = useAtom(settingAtom('app.desktopSessionSyncEnabled'));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DesktopSessionSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sync = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response: { success: boolean; result?: DesktopSessionSyncResult; error?: string } = await window.electronAPI.invoke('external-sessions:export-to-desktop');
      if (!response.success || !response.result) throw new Error(response.error ?? 'Desktop sync failed');
      setResult(response.result);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="desktop-session-sync-setting space-y-2" data-testid="desktop-session-sync-setting">
    <SettingsToggle checked={enabled} onChange={setEnabled} name="Sync to local Codex and Claude"
      description="Copy conversation text from all providers to existing local Codex and Claude data, with project folders and session names. Syncs idle sessions every minute. Off by default."
      testId="desktop-session-sync-toggle" />
    <p className="text-xs text-[var(--nim-text-muted)]">Copies are labeled “(Nimbalyst)”. In Claude Desktop’s Code tab, use /resume to pick one up. Tool state, attachments and private reasoning stay in Nimbalyst. Continuing a copy in a desktop app stops updates to that copy.</p>
    <button type="button" disabled={busy} onClick={() => { void sync(); }} className="desktop-session-sync-button rounded border border-[var(--nim-border)] px-3 py-1.5 text-sm disabled:opacity-50">
      {busy ? 'Syncing…' : 'Sync projects and sessions now'}
    </button>
    {result && <div role="status" className="desktop-session-sync-result select-text text-xs text-[var(--nim-text-muted)]">
      <p>{describe('Codex', result.codex)}</p><p>{describe('Claude', result.claude)}</p>
      {result.busy > 0 && <p>{result.busy} active sessions will sync when idle.</p>}
      {result.errors.map((message, index) => <p key={index} className="text-[var(--nim-error)]">{message}</p>)}
    </div>}
    {error && <p role="alert" className="select-text text-xs text-[var(--nim-error)]">{error}</p>}
  </div>;
}
