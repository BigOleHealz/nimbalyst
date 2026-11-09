// @vitest-environment jsdom
import {createStore} from 'jotai';
import {expect, it, vi} from 'vitest';
import {selectedMachineAtom} from '../remoteMachines';

it('waits for persisted routing and restores Coder after a new renderer store is created', async () => {
  const invoke = vi.fn(async () => ({executionMachineId: 'coder-foss'}));
  (window as any).electronAPI = {invoke};
  const first = createStore(); const a = selectedMachineAtom('/coder-persistence-test');
  expect(first.get(a)).toBeTruthy();
  const off = first.sub(a, () => {});
  await vi.waitFor(() => expect(first.get(a)).toBe('coder-foss'));
  await first.set(a, 'coder-foss-2');
  expect(invoke).toHaveBeenCalledWith('workspace:update-state', '/coder-persistence-test', {executionMachineId: 'coder-foss-2'});
  off();
  invoke.mockResolvedValue({executionMachineId: 'coder-foss-2'});
  const second = createStore(); const off2 = second.sub(a, () => {});
  await vi.waitFor(() => expect(second.get(a)).toBe('coder-foss-2'));
  off2();
});

it('does not silently select this Mac when saved routing cannot be read', async () => {
  (window as any).electronAPI = {invoke: vi.fn(async () => {throw Error('settings unavailable');})};
  const store = createStore();const a = selectedMachineAtom('/coder-settings-failure');
  const off = store.sub(a, () => {});
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.get(a)).toBeTruthy();
  off();
});
