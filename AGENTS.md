At the beginning of every AI session, read the root CLAUDE.md and any applicable package-level CLAUDE.md before taking actions.

Use CLI commands by default whenever possible to minimize token usage. Use browser automation or computer use only when CLI tools are unavailable, insufficient for the task, or visual interaction or verification is necessary.

For AI-assisted contributions, record every code-generation model (provider and model/version when available) in the PR description. AI code review must use a different model from every model that generated the code; another session, tool, or reasoning setting using the same model does not qualify. Before pushing your own AI-assisted feature branch and opening its PR, have a different model review the full branch diff, address actionable findings, and re-review substantive fixes. Review prompts must explicitly say to avoid sycophancy, challenge assumptions, and report evidence-backed defects without praise or invented findings. Record the review model and outcome in the PR description. If model identity or access is unavailable, report that limitation rather than claiming the review is complete. Follow [AI-assisted review](.claude/rules/ai-assisted-review.md) for the workflow and prompt. Existing commit, push, and GitHub permissions still apply.

Every new coding agent/session must work in its own Git worktree by default, including delegated agents. Before editing project files, create a new worktree from the current HEAD with a unique `codex/<task>-<unique-id>` branch under `worktrees/<task>-<unique-id>/`, then perform all edits and verification there. For example: `git worktree add -b codex/my-task-unique-id worktrees/my-task-unique-id HEAD`. If the IDE or orchestrator already assigned this agent a dedicated worktree, use it instead of creating a nested worktree. Resume an existing session in its own worktree. Only work in the primary checkout or share a worktree when the user explicitly requests it. Do not copy, discard, or move another session's uncommitted changes, and do not remove worktrees without authorization. Follow the parallel-session file ownership rules even across worktrees.

The project settings in `.vscode/settings.json` enable Cursor's Git worktree discovery and display of Cursor-created worktrees. Each worktree should appear separately in Source Control's Repositories view, where its uncommitted diffs can be opened. If a newly created worktree does not appear immediately, run **Git: Rescan Repositories** in Cursor. Committed branch changes are viewed by comparing the worktree branch with its base branch.

When adding, significantly expanding, or removing a notable product capability, update [docs/FEATURE_INVENTORY.md](docs/FEATURE_INVENTORY.md) as part of implementation. Follow the inclusion test in [CLAUDE.md](CLAUDE.md): meaningful capabilities belong; minor UI improvements such as elapsed-time counters do not. Follow its shared-file ownership and final-report requirements. This applies to every agent provider, whether or not a skill or slash command is used.


When browser work is necessary:
- Create a new Chrome tab dedicated to this agent session.
- Give the browser session a unique name based on the task.
- Retain the returned tab ID and use it for subsequent actions.
- Never reuse, navigate, or close another session’s tabs.
- Use browser tab controls rather than global mouse/keyboard
  input or shortcuts that act on the foreground Chrome window.
- Reuse your own tab throughout the task.