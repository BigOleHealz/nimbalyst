import React, { useEffect, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { buildCommitPrompt, type CommitContext } from '@nimbalyst/runtime/ui/AgentTranscript/utils/commitPromptBuilder';
import { sessionDismissedCompletionAtom, sessionSuccessfulCompletionAtom } from '../../store/atoms/sessionCompletionActions';
import { sessionGitStatusAtom, worktreeChangedFilesAtom } from '../../store/atoms/sessionFiles';
import { isClaudeCliTerminalSession } from './claudeCliInputRouting';
import { sessionPullRequestTitleAtom } from '../../store/atoms/sessionTicketTitle';

const ACTIONS = [
  { id: 'commit', label: 'Commit', instruction: 'Commit only. Do not push or open a pull request.' },
  { id: 'push', label: 'Commit & Push', instruction: 'After the commit succeeds, push the task branch. Do not open a pull request.' },
  { id: 'pr', label: 'Commit, Push & Open PR', instruction: 'After the commit succeeds, push the task branch and open a pull request. Reuse an existing pull request for this branch if one exists, and return its link.' },
] as const;

interface Props {
  sessionId: string;
  workspacePath: string;
  worktreePath?: string | null;
  worktreeId?: string | null;
  provider?: string | null;
  available: boolean;
}

export function SessionCompletionActions({ sessionId, workspacePath, worktreePath, worktreeId, provider, available }: Props) {
  const completion = useAtomValue(sessionSuccessfulCompletionAtom(sessionId));
  const pullRequestTitle = useAtomValue(sessionPullRequestTitleAtom(sessionId));
  const gitStatus = useAtomValue(sessionGitStatusAtom(sessionId));
  const worktreeFiles = useAtomValue(worktreeChangedFilesAtom(worktreeId ?? ''));
  const [context, setContext] = useState<CommitContext | null>(null);
  const [dismissed, setDismissed] = useAtom(sessionDismissedCompletionAtom(sessionId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const enabled = available && completion !== null && completion !== dismissed;
  const repoPath = worktreePath || workspacePath;
  const activeCompletion = useRef<number | null>(null);
  activeCompletion.current = enabled ? completion : null;

  useEffect(() => () => { activeCompletion.current = null; }, []);

  useEffect(() => {
    let active = true;
    setContext(null);
    setError(null);
    if (enabled) {
      void window.electronAPI.invoke('git:get-commit-context', repoPath, sessionId, undefined, !!worktreeId)
        .then((result: CommitContext) => {
          if (active && result?.success && result.files.length > 0) setContext(result);
        }).catch(() => {
          // Git context is optional: non-Git projects simply have no commit actions.
        });
    }
    return () => { active = false; };
  }, [enabled, completion, repoPath, sessionId, worktreeId, gitStatus, worktreeFiles]);

  if (!enabled || !context) return null;

  const request = async (action: typeof ACTIONS[number]) => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      // Recheck the file list at click time; a manual commit may have landed since the banner appeared.
      const fresh = await window.electronAPI.invoke('git:get-commit-context', repoPath, sessionId, undefined, !!worktreeId) as CommitContext;
      if (activeCompletion.current !== completion) return;
      if (!fresh?.success) throw new Error('Could not read the changes. Try again.');
      if (fresh.files.length === 0) {
        setContext(null);
        return;
      }
      const message = buildCommitPrompt({ commitContext: fresh, isInWorktree: !!worktreeId }) +
        '\n\nThe user selected: ' + action.label + '. ' + action.instruction +
        (action.id === 'pr' && pullRequestTitle ? '\nUse this exact pull request title: ' + JSON.stringify(pullRequestTitle) + '.' : '') +
        '\nFollow this repository\'s Git instructions. Continue with push or PR creation only after a successful commit; if approval is cancelled or the commit fails, stop. Report any repository policy or Git error that prevents the requested action.';
      const docContext = { mode: 'agent', inputType: 'user' as const };
      if (isClaudeCliTerminalSession(provider)) {
        await window.electronAPI.invoke('ai:createQueuedPrompt', sessionId, message, [], docContext);
      } else {
        await window.electronAPI.invoke('ai:sendMessage', message, docContext, sessionId, workspacePath);
      }
      setDismissed(completion);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the request. Try again.');
    } finally {
      sending.current = false;
      setPending(false);
    }
  };

  return (
    <div className="session-completion-actions shrink-0 border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-2" aria-label="Task completion actions">
      <div className="flex items-center justify-between gap-2 text-xs text-[var(--nim-text-muted)]">
        <span>Ready to commit these changes?</span>
        <button type="button" disabled={pending} onClick={() => setDismissed(completion)} className="hover:text-[var(--nim-text)] disabled:opacity-50">Later</button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {ACTIONS.map(action => (
          <button key={action.id} type="button" disabled={pending} onClick={() => void request(action)} className="rounded border border-[var(--nim-border)] px-2 py-1 text-xs text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] disabled:opacity-50">
            {action.label}
          </button>
        ))}
      </div>
      {pending && <p role="status" className="mt-2 text-xs text-[var(--nim-text-muted)]">Sending request…</p>}
      {error && <p role="alert" className="mt-2 select-text text-xs text-[var(--nim-error)]">{error}</p>}
    </div>
  );
}
