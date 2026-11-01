import React from 'react';
import { useAtomValue } from 'jotai';
import { isDoneStatus } from '@nimbalyst/tracker-schema';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { CompletionMetricsSummary } from '@nimbalyst/runtime/ai/sessionCompletionMetrics';
import { getRecordStatus } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { sessionCompletionMetricsAtom, trackerCompletionMetricsAtom } from '../../store/atoms/completionMetrics';

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function Metrics({ metrics }: { metrics: CompletionMetricsSummary }) {
  const tokens = metrics.totalTokens === undefined ? 'Tokens unavailable'
    : `${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(metrics.totalTokens)} tokens${metrics.partialTokens ? ' (partial)' : ''}`;
  const elapsed = metrics.elapsedMs === undefined ? 'Time unavailable'
    : `${formatElapsed(metrics.elapsedMs)} elapsed${metrics.partialTime ? ' (partial)' : ''}`;
  return <div className="completion-metrics flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-nim-muted select-text" aria-label="Completion metrics">
    <span title={metrics.totalTokens === undefined ? 'The provider has not recorded token usage for these sessions.' : `${metrics.totalTokens.toLocaleString()} recorded tokens, including cache reads and writes when reported. Full lifetime totals of linked sessions; shared sessions are not apportioned between tickets.`}>{tokens}</span>
    <span title="Wall-clock time from the first to last recorded transcript activity across these sessions, including idle gaps and parallel sessions. Metadata edits and archive time are excluded. This is not active AI time.">{elapsed}</span>
    {metrics.costUSD !== undefined && <span title="Provider-reported session cost in USD. May not represent your subscription bill; unavailable provider costs are excluded.">
      {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(metrics.costUSD)}{metrics.partialCost ? ' (partial)' : ''}
    </span>}
    {metrics.sessionCount > 1 && <span>{metrics.sessionCount} sessions</span>}
    {metrics.sessionCount === 0 && <span>No linked sessions</span>}
  </div>;
}

export function SessionCompletionMetrics({ sessionId }: { sessionId: string }) {
  return <Metrics metrics={useAtomValue(sessionCompletionMetricsAtom(sessionId))} />;
}

function LinkedTrackerCompletionMetrics({ itemId }: { itemId: string }) {
  return <Metrics metrics={useAtomValue(trackerCompletionMetricsAtom(itemId))} />;
}

export function TrackerCompletionMetrics({ item }: { item: TrackerRecord }) {
  return isDoneStatus(item.primaryType, getRecordStatus(item)) ? <LinkedTrackerCompletionMetrics itemId={item.id} /> : null;
}
