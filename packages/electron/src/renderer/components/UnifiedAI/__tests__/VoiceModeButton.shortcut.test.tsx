import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/store', async () => {
  const { createStore } = await import('jotai');
  return { store: createStore() };
});
vi.mock('../../../store/atoms/appSettings', async () => {
  const { atom } = await import('jotai');
  const voiceModeSettingsAtom = atom({ enabled: true });
  return { voiceModeSettingsAtom, voiceModeEnabledAtom: atom(get => get(voiceModeSettingsAtom).enabled) };
});
vi.mock('../../../store/atoms/sessions', async () => {
  const { atom } = await import('jotai');
  return { activeSessionIdAtom: atom<string | null>('coding-session') };
});
vi.mock('../../../store/atoms/settingsNavigation', async () => {
  const { atom } = await import('jotai');
  return { openSettingsCommandAtom: atom(null) };
});
vi.mock('../../../store/listeners/voiceModeListeners', async () => {
  const { store } = await import('@nimbalyst/runtime/store');
  const voice = await import('../../../store/atoms/voiceModeState');
  return {
    onLinkedSessionChanged: vi.fn(),
    setVoiceActiveSession: vi.fn(() => store.set(voice.voiceListenStateAtom, 'listening')),
    clearVoiceActiveSession: vi.fn(() => store.set(voice.voiceListenStateAtom, 'off')),
    persistAndClearVoiceSession: vi.fn(async () => store.set(voice.voiceListenStateAtom, 'off')),
    wakeVoiceListening: vi.fn(() => store.set(voice.voiceListenStateAtom, 'listening')),
    notifyVoiceAudioPlaybackDrained: vi.fn(),
    sendVoiceMessage: vi.fn(),
  };
});
vi.mock('../../../utils/audioCapture', () => ({
  AudioCapture: class { start = vi.fn(async () => {}); stop = vi.fn(); },
}));
vi.mock('../../../utils/audioPlayback', () => ({
  AudioPlayback: class {
    setOnDrained = vi.fn(); setOnActiveChanged = vi.fn(); destroy = vi.fn();
    stop = vi.fn(); play = vi.fn(); isPlaybackActive = () => false;
  },
}));
vi.mock('../../../utils/voiceReadyChime', () => ({
  prepareVoiceReadyChime: () => ({ play: async () => true, dispose: vi.fn() }),
}));
vi.mock('../../../help', () => ({ HelpTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));

import { store } from '@nimbalyst/runtime/store';
import { voiceModeSettingsAtom } from '../../../store/atoms/appSettings';
import { activeSessionIdAtom } from '../../../store/atoms/sessions';
import { getVoiceStoppedCallback, voiceListenStateAtom, voiceToggleRequestAtom } from '../../../store/atoms/voiceModeState';
import { wakeVoiceListening } from '../../../store/listeners/voiceModeListeners';
import { VoiceModeButton } from '../VoiceModeButton';

const invoke = vi.fn();
async function press() {
  await act(async () => { store.set(voiceToggleRequestAtom, value => value + 1); });
}
function mount() {
  return render(<Provider store={store}><VoiceModeButton workspacePath="/project" /></Provider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.set(voiceModeSettingsAtom, settings => ({ ...settings, enabled: true }));
  store.set(activeSessionIdAtom, 'coding-session');
  store.set(voiceListenStateAtom, 'off');
  store.set(voiceToggleRequestAtom, 0);
  invoke.mockResolvedValue({ success: true });
  window.electronAPI = { invoke } as unknown as typeof window.electronAPI;
});
afterEach(() => {
  cleanup();
  getVoiceStoppedCallback()?.();
});

describe('Voice Mode global shortcut commands', () => {
  it('starts the selected session, wakes sleeping voice, and stops listening voice', async () => {
    mount();
    await press();
    expect(invoke).toHaveBeenCalledWith('voice-mode:test-connection', '/project', 'coding-session', expect.any(String));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stop Voice Mode' }).disabled).toBe(false);
    await act(async () => { store.set(voiceListenStateAtom, 'sleeping'); });
    await press();
    expect(wakeVoiceListening).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith('voice-mode:test-disconnect', expect.anything(), expect.anything());
    await press();
    expect(invoke).toHaveBeenCalledWith('voice-mode:test-disconnect', '/project', 'coding-session');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Start Voice Mode' }).disabled).toBe(false);
  });

  it('ignores requests while disabled or without a selected session, without replaying them later', async () => {
    store.set(voiceModeSettingsAtom, settings => ({ ...settings, enabled: false }));
    mount();
    await press();
    await act(async () => {
      store.set(activeSessionIdAtom, null);
      store.set(voiceModeSettingsAtom, settings => ({ ...settings, enabled: true }));
    });
    await press();
    await act(async () => { store.set(activeSessionIdAtom, 'new-session'); });
    expect(invoke).not.toHaveBeenCalled();
    await press();
    expect(invoke).toHaveBeenCalledWith('voice-mode:test-connection', '/project', 'new-session', expect.any(String));
  });

  it('does not start a second connection while the first shortcut request is pending', async () => {
    let finish!: (value: { success: boolean }) => void;
    invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    mount();
    await press();
    await press();
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ success: true }); });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stop Voice Mode' }).disabled).toBe(false);
  });

  it('does not replay an old shortcut command when the button mounts', () => {
    store.set(voiceToggleRequestAtom, 3);
    mount();
    expect(invoke).not.toHaveBeenCalled();
  });
});
