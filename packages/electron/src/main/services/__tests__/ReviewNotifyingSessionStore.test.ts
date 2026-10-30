// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { createReviewNotifyingSessionStore } from '../ReviewNotifyingSessionStore';

describe('review phase transitions', () => {
  let phase: string | null;
  let pending: boolean;
  let override: unknown;
  const review = vi.fn().mockResolvedValue(undefined);
  const active = vi.fn(() => false);
  const update = vi.fn(async (_id, payload) => {
    if (Object.hasOwn(payload.metadata ?? {}, 'phase')) phase = payload.metadata.phase;
    if (Object.hasOwn(payload.metadata ?? {}, 'kanbanOverride')) override = payload.metadata.kanbanOverride;
  });
  const get = vi.fn(async () => ({ id: 's1', title: 'Parser', workspacePath: '/project', metadata: { phase, kanbanOverride: override, hasPendingPrompt: pending } }));
  const base = { get, updateMetadata: update } as unknown as SessionStore;
  const store = createReviewNotifyingSessionStore(base, review, active);

  beforeEach(() => {
    vi.clearAllMocks();
    phase = 'implementing';
    pending = false;
    override = undefined;
    active.mockReturnValue(false);
  });

  it('notifies only on entry and allows a later re-entry', async () => {
    await Promise.all([1, 2, 3].map(() => store.updateMetadata('s1', { metadata: { phase: 'validating' } })));
    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', workspacePath: '/project' }));
    await store.updateMetadata('s1', { metadata: { phase: 'implementing' } });
    await store.updateMetadata('s1', { metadata: { phase: 'validating' } });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('leaves active turns to their existing completion notification', async () => {
    active.mockReturnValue(true);
    await store.updateMetadata('s1', { metadata: { phase: 'validating' } });
    expect(update).toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it('recognizes manual review placement without rewriting the workflow phase', async () => {
    const placement = { column: 'validating', status: 'existing-board-status' };
    await store.updateMetadata('s1', { metadata: { kanbanOverride: placement } });
    await store.updateMetadata('s1', { metadata: { kanbanOverride: placement } });
    expect(review).toHaveBeenCalledTimes(1);
    expect(phase).toBe('implementing');
    await store.updateMetadata('s1', { metadata: { kanbanOverride: null } });
    expect(review).toHaveBeenCalledTimes(1);
    await store.updateMetadata('s1', { metadata: { kanbanOverride: placement } });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('does not report review while the session awaits input', async () => {
    pending = true;
    await store.updateMetadata('s1', { metadata: { phase: 'validating' } });
    expect(review).not.toHaveBeenCalled();
  });

  it('does not notify on a failed write', async () => {
    update.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.updateMetadata('s1', { metadata: { phase: 'validating' } })).rejects.toThrow('disk full');
    expect(review).not.toHaveBeenCalled();
  });

  it('still saves the phase when the optional notification read fails', async () => {
    get.mockRejectedValueOnce(new Error('read unavailable'));
    await expect(store.updateMetadata('s1', { metadata: { phase: 'validating' } })).resolves.toBeUndefined();
    expect(phase).toBe('validating');
    expect(review).not.toHaveBeenCalled();
  });

  it('does not notify a session archived by the same update', async () => {
    await store.updateMetadata('s1', { isArchived: true, metadata: { phase: 'validating' } });
    expect(review).not.toHaveBeenCalled();
  });

  it('keeps a successful write successful when notification delivery fails', async () => {
    review.mockRejectedValueOnce(new Error('OS failed'));
    await expect(store.updateMetadata('s1', { metadata: { phase: 'validating' } })).resolves.toBeUndefined();
    expect(phase).toBe('validating');
  });

  it('does not load sessions for unrelated metadata updates', async () => {
    await store.updateMetadata('s1', { title: 'Renamed' });
    expect(get).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('s1', { title: 'Renamed' });
  });
});
