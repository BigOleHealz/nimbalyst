// @vitest-environment node
import { expect, it } from 'vitest';
import { readSessionCompletionMetrics, summarizeCompletionMetrics } from '../sessionCompletionMetrics';

it('counts uncached input, output, cache reads and writes once across provider total conventions', () => {
  for (const totalTokens of [120, 670]) {
    expect(readSessionCompletionMetrics({ inputTokens: 100, outputTokens: 20,
      cacheReadInputTokens: 500, cacheCreationInputTokens: 50, totalTokens,
      currentContext: { tokens: 99999 }, costUSD: 0.5 })).toEqual({ totalTokens: 670, costUSD: 0.5 });
  }
  expect(readSessionCompletionMetrics({ totalTokens: 25 })).toEqual({ totalTokens: 25 });
});

it('distinguishes missing, malformed and recorded zero usage without substituting metadata times', () => {
  for (const value of [undefined, null, {}, { inputTokens: NaN, outputTokens: -3, totalTokens: Infinity }]) {
    expect(readSessionCompletionMetrics(value, 10, 5)).toBeUndefined();
  }
  expect(readSessionCompletionMetrics({ inputTokens: 0, outputTokens: 0, costUSD: 0 })).toEqual({ totalTokens: 0 });
  expect(readSessionCompletionMetrics(undefined, 0, 2500)).toEqual({ startedAt: 0, endedAt: 2500 });
});

it('sums spend but measures overlapping sessions as one wall-clock span and marks partial data', () => {
  const summary = summarizeCompletionMetrics([
    { completionMetrics: { totalTokens: 100, startedAt: 1000, endedAt: 4000, costUSD: 0.2 } },
    { completionMetrics: { totalTokens: 200, startedAt: 2000, endedAt: 5000 } },
    {},
  ]);
  expect(summary).toEqual({ sessionCount: 3, totalTokens: 300, elapsedMs: 4000,
    costUSD: 0.2, partialTokens: true, partialCost: true, partialTime: true });
  expect(summarizeCompletionMetrics([{}])).toMatchObject({ totalTokens: undefined, elapsedMs: undefined });
});
