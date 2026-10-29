import { getCodexToolLookupAliases } from '@nimbalyst/runtime/ai/server/toolLookupIds';

/** Correlate notification targets with provider and MCP transcript identities. */
export function findApprovalMessageIndex(messages: Array<{
  toolCall?: { id?: string; arguments?: unknown };
  interactivePrompt?: unknown;
}>, requestId: string): number {
  const targets = new Set(getCodexToolLookupAliases(requestId));
  // Some providers reuse raw tool IDs across turns. Prefer the newest widget.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const args = message.toolCall?.arguments;
    const data = args && typeof args === 'object' ? args as Record<string, unknown> : {};
    const prompt = message.interactivePrompt && typeof message.interactivePrompt === 'object'
      ? message.interactivePrompt as Record<string, unknown> : {};
    if ([message.toolCall?.id, prompt.promptId, prompt.requestId, prompt.proposalId, data.requestId, data.proposalId]
      .some(id => typeof id === 'string' && getCodexToolLookupAliases(id).some(alias => targets.has(alias)))) return index;
  }
  return -1;
}
