# Session tabs and splits

Agent mode keeps an ordered list of open session IDs and an optional second conversation in its existing per-workspace layout. Selecting a session from the sidebar, board, quick-open, or a workstream's child tabs adds it to the strip. The board button stays available beside the tabs. Closing a view does not archive the session or cancel its agent.

The left pane retains the existing workstream editor and session panel. The right pane uses the existing `AgentSessionPanel` and `SessionTranscript`, including session-specific drafts, worktree paths, interactive prompts, and permissions. Selecting the right-hand session's tab swaps the two conversations so one session never mounts two composers. Find follows the focused conversation.

## Existing models reused

- Sessions use the canonical `SessionData` and `SessionMeta`, `sessionRegistryAtom`, and session-keyed atoms. Parentage, manager relationships, and conversation branching remain separate. `ai_agent_messages` is the persisted transcript source.
- Tracker tasks use tracker records and schema-defined workflows. Provider todos and task lists are stored separately as session metadata. Opening views does not create tasks or sessions.
- The session board groups registry entries by phase. Approval waiting is an overlay, separate from workflow phase. Tabs read the existing processing, pending-interactive-prompt, and approval atoms.
- `SessionStateManager` owns agent lifecycle and emits the existing session events. Central renderer listeners continue independently of which conversation is mounted. Provider execution remains in the main process/runtime.
- Sessions reference worktrees by `worktreeId`; several sessions can share one checkout. Existing transcript logic resolves each session's worktree path.
- Extensions provide editors, file handlers, panels, widgets, settings, and MCP tools. Editor content stays with each editor through `EditorHost`; this navigation feature does not introduce an editor or transcript model.

## Persistence and assumptions

Open tabs and the second conversation are saved in `agenticCodingWindowState` through the existing debounced workspace layout persistence. The existing selected-workstream and active-child state restore the left pane. Older workspace settings default to no open tabs and no split. Duplicate or malformed IDs are normalized; archived, deleted, and other-workspace sessions are hidden from the strip.

The layout supports any number of open tabs and two equal-width conversation panes. Open views are local to a workspace. Switching views preserves existing background execution; quitting the app continues to use the application's existing session recovery behavior.

## Manual acceptance test

From this worktree, launch the development app:

```sh
cd /Users/bigolehealz/workspace/nimbalyst/worktrees/session-tabs-splits-1029c
pnpm --dir packages/electron dev
```

1. In Agent mode, open three sessions named A, B, and C. Confirm all three appear in the top strip, including sessions from different worktrees.
2. Select A, then use B's **Open side by side** button. Confirm A is on the left and B is on the right.
3. Send a distinct prompt to each pane. Start work in C as well. Use tasks that take long enough to observe progress while switching views. Confirm each reply appears in its own transcript.
4. Leave a different unsent draft in A and B. Click **Session board**. Confirm the board opens and the tabs remain available. Observe the existing running/waiting indicators changing as agents make progress.
5. Return to A. Confirm the split with B and both drafts return. Open C, then select B's tab; confirm the two visible conversations are distinct and messages still route to the chosen session.
6. Ask an agent to present an interactive question or approval. Confirm its tab shows **Waiting for input**, the widget appears in the correct pane, and answering it lets that session continue.
7. Close a running session's tab, then reopen it from the sidebar. Confirm its work continued and the transcript contains the intervening output. Close the last tab and confirm the board stays open.
8. Reopen A, B, and C, split A and B, and allow the layout save to settle. Quit and relaunch the app. Confirm the same tab order and second conversation restore. Repeat with the board selected before quitting; confirm the board and open tabs restore together.

Automated coverage exercises pane/session routing with a narrow transcript transport stub, draft retention, processing-state retention, closing views, focus and Find routing, tab persistence, legacy defaults, and delayed restore races. It does not substitute for running real Codex and Claude Code agents in the desktop app.

## Validation record

- All 20 focused tests pass across the session workspace, saved layout, existing workstream tabs, and Agent mode initialization specs.
- All 38 workspace typechecks pass. The final Electron typecheck and scoped ESLint checks also pass.
- Runtime, Electron main/preload/renderer, Electron workers, and Cloudflare sandbox builds pass after building workspace dependencies.
- The initial full suite recorded 18,340 passes, 56 failures, and three collection failures in the restricted environment. Every failing file subsequently passed after enabling loopback access, disabling Node 26's experimental web storage (`NODE_OPTIONS=--no-experimental-webstorage`), building the collaboration bundle, and placing the installed Ghostty dependency inside the worktree for Vite's file-access rules. The wiki timing spec passed when run alone. The initial full-suite invocation itself remains a failed run; these are targeted recovery results.
- Repository-wide Electron ESLint reports 693 errors in untouched files. This feature does not change lint configuration or unrelated source to suppress them.
- Desktop E2E was not run: the required worktree dev-container workflow needs Docker, which is unavailable in this environment. Use the manual acceptance steps above for the live-agent and restart checks.
