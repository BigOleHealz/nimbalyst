/** Lightweight lifetime totals for cards, derived from existing usage and transcript rows. */
export interface SessionCompletionMetrics {
  totalTokens?: number;
  costUSD?: number;
  startedAt?: number;
  endedAt?: number;
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Cache counters are disjoint from uncached input; legacy totalTokens differs by provider. */
export function readSessionCompletionMetrics(
  tokenUsage: unknown, startedAt?: number, endedAt?: number,
): SessionCompletionMetrics | undefined {
  const usage = tokenUsage && typeof tokenUsage === 'object' ? tokenUsage as Record<string, unknown> : {};
  const input = nonnegative(usage.inputTokens);
  const output = nonnegative(usage.outputTokens);
  const totalTokens = input !== undefined && output !== undefined
    ? input + output + (nonnegative(usage.cacheReadInputTokens) ?? 0) + (nonnegative(usage.cacheCreationInputTokens) ?? 0)
    : nonnegative(usage.totalTokens);
  // Some providers initialize cost to zero without reporting a price.
  const reportedCost = nonnegative(usage.costUSD);
  const costUSD = reportedCost && reportedCost > 0 ? reportedCost : undefined;
  const start = nonnegative(startedAt);
  const end = nonnegative(endedAt);
  const hasTime = start !== undefined && end !== undefined && end >= start;
  if (totalTokens === undefined && costUSD === undefined && !hasTime) return undefined;
  return {
    ...(totalTokens !== undefined && { totalTokens }),
    ...(costUSD !== undefined && { costUSD }),
    ...(hasTime && { startedAt: start, endedAt: end }),
  };
}

export interface CompletionMetricsSummary {
  sessionCount: number;
  totalTokens?: number;
  costUSD?: number;
  elapsedMs?: number;
  partialTokens: boolean;
  partialCost: boolean;
  partialTime: boolean;
}

/** Deduplicate roots and descendants before calling. Elapsed is wall-clock span, including idle gaps. */
export function summarizeCompletionMetrics(sessions: readonly { completionMetrics?: SessionCompletionMetrics }[]): CompletionMetricsSummary {
  const usages = sessions.map(s => s.completionMetrics);
  const tokens = usages.filter(m => m?.totalTokens !== undefined);
  const costs = usages.filter(m => m?.costUSD !== undefined);
  const times = usages.filter((m): m is SessionCompletionMetrics & { startedAt: number; endedAt: number } =>
    m?.startedAt !== undefined && m.endedAt !== undefined);
  return {
    sessionCount: sessions.length,
    totalTokens: tokens.length ? tokens.reduce((sum, m) => sum + m!.totalTokens!, 0) : undefined,
    costUSD: costs.length ? costs.reduce((sum, m) => sum + m!.costUSD!, 0) : undefined,
    elapsedMs: times.length ? Math.max(...times.map(m => m.endedAt)) - Math.min(...times.map(m => m.startedAt)) : undefined,
    partialTokens: tokens.length < sessions.length,
    partialCost: costs.length < sessions.length,
    partialTime: times.length < sessions.length,
  };
}
