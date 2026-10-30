# Session attention notifications

Sessions keep their existing `ai_sessions` rows, runtime status, workflow phase, pending-prompt registry, and renderer atoms. No additional session or board status model is introduced. Tasks remain tracker records linked by `linkedTrackerItemIds`; worktrees remain checkout containers linked by `worktreeId`. Extensions continue to contribute editors, panels, settings, and MCP tools through the SDK and `EditorHost`.

## Behavior and assumptions

- **Awaiting Input** reuses `sessionBlockedNotificationsEnabled`. Existing permission, plan, commit, SDK question, and structured-input desktop notifications remain in place. The MCP `AskUserQuestion` path now also calls the existing notification service. The same setting now controls the existing blocked-session push request to the companion.
- **Review** means the existing `validating` phase, or a completed agent turn. There is no new persisted `review` status. The existing SDK and Claude CLI completion notifications share one delivery function and a new `sessionReviewNotificationsEnabled` setting, enabled by default for older installations.
- Explicit idle transitions into `validating` are observed after the existing session-store write succeeds, including manual `kanbanOverride.column` placements from the automatic board. Identical/replayed phase or override writes do not alert again. Active turns defer to their existing completion notification, avoiding a phase alert followed by a second completion alert. Archived sessions and sessions with pending input are excluded from explicit review alerts.
- The separate automatic session-board work can continue deriving its columns from these same sources. This change does not rename columns or change kanban classification, tracker statuses, PR status, or session hierarchy.
- Desktop alerts retain **Enable OS Notifications**, focus suppression, **Notify Even When Focused**, and system Do Not Disturb behavior. The per-type settings control both desktop alerts and companion push requests; the OS master switch controls desktop alerts only.
- Companion delivery uses the existing personal sync push path. Awaiting Input retains forced delivery; Review retains the existing locked/idle desktop presence policy. A connected, signed-in companion with push permission is required. No APNs, iOS, or server protocol changes are needed.
- Clicking desktop notifications retains the existing session/workspace routing, including worktree-to-project resolution and opening an unloaded workspace. Companion taps retain existing session-ID routing.
- Notifications describe actionable prompts and completed turns, rather than treating every provider pause or `waiting_for_input` status as a human question.

## Manual acceptance check

Run a development build from this worktree so its main-process changes are loaded. The current running app does not automatically load another worktree's code. Starting or restarting the app requires user approval under the repository guidance.

To start it yourself, run `pnpm --dir /Users/bigolehealz/workspace/nimbalyst/worktrees/session-notifications-1029d/packages/electron run dev`.

1. In **Settings → Application → Notifications**, enable **Enable OS Notifications**, **Awaiting Input**, and **Review**. Use **Send Test Notification** and allow Nimbalyst in the operating system's notification settings. Turn off Do Not Disturb for the acceptance check.
2. Create two sessions with distinct names. In one, send: “Wait ten seconds, then use Nimbalyst AskUserQuestion to ask whether to continue, with Continue and Stop as the choices. Wait for my answer.” Switch to another application before the question appears.
3. Confirm a notification names the asking session. Click it. Nimbalyst should come forward with that session selected and the question answerable. Answer it and confirm the waiting indicator clears. Repeat with Claude Code and Codex, including a session in a worktree.
4. Ask a session to complete a short response, then switch to another application. Confirm a **Ready for Review** notification. Click it and confirm the correct session opens. Move an idle session into **Review** (or **Validating** on the phase-based board); expect one review alert, and no repeat from setting the same placement again. Enable **Notify Even When Focused** and select a different session before this drag check so focus suppression does not hide the alert.
5. Disable **Awaiting Input**, repeat the question check, and confirm no input desktop or companion alert appears while the in-app question and waiting indicator still work. Leave Review enabled and confirm completion alerts still arrive.
6. Re-enable Awaiting Input, disable **Review**, and confirm questions alert but completed turns and idle validating transitions do not. Close/reopen Settings and restart the development app to confirm both preferences persist independently.
7. With the existing iOS companion paired, signed in, and allowed to receive notifications, repeat the question check and tap its push notification to open the asking session. For Review pushes, lock the desktop or allow it to become idle before completing a turn. Merely switching desktop apps intentionally does not force a Review push.
8. With **Notify Even When Focused** off, repeat a question while Nimbalyst stays focused; expect suppression. Turn it on, select a different session, and repeat; expect an alert. Viewing the asking session should still suppress it.

## Validation

