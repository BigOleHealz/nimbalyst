// @vitest-environment node
import {expect, it, vi} from 'vitest';
const {getWorkspaceState} = vi.hoisted(() => ({getWorkspaceState: vi.fn()}));
vi.mock('../../../utils/store', () => ({getWorkspaceState}));
import {projectExecutionMachine, assertProjectAllowsLocalExecution} from '../projectExecution';

it('blocks local execution for a saved remote project even when its host is unavailable', () => {
  getWorkspaceState.mockReturnValue({executionMachineId: 'coder-foss'});
  expect(projectExecutionMachine('/foss')).toBe('coder-foss');
  expect(() => assertProjectAllowsLocalExecution('/foss')).toThrow(/remote machine/);
});

it('retains local execution only for a project explicitly configured locally or with legacy settings', () => {
  for (const state of [{}, {executionMachineId: ''}]) {
    getWorkspaceState.mockReturnValue(state);
    expect(() => assertProjectAllowsLocalExecution('/local')).not.toThrow();
  }
});
