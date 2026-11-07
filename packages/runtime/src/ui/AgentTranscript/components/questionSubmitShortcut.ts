import type { KeyboardEvent } from 'react';

/** Handle submission within the focused question widget, before editor handlers. */
export function handleQuestionSubmitShortcut(
  event: KeyboardEvent,
  canSubmit: boolean,
  submit: () => void | Promise<void>,
): void {
  if (event.key !== 'Enter' || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
    || event.nativeEvent.isComposing) return;

  event.preventDefault();
  event.stopPropagation();
  if (canSubmit && !event.repeat) void submit();
}
