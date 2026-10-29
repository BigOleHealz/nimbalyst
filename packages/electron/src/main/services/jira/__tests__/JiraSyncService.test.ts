// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { JiraSyncService } from '../JiraSyncService';
import { JiraError } from '@nimbalyst/runtime/integrations/jira';

describe('Jira sync orchestration', () => {
  it('continues after a bad issue, counts protected tasks, and serializes concurrent project syncs', async () => {
    const importSnapshot = vi.fn().mockResolvedValueOnce({ created: true }).mockResolvedValueOnce({ skipped: true });
    const client = {
      async *search() { yield { key: 'APP-1' }; yield { key: 'APP-2' }; yield { key: 'APP-3' }; },
      snapshot: vi.fn().mockResolvedValueOnce({ title: 'first' }).mockRejectedValueOnce(new Error('unsafe server detail')).mockResolvedValueOnce({ title: 'third' }),
    };
    const service = new JiraSyncService();
    const run = () => service.sync('/project', 'jql', client as never, importSnapshot);
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toBe(second);
    expect(first).toEqual({ created: 1, refreshed: 0, skipped: 1, errors: ['APP-2: Could not import this issue. Check access and retry.'] });
    expect(client.snapshot).toHaveBeenCalledTimes(3);
  });

  it('retains partial progress if a later search page fails', async () => {
    const client = { async *search() { yield { key: 'APP-1' }; throw new Error('network'); }, snapshot: async () => ({}) };
    const result = await new JiraSyncService().sync('/project', 'jql', client as never, async () => ({ created: false }));
    expect(result).toMatchObject({ refreshed: 1, errors: ['network'] });
  });

  it('retains actionable sanitized errors from comment requests', async () => {
    const client = { async *search() { yield { key: 'APP-1' }; }, snapshot: async () => { throw new JiraError('Jira network request failed.'); } };
    const result = await new JiraSyncService().sync('/project', 'jql', client as never, vi.fn());
    expect(result.errors).toEqual(['APP-1: Jira network request failed.']);
  });
});
