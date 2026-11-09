// @vitest-environment node
import { expect, it, vi } from 'vitest';
const { provider, codex } = vi.hoisted(() => ({ provider: {
  on: vi.fn(), initialize: vi.fn(async () => {}),
  sendMessage: vi.fn(async function* () { yield {type: 'text', content: 'image received'}; }),
}, codex: {on: vi.fn(), initialize: vi.fn(async () => {}), sendMessage: vi.fn(async function* () {yield {type: 'text', content: 'remote Codex'};})} }));
vi.mock('../host/nodeHost.js', () => ({ registerNodeHostEnvironment: vi.fn() }));
vi.mock('../host/claudeCodeDeps.js', () => ({ registerClaudeCodeDeps: vi.fn() }));
vi.mock('../db/openDatabase.js', () => ({ openDatabase: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/SessionManager', () => ({ SessionManager: class {} }));
vi.mock('@nimbalyst/runtime/ai/server/providers/ClaudeCodeProvider', () => ({ ClaudeCodeProvider: class { constructor() { return provider; } } }));
vi.mock('@nimbalyst/runtime/ai/server/providers/OpenAICodexProvider', () => ({OpenAICodexProvider: class {constructor() {return codex;}}}));
import { NimbalystNode } from '../NimbalystNode.js';

it('supplies staged attachments in the provider attachment argument while resuming from host metadata', async () => {
  const node = Object.assign(Object.create(NimbalystNode.prototype), {
    sessionStore: {get: async () => ({id: 'remote', mode: 'agent', model: 'claude-code:sonnet'})},
    db: {prepare: () => ({get: () => ({count: 2})})},
    config: {},
  }) as NimbalystNode;
  const attachments = [{id: 'image', filename: 'image.png', filepath: '/private/image.png', mimeType: 'image/png', size: 3, type: 'image' as const, addedAt: 1}];
  const result = await node.runTurn({sessionId: 'remote', workspacePath: '/checkout', prompt: 'Read the image', attachments});
  expect(provider.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Read the image'), expect.objectContaining({mode: 'agent'}), 'remote', [], '/checkout', attachments);
  expect(result.text).toBe('image received');
});

it('uses Codex with the configured remote model and working directory', async () => {
  const node = Object.assign(Object.create(NimbalystNode.prototype), {
    sessionStore: {get: async () => ({id: 'codex-session', provider: 'openai-codex', mode: 'agent', model: 'openai-codex:gpt-6.1-sol'})},
    db: {prepare: () => ({get: () => ({count: 2})})}, config: {},
  }) as NimbalystNode;
  const result = await node.runTurn({sessionId: 'codex-session', workspacePath: '/remote/session', prompt: 'Check the workspace'});
  expect(codex.initialize).toHaveBeenCalledWith(expect.objectContaining({model: 'gpt-6.1-sol'}));
  expect(codex.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Check the workspace'), expect.any(Object), 'codex-session', [], '/remote/session', []);
  expect(result.text).toBe('remote Codex');
});