- The MCP question notification regression was observed failing before the fix, then passing.
- Final notification, routing, settings, and provider regression run: **106 tests passed in 10 files**. On Node 26, run with `NODE_OPTIONS=--no-experimental-webstorage` so jsdom supplies its normal storage implementation.
- Workspace typecheck passed in all **38 packages**; the final Electron typecheck also passed.
- Runtime production build and the full Electron production build passed, including renderer, worker, and sandbox artifact. Main/preload were rebuilt after the final runtime changes.
- The single full unit run passed 18,348 tests and failed 61, with three additional suites unable to load. Every affected file subsequently passed targeted retries: 172 tests across 20 files, after allowing local test HTTP listeners, disabling Node 26 experimental web storage, generating missing collab exports, and allowing the shared dependency path for the WASM fixture. Two existing provider test mocks were extended for the new preference export. The full suite was not repeated.
- Repository lint reports **693 errors and 16 warnings**, with **zero diagnostics on added or changed lines**. Focused notification/settings lint passes. Broad lint cleanup is outside this focused feature.
- The collab-bundle production-output audit exposed shared dependency paths leaking into the generated report from linked worktrees. A focused normalizer fix now passes the real production-output, browser-graph, singleton, state-lane, and size audits. Seven regression tests pass (four reproduced the failure before the fix), along with 12 existing bundle-check script tests. Its two previously unloadable test suites pass against the generated artifacts.
- Native OS delivery, click behavior in a running app, and iOS push delivery remain **unverified end-to-end** until the worktree build is launched and the acceptance check above is exercised. No app was restarted by this session.
- Feature inventory updated in System Integration. Generated license-file changes from building were restored and are excluded from the patch.

## Changed files

- [packages/collab-bundle/vite.config.ts](../packages/collab-bundle/vite.config.ts)
- [packages/collab-bundle/scripts/bundleReportModuleId.ts](../packages/collab-bundle/scripts/bundleReportModuleId.ts)
- [packages/collab-bundle/src/__tests__/bundleReportModuleId.test.ts](../packages/collab-bundle/src/__tests__/bundleReportModuleId.test.ts)
- [CHANGELOG.md](../CHANGELOG.md)
- [packages/electron/src/main/ipc/NotificationHandlers.ts](../packages/electron/src/main/ipc/NotificationHandlers.ts)
- [packages/electron/src/main/ipc/__tests__/NotificationHandlers.test.ts](../packages/electron/src/main/ipc/__tests__/NotificationHandlers.test.ts)
- [packages/electron/src/main/mcp/tools/askUserQuestionHandler.ts](../packages/electron/src/main/mcp/tools/askUserQuestionHandler.ts)
- [packages/electron/src/main/mcp/__tests__/codexQuestionDelivery.test.ts](../packages/electron/src/main/mcp/__tests__/codexQuestionDelivery.test.ts)
- [packages/electron/src/main/mcp/__tests__/interactivePromptCallLifecycle.test.ts](../packages/electron/src/main/mcp/__tests__/interactivePromptCallLifecycle.test.ts)
- [packages/electron/src/main/services/SessionReviewNotifications.ts](../packages/electron/src/main/services/SessionReviewNotifications.ts)
- [packages/electron/src/main/services/ReviewNotifyingSessionStore.ts](../packages/electron/src/main/services/ReviewNotifyingSessionStore.ts)
- [packages/electron/src/main/services/__tests__/SessionReviewNotifications.test.ts](../packages/electron/src/main/services/__tests__/SessionReviewNotifications.test.ts)
- [packages/electron/src/main/services/__tests__/ReviewNotifyingSessionStore.test.ts](../packages/electron/src/main/services/__tests__/ReviewNotifyingSessionStore.test.ts)
- [packages/electron/src/main/services/RepositoryManager.ts](../packages/electron/src/main/services/RepositoryManager.ts)
- [packages/electron/src/main/services/ai/MessageStreamingHandler.ts](../packages/electron/src/main/services/ai/MessageStreamingHandler.ts)
- [packages/electron/src/main/services/ai/__tests__/MessageStreamingHandler.externalOwnership.test.ts](../packages/electron/src/main/services/ai/__tests__/MessageStreamingHandler.externalOwnership.test.ts)
- [packages/electron/src/main/services/ai/__tests__/MessageStreamingHandler.opencodeModel.test.ts](../packages/electron/src/main/services/ai/__tests__/MessageStreamingHandler.opencodeModel.test.ts)
- [packages/electron/src/main/services/ai/claudeCliObservationSingleton.ts](../packages/electron/src/main/services/ai/claudeCliObservationSingleton.ts)
- [packages/electron/src/main/services/ai/pendingPromptPersistence.ts](../packages/electron/src/main/services/ai/pendingPromptPersistence.ts)
- [packages/electron/src/main/services/ai/__tests__/pendingPromptPersistence.test.ts](../packages/electron/src/main/services/ai/__tests__/pendingPromptPersistence.test.ts)
- [packages/electron/src/main/utils/store.ts](../packages/electron/src/main/utils/store.ts)
- [packages/electron/src/renderer/store/atoms/appSettings.ts](../packages/electron/src/renderer/store/atoms/appSettings.ts)
- [packages/electron/src/renderer/store/atoms/__tests__/settingsGranularPersist.test.ts](../packages/electron/src/renderer/store/atoms/__tests__/settingsGranularPersist.test.ts)
- [packages/electron/src/renderer/components/GlobalSettings/panels/NotificationsPanel.tsx](../packages/electron/src/renderer/components/GlobalSettings/panels/NotificationsPanel.tsx)
- [docs/FEATURE_INVENTORY.md](../docs/FEATURE_INVENTORY.md)
- [docs/SESSION_NOTIFICATIONS.md](../docs/SESSION_NOTIFICATIONS.md)
