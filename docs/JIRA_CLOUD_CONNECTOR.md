# Jira Cloud connector

Jira imports use the existing native tracker task model, external source references, importer registry, deterministic import IDs, and `handleTrackerCreate` / `handleTrackerUpdate` paths. No Jira task table, session state, kanban columns, or worktree model is introduced. The connector is registered by the Electron host using the same importer contract as extension-provided importers.

## Existing models reused

- Sessions persist in `ai_sessions`. `SessionManager` handles provider conversations; `SessionStateManager` tracks `running`, `waiting_for_input`, `idle`, and `error`. Existing central IPC listeners update renderer Jotai atoms, including processing state and pending interactive prompts.
- Tasks are `tracker_items` of type `task`. Their body uses the normal rich-content update path, which also maintains body caches, collaboration state, activity, and change events. Session links live on local task data and in session metadata; shared tasks rely on the session-side links.
- Task kanban columns come from tracker statuses. The separate session board groups root sessions by metadata phase, with workstream phases and child run states derived from existing session state.
- Worktrees are persisted checkout containers. Sessions reference them through `worktree_id`; several sessions may share one checkout.
- Extension manifests contribute editors, settings routes, tools, and backend importer modules. Jira uses `TrackerSnapshot`, the importer registry, native task persistence, and existing source chips/links rather than creating a second task system.

## Configuration and behavior

Open **Settings → Project → Jira**. Enter your Jira Cloud site origin, account email, and API token. All three connection details are encrypted with Electron `safeStorage` in the app's existing secret-file store. Secure storage must be available; the connector refuses plaintext fallback, including Linux's `basic_text` backend. API tokens are never returned by the settings IPC or written to plain settings. Blank token fields retain saved credentials; changing accounts requires entering a token again.

The credentials are app-wide. JQL and auto-sync interval are configured separately per project. Default JQL:

```jql
assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC
```

Use **Sync Jira** in project settings, or **Tracker → New menu → Sync Jira**. Search uses Jira Cloud REST v3 `POST /rest/api/3/search/jql` with `nextPageToken`. Comments are fetched separately with `startAt` pagination, since embedded issue comments may be truncated.

Each issue becomes a native task titled `KEY Summary`. Its markdown body contains the converted ADF description, a browser link to Jira, and every comment visible to your Jira account with author and creation date. Comments remain in the imported body rather than impersonating native Nimbalyst activity authors. Attachments are represented by their available ADF label/ID; attachment binaries are not downloaded.

Issue identity uses Jira site and issue key. Local Jira task IDs additionally include the project path, allowing the same issue to be imported into separate projects. Repeated imports into the same project reuse the existing task. Sync refreshes title and body while preserving native task status and session links. A task linked to any running, streaming, or waiting-for-input session is skipped entirely, including sessions in worktrees or another project. No Jira write-back occurs, and issues that stop matching JQL are not deleted or archived locally.

Auto-sync defaults to off (`0`). A positive whole number schedules sync every N minutes while the app is open, checked every 30 seconds. Schedules are restored at startup and first run after their configured interval. Concurrent manual and scheduled syncs for one project share the same in-flight operation. Last results and errors are available in project settings; a malformed or inaccessible issue does not abort subsequent issues.

## Manual acceptance test

### Context-aware agent launching

Both **Launch Session** and **Launch Worktree** prepare a draft using the current canonical tracker body and a separate read-only Jira snapshot. Launch does not sync over the tracker body, post comments, change Jira status, or submit the draft automatically. The existing provider/model, session link and workspace/worktree flows remain in use. Workspace ownership is checked again after asynchronous preparation.

The launch refresh discovers accessible fields named “Acceptance Criteria” through Jira field metadata. Project Jira settings can instead specify comma-separated field IDs for differently named or localized fields; no universal custom-field ID is assumed. Criteria in the description are always preserved. Comments are read through every accessible page, retaining successful pages if a subsequent page fails. Explicit markers distinguish empty fields, omitted/inaccessible fields, request failures, partial comments and potentially stale cached context. Jira permissions can hide content entirely; “complete” means complete for the configured Jira account.

The complete evidence packet is saved privately under the app data directory's `tracker-launch-context` folder. Its absolute path is retained in the session draft/transcript and works from a newly created worktree after restart. When evidence exceeds the 48,000-character inline budget, the draft provides the complete file and requires successive filesystem reads before implementation; no content is silently cut off. These files contain ticket content, use private filesystem permissions and are outside the repository. The local body may include the previous import plus local edits; it is labelled separately from the fresh upstream snapshot. An unavailable team body is identified as unavailable, with any local cache labelled potentially stale.

The same instructions accompany both launch modes and every provider: read repository guidance, investigate code/tests/docs and relevant authorized connected services, establish AWS account/role/region/environment from evidence, and bundle essential unresolved questions through the existing interactive tools. Optional empty fields do not force questions. Dependent changes must wait for explicit answers; cancellation, timeout, session switches and restarts do not supply answers. Durable prompt state, responses and orphaned-answer resumption use the existing interactive-prompt infrastructure. Launch instructions also require evidence for each acceptance criterion and reporting blockers before declaring completion.

