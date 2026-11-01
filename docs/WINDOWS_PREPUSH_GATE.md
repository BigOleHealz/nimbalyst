# Windows pre-push gate

Local Windows pushes now use the same quick integrity checks as macOS and Linux. Builds, full typechecks, scanner tests, Sandbox checks, and the complete unit suite run in CI rather than blocking each local push. See [Pre-push and CI validation](PREPUSH_AND_CI.md) for the current policy and optional full local command.

For historical context, the 2026-07-13 baseline full-suite command failed in these
unrelated suites: `claudeCodeEnvironment` (runtime and provider variants),
`ClaudeCliSessionLauncher`, `FileSnapshotCache`, `WorkspaceEventBus-gitignore-bypass`,
`workspaceDetection`, `ClaudeCodeProvider.bashParser`, `SafePathValidator`,
`MigrationOrchestrator.fixtureRoundtrip`, `WorkspaceEventBus-nested-gitignore`,
`ElectronFileSystemService`, `nimPreviewProtocol`, `SlashCommandService`,
`nimAssetProtocol`, `ElectronDocumentService.frontmatterCompatibility`,
`aiSettingsMerge`, `MigrationOrchestrator`, `spawnCrashDiagnostics`,
`claudeCliJsonlPath`, and `BrowserSessionHandlers`.

The former Windows-specific full-suite fallback is no longer used. Focused local test requirements and CI coverage remain in place.
