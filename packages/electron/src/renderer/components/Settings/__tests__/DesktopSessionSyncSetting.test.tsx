// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopSessionSyncSetting } from '../DesktopSessionSyncSetting';

afterEach(cleanup);
it('runs one manual sync without enabling automatic sync and displays partial failures', async () => {
  const original = window.electronAPI;
  const settingsSet = vi.fn();
  const counts = { synced: 2, unchanged: 1, unavailable: 0, conflicts: 1, failed: 1 };
  const invoke = vi.fn().mockResolvedValue({ success: true, result: { codex: counts, claude: { ...counts, synced: 0, unavailable: 2 }, busy: 1, errors: ['Codex project registration: unsupported version'] } });
  window.electronAPI = { ...original, invoke, settingsSet };
  try {
    render(<DesktopSessionSyncSetting />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync projects and sessions now' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('unsupported version'));
    expect(invoke).toHaveBeenCalledExactlyOnceWith('external-sessions:export-to-desktop');
    expect(settingsSet).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Codex: 2 synced');
    invoke.mockRejectedValueOnce(new Error('Disk full'));
    fireEvent.click(screen.getByRole('button', { name: 'Sync projects and sessions now' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Disk full'));
  } finally { window.electronAPI = original; }
});
