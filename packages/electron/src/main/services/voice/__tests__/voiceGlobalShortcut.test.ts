// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createVoiceGlobalShortcut } from '../voiceGlobalShortcut';

function setup(registered = true) {
  let press: () => void = () => {};
  const shortcuts = {
    register: vi.fn((_key: string, callback: () => void) => {
      press = callback;
      return registered;
    }),
    unregister: vi.fn(),
  };
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
  };
  const target = vi.fn(() => window as typeof window | null);
  const shortcut = createVoiceGlobalShortcut(shortcuts, target);
  return { shortcuts, window, target, shortcut, press: () => press() };
}

describe('global Voice Mode shortcut', () => {
  it('only reserves the shortcut while voice is enabled and releases only its own binding', () => {
    const { shortcuts, shortcut } = setup();
    shortcut.setEnabled(false);
    expect(shortcuts.register).not.toHaveBeenCalled();
    shortcut.setEnabled(true);
    shortcut.setEnabled(true);
    expect(shortcuts.register).toHaveBeenCalledTimes(1);
    expect(shortcut.getStatus()).toEqual({ registered: true, error: null });
    shortcut.setEnabled(false);
    shortcut.dispose();
    expect(shortcuts.unregister).toHaveBeenCalledExactlyOnceWith(shortcuts.register.mock.calls[0][0]);
  });

  it('dispatches to the resolved owner without requiring keyboard focus', () => {
    const { shortcut, press, window, target } = setup();
    shortcut.setEnabled(true);
    press();
    expect(target).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith('voice-mode:toggle-requested');
  });

  it('ignores key repeat and callbacks after disabling', () => {
    const { shortcut, press, window } = setup();
    shortcut.setEnabled(true);
    press();
    press();
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
    shortcut.setEnabled(false);
    press();
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('suppresses a stream of held-key repeats but accepts a later deliberate press', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const { shortcut, press, window } = setup();
      shortcut.setEnabled(true);
      for (const time of [0, 500, 600, 700, 1200, 1500]) {
        now.mockReturnValue(time);
        press();
      }
      expect(window.webContents.send).toHaveBeenCalledTimes(1);
      now.mockReturnValue(2300);
      press();
      expect(window.webContents.send).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('handles absent or destroyed project windows without sending to another window', () => {
    const { shortcut, press, window, target } = setup();
    shortcut.setEnabled(true);
    target.mockReturnValueOnce(null);
    press();
    window.isDestroyed.mockReturnValue(true);
    press();
    window.isDestroyed.mockReturnValue(false);
    window.webContents.isDestroyed.mockReturnValue(true);
    press();
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it('reports an occupied shortcut and does not unregister a binding it never acquired', () => {
    const { shortcut, shortcuts } = setup(false);
    shortcut.setEnabled(true);
    expect(shortcut.getStatus()).toMatchObject({ registered: false, error: expect.stringContaining('another app') });
    shortcut.dispose();
    expect(shortcuts.unregister).not.toHaveBeenCalled();
  });

  it('reports registration exceptions instead of failing app startup', () => {
    const { shortcut, shortcuts } = setup();
    shortcuts.register.mockImplementation(() => { throw new Error('OS refused'); });
    expect(() => shortcut.setEnabled(true)).not.toThrow();
    expect(shortcut.getStatus()).toMatchObject({ registered: false, error: expect.stringContaining('OS refused') });
  });
});
