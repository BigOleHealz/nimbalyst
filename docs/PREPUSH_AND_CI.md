# Pre-push and CI validation

Local commits and pushes run quick integrity checks. Full builds, workspace typechecks, scanner regression tests, repository invariants, Sandbox artifact/image checks, and the non-provider suite run in CI for pull requests and `main`. Run focused tests for changed behavior before committing; do not repeat the full CI workload just to push or open a PR.

## Local hooks

The commit and merge-commit hooks check staged files for local-only paths and the configured commit-size limit. They do not build the app or run the full test suite. The pre-push hook retains destination restrictions, toolchain checks, fixture-author checks, outgoing commit safety, frozen-lockfile validation when manifests change, override consistency, and raw-NUL checks. Each executed stage records its elapsed seconds and exit status in `.vitest/last-prepush.json`. A push delivering no new commits skips repeated checks.

The same quick checks apply to feature branches, `main`, and tags on every platform. Type errors and failing tests can reach a branch before CI reports them; wait for green required CI checks before merging or releasing. This change does not alter repository branch-protection settings, release workflows, or the commit-approval UI in an editor.

## Full validation

The shared task inventory is [validation-inventory.mjs](../scripts/validation-inventory.mjs). Run an individual task with `node scripts/run-validation.mjs <task>`. For an optional full local run, or to investigate a CI failure:

```bash
node scripts/run-validation.mjs typecheck scripts sandbox unit
```

This rebuilds prerequisites and runs the existing validation tasks. The legacy package script names `typecheck:prepush`, `test:prepush-gate`, and `test:prepush` remain available; the Git hook no longer invokes them automatically.

- `typecheck` builds workspace prerequisites, runtime exports, and the memory engine, then discovers every workspace defining a typecheck script. CI's `typecheck-ready` runs the same discovery after its explicit workspace/runtime build or exact cache restore.
- `scripts` runs the gate's scanner and policy regression tests, including their current-repository checks, and the UI static invariants. Analytics mutations reuse one source scan instead of rescanning for each synthetic case.
- `sandbox` verifies the private Worker artifact, dependency/image pins, and TypeScript. Installation is reused only when manifests, lockfile, toolchain, and installed file content match the successful-install marker. Missing or altered files cause a real install.
- `unit-build` lists the workspace and collaboration bundle prerequisites. The built-entry store-binding test stays in the full unit suite. CI caches the bundle's JavaScript and declarations with exact source/config/dependency keys; it does not replace the smoke test with a source import.
- `unit` is the exact `test:prepush` invocation. Provider integration tests and authenticated collaborative E2E require separate environments. CI runs the non-provider suite independently of local results.
- `transcript` builds the iOS web transcript. CI also checks the output files. This does not establish native iOS or desktop startup acceptance.

## Result records

`pnpm run test:last` shows the last invocation and the separately preserved full-suite record. A focused run updates `.vitest/last-run.json` and its human-readable log without overwriting `.vitest/last-full-run.json`. Starting a full run invalidates its prior result before any tests execute; interruption and collection failures cannot leave an old success looking current.

Results retain their Git/content fingerprint so `test:last` can distinguish current evidence from a run against different source, dependency metadata, or Node/platform inputs. Local results do not replace CI checks. The old hook-specific full-suite reuse and Windows-skip policies have been removed.

Git cannot observe manual changes inside ignored root `node_modules`. After changing installed dependencies without changing a manifest/lockfile, rerun affected checks explicitly. Full local validation tests the checked-out working tree; it does not prove an alternate ref's contents.

## CI scheduling

Required job names always report. Only additions/modifications limited to root README, CHANGELOG, CONTRIBUTING, or LICENSE use the documentation-only path. General docs, package Markdown, fixtures, commands, manifests, lockfiles, scripts, workflow/config changes, deletions, and uncertain history use full validation. Renderer-only TypeScript/CSS changes may omit the independent Sandbox artifact checks; shared runtime/protocol/node inputs do not.

Superseded pull-request runs are cancelled. Main runs are retained for release consumers; release and deployment workflows are unaffected. Fork PRs need only the read-only repository token. The node_modules cache is keyed on lockfiles and patches; the runtime build cache is keyed on the runtime and extension-sdk inputs it reads. Neither is keyed on the whole tree, which would change every commit and never hit. The collaboration bundle is built every run because its inputs span several workspaces. There are no partial restore keys. Vitest's file/test counts, elapsed time, and phase summary are saved in the job summary. Phase totals are accumulated across workers, not CPU time.

Worker-count changes and CI sharding need measured latency/resource tradeoffs. This implementation does not increase concurrency, add runner spend, or remove tests based on changed filenames.

## Verify the faster local path

1. Run `node --test scripts/__tests__/prepush-test-gate.test.mjs`. The tests execute the real hook in isolated Git repositories and verify quick pushes plus safety refusals without contacting a remote.
2. After this change is committed and merged into your working branch, make a normal commit and push. Expect the quick integrity stages ending in `Quick checks passed`; the hook should not build the app, typecheck all workspaces, or launch Vitest. Timings are in `.vitest/last-prepush.json`.
3. Open the pull request and confirm the existing CI validation-selection, unit-test, typecheck, and transcript jobs run as before. General source, scripts, and workflow changes retain full validation; the existing narrow docs-only exception remains.
