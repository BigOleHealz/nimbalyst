import { expect, it } from 'vitest';
import { selectSessionsForIndexSync } from '../selectSessionsForIndexSync';

it('heals a stale manager after process restart even when parent and activity timestamps match', () => {
  const local = { id: 'child', workspaceId: '/p', provider: 'claude-code', title: 'Child', messageCount: 0, createdAt: 10000, updatedAt: 10000, parentSessionId: 'root', createdBySessionId: 'root' };
  const remote = { ...local, sessionId: 'child', projectId: '/p', lastMessageAt: 10000, createdBySessionId: 'previous-manager' };
  const result = selectSessionsForIndexSync([local], { complete: true, sessions: [remote], projects: [] }, 10000);
  expect(result.sessionsNeedingIndexUpdate).toEqual([local]);
  expect(result.sessionsNeedingMessageSync).toEqual([]);
});

it('republishes a local session whose server row is unreadable under the current key', () => {
  // An undecryptable row carries no value, so the mirror snapshot omits the session and it reads as absent.
  const local = { id: 'old-key', workspaceId: '/p', provider: 'claude-code', title: 'Old', messageCount: 3, createdAt: 5000, updatedAt: 6000 };
  const result = selectSessionsForIndexSync([local], { complete: true, indexProtocolVersion: 2, sessions: [], projects: [] }, 7000);
  expect(result.sessionsNeedingIndexUpdate).toEqual([local]);
});