For manual verification, compare a complete ticket and one with custom-field criteria against the generated draft, including a ticket with multiple comment pages. Add local tracker notes before launching and confirm they remain alongside separate upstream evidence. Exercise a network failure and an inaccessible field/comment page; verify the availability labels. Launch in each mode using each configured agent provider/model, switch projects during preparation, and confirm the originating workspace and durable tracker-session link. For a large ticket, read the final lines of the continuation file from the new worktree. Ask an essential clarification, leave it unanswered, switch sessions/restart, then cancel or answer; dependent implementation should proceed only after an explicit answer. Live Jira/provider verification requires an updated app build and authorized test connections.

1. Launch an updated development build. Main-process changes require an app restart; renderer hot reload alone does not register the new handlers.
2. Open **Settings → Project → Jira**, enter your site URL, email, and API token, and leave the default JQL and auto-sync `0`. Choose **Sync Jira**.
3. Compare the imported count and task list against the same JQL in Jira. Open several tasks, including an issue with a long formatted description and more than one page of comments. Confirm the title contains key and summary, formatting/text are preserved, every visible comment includes author/date, and the source link opens the correct Jira ticket.
4. Sync again from **Tracker → New menu → Sync Jira**. Confirm zero new imports and no duplicate tasks. Add a Jira comment or edit a Jira description, then sync again and confirm the existing task body refreshes.
5. Link an imported task to a session and start it, or leave it waiting on a question/permission. Change the Jira description and sync. Confirm the task is counted as skipped and its title/body are unchanged. End the active turn, sync again, and confirm the update appears. Repeat with a worktree session.
6. Save an invalid token and sync: expect a credential error. Restore the token, use invalid JQL: expect a JQL error. Disconnect networking and sync: expect a network error. A failed issue/comment fetch should identify the issue while allowing others to import.
7. Set auto-sync to `1`, save, leave settings, and add a matching Jira issue/comment. Keep Nimbalyst open for at least one interval plus the 30-second scheduler tick and confirm the update appears. Set `0` to disable. Restart with an enabled schedule to confirm it is restored.
8. Open a second project and sync the same account. Confirm each project has one task per matching issue, and repeat sync creates no duplicates in either project. Adjust each project's JQL to restrict imports when desired.

## Validation

- The 39 targeted connector/importer/settings tests pass.
- Workspace `pnpm typecheck` passes in all 38 packages after generating the existing runtime and memory-engine dependencies.
- Runtime and full Electron builds pass.
- The full pre-push test run passed 18,345 tests but failed 13 files because localhost listeners were sandbox-blocked, collaboration bundles had not been generated, and timing/file-watcher checks failed under load. After generating the bundles and enabling localhost access, all 13 affected files pass: 146 tests in the first recheck and two bundle-dependent tests in the second. The full suite was not repeated, following repository instructions.
- New connector code passes ESLint. Full Electron lint remains failing with 693 errors outside the new connector code, including an existing missing `react-hooks/exhaustive-deps` rule in the settings view. No broad lint cleanup is included.
- Live sync against a real Jira account is unverified; no Jira credentials were supplied during implementation.

## Changed files

- [Jira client, ADF conversion, and shared connector types](../packages/runtime/src/integrations/jira.ts)
- [Jira client tests](../packages/runtime/src/integrations/__tests__/jira.test.ts)
- [Sync coordinator](../packages/electron/src/main/services/jira/JiraSyncService.ts)
- [Sync coordinator tests](../packages/electron/src/main/services/jira/__tests__/JiraSyncService.test.ts)
- [Encrypted credentials and project settings](../packages/electron/src/main/services/jira/jiraSettings.ts)
- [Credential/settings tests](../packages/electron/src/main/services/jira/__tests__/jiraSettings.test.ts)
- [IPC, importer registration, active-session protection, and scheduler](../packages/electron/src/main/ipc/JiraHandlers.ts)
- [IPC, scheduling, and session-protection tests](../packages/electron/src/main/ipc/__tests__/JiraHandlers.test.ts)
- [Main-process registration](../packages/electron/src/main/index.ts)
- [Existing native import/refresh pipeline](../packages/electron/src/main/services/tracker/TrackerImportService.ts)
- [Import/refresh tests](../packages/electron/src/main/services/tracker/__tests__/TrackerImportService.test.ts)
- [Existing importer registry](../packages/electron/src/main/services/tracker/TrackerImporterRegistry.ts)
- [Importer registry tests](../packages/electron/src/main/services/tracker/__tests__/TrackerImporterRegistry.test.ts)
- [Jira settings UI](../packages/electron/src/renderer/components/GlobalSettings/panels/JiraPanel.tsx)
- [Jira settings UI tests](../packages/electron/src/renderer/components/GlobalSettings/panels/__tests__/JiraPanel.test.tsx)
- [Project settings route](../packages/electron/src/renderer/components/Settings/settingsRoutes.ts)
- [Settings panel routing](../packages/electron/src/renderer/components/Settings/SettingsView.tsx)
- [Project tracker sync action](../packages/electron/src/renderer/components/TrackerMode/TrackerNewMenu.tsx)
- [Feature inventory](FEATURE_INVENTORY.md)
- [Changelog](../CHANGELOG.md)
- This connector guide.
