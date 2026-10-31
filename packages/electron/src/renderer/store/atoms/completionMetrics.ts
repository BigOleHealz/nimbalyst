import { atom, type Getter } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { readSessionCompletionMetrics, summarizeCompletionMetrics } from '@nimbalyst/runtime/ai/sessionCompletionMetrics';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { trackerItemByIdAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { sessionRegistryAtom, sessionTokenUsageAtom } from './sessions';
import { sessionArchiveSubtreeIds } from '../../components/AgenticCoding/sessionArchiveSelection';
import { resolveLinkedSessions } from '../../utils/resolveLinkedSessions';

function summarize(get: Getter, registry: Map<string, SessionMeta>, roots: string[]) {
  const sessions = sessionArchiveSubtreeIds(registry, roots).flatMap(id => {
    const meta = registry.get(id);
    if (!meta) return [{ completionMetrics: undefined }];
    const liveUsage = get(sessionTokenUsageAtom(id));
    const liveMetrics = liveUsage ? readSessionCompletionMetrics(liveUsage,
      meta.completionMetrics?.startedAt, meta.completionMetrics?.endedAt) : undefined;
    const completionMetrics = liveMetrics ? { ...meta.completionMetrics, ...liveMetrics } : meta.completionMetrics;
    // Persisted list data can be newer than a retained transcript after remote
    // sync. Lifetime counters must never regress to the older resident values.
    if (liveMetrics && completionMetrics && meta.completionMetrics) {
      for (const key of ['totalTokens', 'costUSD'] as const) {
        const persisted = meta.completionMetrics[key];
        if (persisted !== undefined) completionMetrics[key] = Math.max(persisted, completionMetrics[key] ?? 0);
      }
    }
    // Empty grouping containers have no spend or transcript of their own.
    if (meta.childCount > 0 && !completionMetrics && !meta.hasStarted) return [];
    return [{ completionMetrics }];
  });
  return summarizeCompletionMetrics(sessions);
}

export const sessionCompletionMetricsAtom = atomFamily((sessionId: string) => atom(get =>
  summarize(get, get(sessionRegistryAtom), [sessionId])));

export const trackerCompletionMetricsAtom = atomFamily((itemId: string) => atom(get => {
  const registry = get(sessionRegistryAtom);
  const item = get(trackerItemByIdAtom(itemId));
  const roots = [...resolveLinkedSessions(item, registry).map(s => s.id),
    ...(item?.system.linkedSessions ?? []).filter(id => !registry.has(id))];
  return summarize(get, registry, roots);
}));
