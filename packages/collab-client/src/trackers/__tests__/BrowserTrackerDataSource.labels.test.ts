// @vitest-environment node
/**
 * A browser `labels` update goes into the item's add-wins label set. Reads
 * project `fields.labels` from that set, so writing it as a plain field made a
 * web label edit vanish on the next read.
 */
import { expect, it } from 'vitest';
import { projectLabelsToValues } from '@nimbalyst/tracker-engine';
import { updatePayload } from '../browser/BrowserTrackerDataSource';

const user = { displayName: 'Browser member', email: 'b@example.com', gitName: null, gitEmail: null };

it('carries completion dates in synced fields and clears them when reopened', () => {
  const payload = {
    itemId: 'task', primaryType: 'task', archived: false, bodyVersion: 0,
    fields: { state: 'active' }, labels: {}, comments: [], system: {},
  } as Parameters<typeof updatePayload>[0];
  const context = { getTypeModel: () => ({ type: 'task', roles: { workflowStatus: 'state' }, fields: [
    { name: 'state', type: 'select', options: [{ value: 'delivered', category: 'done' as const }] },
  ] }) };
  const completed = updatePayload(payload, { state: 'delivered' }, user, context);
  expect(completed.fields.completedAt).toEqual(expect.any(String));
  const edited = updatePayload(completed, { title: 'Renamed' }, user, context);
  expect(edited.fields.completedAt).toBe(completed.fields.completedAt);
  const reopened = updatePayload(edited, { state: 'active' }, user, context);
  expect(reopened.fields.completedAt).toBeNull();
});

it('diffs a labels update into the label set and keeps other fields as fields', () => {
  const payload = {
    itemId: 'i1',
    primaryType: 'entity',
    archived: false,
    bodyVersion: 0,
    fields: { title: 'Search' },
    labels: { a: { id: 'a', value: 'feature' }, b: { id: 'b', value: 'old' } },
    comments: [],
    system: {},
  } as unknown as Parameters<typeof updatePayload>[0];
  const next = updatePayload(payload, { labels: ['feature', 'capability'], surface: 'web' }, user);
  expect(projectLabelsToValues(next.labels).sort()).toEqual(['capability', 'feature']);
  // The removed label is tombstoned, not dropped, so a concurrent add elsewhere still merges.
  expect(next.labels.b).toMatchObject({ value: 'old', tombstone: true });
  expect(next.fields).toEqual({ title: 'Search', surface: 'web' });
  expect(updatePayload(payload, { title: 'Renamed' }, user).labels).toBe(payload.labels);
});
