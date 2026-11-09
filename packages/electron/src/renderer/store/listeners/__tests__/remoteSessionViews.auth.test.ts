// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
vi.mock('@nimbalyst/runtime/store', async () => ({store: (await import('jotai')).createStore()}));
vi.mock('../../atoms/stytchAuth', async () => ({stytchAuthAtom: (await import('jotai')).atom(null)}));
vi.mock('../../atoms/sessions', async () => {
  const {atom} = await import('jotai');
  return {sessionRegistryAtom: atom(new Map()), sessionDraftInputAtom: () => atom(''), sessionDraftAttachmentsAtom: () => atom([]), sessionDraftHydratedAtom: () => atom(false), sessionDraftLocalModifiedAtAtom: () => atom(0)};
});
import {store} from '@nimbalyst/runtime/store';
import {stytchAuthAtom} from '../../atoms/stytchAuth';
import {selectedMachineAtom} from '../../atoms/remoteMachines';
import {initRemoteSessionListeners} from '../remoteSessionViews';

it('preserves the saved remote execution requirement on account changes', async () => {
  const invoke = vi.fn(async () => ({}));
  (window as any).electronAPI = {invoke, on: () => () => {}};
  store.set(stytchAuthAtom, {user:{user_id:'old'}} as any);
  await store.set(selectedMachineAtom('/coder-auth'), 'coder-foss');
  const stop = initRemoteSessionListeners();
  try {
    store.set(stytchAuthAtom, {user:{user_id:'new'}} as any);
    expect(store.get(selectedMachineAtom('/coder-auth'))).toBe('coder-foss');
    expect(invoke).not.toHaveBeenCalledWith('workspace:update-state','/coder-auth',{executionMachineId:''});
  } finally {stop();}
});
