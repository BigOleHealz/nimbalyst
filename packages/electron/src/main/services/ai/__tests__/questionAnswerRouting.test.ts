// @vitest-environment node
/**
 * Session 723ddabd: the user answered an older, still-open Claude Code card
 * while a newer question was live. The answer had no waiter on its own channel,
 * so it went down the session fallback and settled the live question (a
 * different one); resubmitting then auto-resumed mid-turn and aborted it.
 * An answer belongs to its own card: with no live waiter for that card it
 * becomes the card's terminal result, and it never resumes over a live prompt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  return {
    ipcMain: new EventEmitter(),
    rows: [] as Array<{ sessionId: string; toolUseId: string; result: any }>,
    reservations: new Map<string, unknown>(),
    handlers: new Map<string, (...args: any[]) => any>(),
    provider: 'claude-code',
  };
});

vi.mock('electron', () => ({ ipcMain: h.ipcMain }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../../../mcp/tools/interactivePromptTranscript', () => ({
  persistInteractivePromptToolResult: vi.fn(async (a: { sessionId: string; toolUseId: string; result: any }) => { h.rows.push(a); }),
}));
vi.mock('../pendingPromptPersistence', () => ({ setSessionPendingPrompt: vi.fn(async () => {}) }));
vi.mock('../../../utils/privateSettingsStore', () => ({
  default: class {
    get(key: string) { return h.reservations.get(key); }
    set(key: string, value: unknown) { h.reservations.set(key, value); }
  },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn(async () => undefined) },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn(async () => ({ provider: h.provider, workspacePath: '/ws' })) },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({ ProviderFactory: { getProvider: () => undefined }, isAskUserQuestionProvider: () => false }));
vi.mock('../../../utils/ipcRegistry', () => ({ safeHandle: (channel: string, fn: (...args: any[]) => any) => h.handlers.set(channel, fn) }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('../CommitProposalExecution', () => ({ cancelCommitProposalOnce: vi.fn(), acceptsCommitProposalResponse: vi.fn() }));
vi.mock('../../SessionCommitService', () => ({ SessionCommitService: {} }));
vi.mock('@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository', () => ({ TranscriptMigrationRepository: { hasService: () => false } }));
vi.mock('../../../tray/TrayManager', () => ({ TrayManager: { getInstance: () => ({ onPromptResolved: vi.fn() }) } }));
vi.mock('../../../mcp/tools/codexToolCallResolver', () => ({
  resolveRequestUserInputPromptTargets: (id: string) => ({ promptId: id, waiterPromptIds: [id] }),
}));
vi.mock('../gitCommitProposalPromptUtils', () => ({ getGitCommitProposalResponseChannel: vi.fn(), resolveGitCommitProposalPromptId: vi.fn() }));
vi.mock('../codexQuestionDelivery', () => ({ deliverCodexQuestionAnswer: vi.fn() }));

import { registerSessionPromptResponseHandler } from '../../../ipc/sessionPromptResponseHandler';
import { registerAskUserQuestionAnswerHandler } from '../ipc/registerAskUserQuestionAnswerHandler';
import { configureRequestUserInputResume } from '../requestUserInputOrphanedAnswer';
import { clearLiveInteractivePrompt, noteLiveInteractivePrompt } from '../../../mcp/tools/interactivePromptLiveness';

let n = 0;
let sid = '';

beforeEach(() => {
  sid = `routing-${++n}`;
  h.rows.length = 0;
  h.provider = 'claude-code';
  h.ipcMain.removeAllListeners();
  vi.clearAllMocks();
});

const respondToForm = (promptId: string) => {
  registerSessionPromptResponseHandler();
  return h.handlers.get('messages:respond-to-prompt')!({ sender: { send: vi.fn() } }, {
    sessionId: sid,
    promptId,
    promptType: 'request_user_input_request',
    response: { answers: { ok: { type: 'confirm', value: true } } },
    respondedBy: 'desktop',
  });
};

const answerQuestion = (sendMessageHandler: () => unknown, questionId: string) => {
  registerAskUserQuestionAnswerHandler({ sendMessageHandler } as any);
  return h.handlers.get('claude-code:answer-question')!({}, { questionId, answers: { Q: 'stale' }, sessionId: sid });
};

describe('an answer for a card with no live waiter', () => {
  it('closes its own form and leaves the live form and its turn alone', async () => {
    const liveForm = vi.fn();
    h.ipcMain.on(`request-user-input-response:${sid}:toolu_live`, vi.fn());
    h.ipcMain.on(`request-user-input-response:${sid}:__fallback__`, liveForm);
    noteLiveInteractivePrompt(sid);
    const resume = vi.fn(async () => undefined);
    configureRequestUserInputResume(resume);
    try {
      expect(await respondToForm('toolu_stale')).toMatchObject({ success: true });

      expect(liveForm).not.toHaveBeenCalled();
      expect(h.rows).toEqual([expect.objectContaining({ toolUseId: 'toolu_stale', result: expect.objectContaining({ cancelled: false }) })]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(resume).not.toHaveBeenCalled();
    } finally {
      clearLiveInteractivePrompt(sid);
    }
  });

  it('closes its own question and leaves the live question and its turn alone', async () => {
    const liveQuestion = vi.fn();
    h.ipcMain.on(`ask-user-question-response:${sid}:toolu_live`, vi.fn());
    h.ipcMain.on(`ask-user-question:${sid}`, liveQuestion);
    noteLiveInteractivePrompt(sid);
    const sendMessageHandler = vi.fn();
    try {
      expect(await answerQuestion(sendMessageHandler, 'toolu_stale')).toEqual({ success: true });

      expect(liveQuestion).not.toHaveBeenCalled();
      expect(h.rows).toEqual([expect.objectContaining({ toolUseId: 'toolu_stale' })]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(sendMessageHandler).not.toHaveBeenCalled();
    } finally {
      clearLiveInteractivePrompt(sid);
    }
  });

  it('still reaches a fallback waiter on a provider whose waiter ids do not match its cards', async () => {
    h.provider = 'opencode';
    const waiter = vi.fn();
    h.ipcMain.on(`request-user-input-response:${sid}:__fallback__`, waiter);

    expect(await respondToForm('toolu_card')).toMatchObject({ success: true });

    expect(waiter).toHaveBeenCalledWith(null, expect.objectContaining({ promptId: 'toolu_card' }));
    expect(h.rows).toEqual([]);
  });
});
