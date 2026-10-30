// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ persist: vi.fn(), live: vi.fn(), resume: vi.fn(), queue: vi.fn() }));
vi.mock('../askUserQuestionFallbackResolution', () => ({ persistInteractivePromptTerminalResult: h.persist }));
vi.mock('../../../mcp/tools/interactivePromptLiveness', () => ({ hasLiveInteractivePrompt: h.live }));
vi.mock('../../RepositoryManager', () => ({ getQueuedPromptsStore: () => ({ get: async () => null, create: h.queue }) }));
import { configureRequestUserInputResume, settleOrphanedRequestUserInput } from '../requestUserInputOrphanedAnswer';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
describe('Jira clarification after a restart or session switch', () => {
  beforeEach(() => {
    vi.clearAllMocks(); h.live.mockReturnValue(false); h.persist.mockResolvedValue(undefined); h.resume.mockResolvedValue(undefined);
    configureRequestUserInputResume(h.resume);
  });
  const args = (provider: string, cancelled = false) => ({ event: {} as Electron.IpcMainInvokeEvent, sessionId: 'jira-session', promptId: 'target-question', answers: { target: { type: 'singleSelect', selectedId: 'staging' } }, cancelled, respondedBy: 'desktop' as const, session: { provider, workspacePath: '/original-repo' } });
  it.each(['claude-code', 'openai-codex'])('persists explicit answers before resuming %s in its original workspace', async provider => {
    await settleOrphanedRequestUserInput(args(provider));
    expect(h.persist).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'jira-session', answers: args(provider).answers, cancelled: false }));
    expect(h.resume).not.toHaveBeenCalled();
    await tick();
    expect(h.resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'jira-session', workspacePath: '/original-repo', message: expect.stringContaining('staging') }));
    expect(h.queue).not.toHaveBeenCalled();
  });
  it.each(['claude-code', 'openai-codex'])('does not resume or queue dependent work for a cancelled %s prompt', async provider => {
    await settleOrphanedRequestUserInput(args(provider, true));
    await tick();
    expect(h.persist).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.queue).not.toHaveBeenCalled();
  });
  it('retains an answer for a different turn without interrupting a new pending clarification', async () => {
    h.live.mockReturnValue(true);
    await settleOrphanedRequestUserInput(args('openai-codex'));
    await tick();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.queue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'jira-session', prompt: expect.stringContaining('staging'), documentContext: { promptOrigin: 'interactive-question' } }));
  });
});
