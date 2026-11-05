import { getElectronAccelerator, KeyboardShortcuts } from '../../../shared/KeyboardShortcuts';

interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

interface VoiceShortcutWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string): void;
  };
}

/** Owns only the voice binding; target resolution must prefer the active voice owner. */
export function createVoiceGlobalShortcut(
  shortcuts: ShortcutRegistry,
  getTargetWindow: () => VoiceShortcutWindow | null,
) {
  const accelerator = getElectronAccelerator(KeyboardShortcuts.voice.toggle);
  let enabled = false;
  let registered = false;
  let error: string | null = null;
  let lastPress: number | null = null;

  function setEnabled(nextEnabled: boolean): void {
    enabled = nextEnabled;
    if (!enabled) {
      if (registered) shortcuts.unregister(accelerator);
      registered = false;
      error = null;
      lastPress = null;
      return;
    }
    if (registered) return;
    try {
      registered = shortcuts.register(accelerator, () => {
        if (!enabled || !registered) return;
        const target = getTargetWindow();
        if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
        // Holding a key must not immediately connect, disconnect, then reconnect.
        const now = Date.now();
        const repeating = lastPress !== null && now - lastPress < 750;
        lastPress = now;
        if (repeating) return;
        target.webContents.send('voice-mode:toggle-requested');
      });
      error = registered ? null : 'Global voice shortcut unavailable. It may already be used by another app. Change that app’s shortcut, then disable and re-enable Voice Mode to retry.';
    } catch (cause) {
      error = `Global voice shortcut unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  return {
    setEnabled,
    getStatus: () => ({ registered, error }),
    dispose: () => setEnabled(false),
  };
}
