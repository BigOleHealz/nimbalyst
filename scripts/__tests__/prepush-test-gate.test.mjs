import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushDeliversNewCommits } from '../prepush-test-gate.mjs';
import { commitFiles, makeScratchRepo, sandboxEnv, writeFile } from './helpers/gitSandbox.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

function hookFixture(t) {
  const { repo, git } = makeScratchRepo(t, 'nim-fast-push-');
  writeFile(repo, '.gitignore', '.vitest/\nscripts/\n.tool-bin/\n.pnpm-calls\n');
  writeFile(repo, 'package.json', JSON.stringify({ private: true, engines: { node: '>=24', pnpm: '>=12' } }));
  const base = commitFiles(repo, git, 'base', ['.gitignore', 'package.json']);
  git(['update-ref', 'refs/remotes/origin/main', base]);
  const head = commitFiles(repo, git, 'feature', ['src/feature.ts']);
  cpSync(path.join(sourceRoot, 'scripts'), path.join(repo, 'scripts'), {
    recursive: true,
    filter: (source) => path.basename(source) !== '__tests__',
  });
  const bin = path.join(repo, '.tool-bin');
  const callsFile = path.join(repo, '.pnpm-calls');
  mkdirSync(bin);
  const pnpm = path.join(bin, 'pnpm');
  writeFileSync(pnpm, `#!/bin/sh
printf '%s\\n' "$*" >> "$NIM_TEST_PNPM_CALLS"
case "$*" in
  -v) echo 12.9.1 ;;
  'install --frozen-lockfile --lockfile-only') exit "\${NIM_TEST_LOCKFILE_EXIT:-0}" ;;
  'run check:override-sync'|'run check:text-nuls --ref HEAD') exit "\${NIM_TEST_CHECK_EXIT:-0}" ;;
  *) echo "Unexpected expensive validation: $*" >&2; exit 90 ;;
esac
`);
  chmodSync(pnpm, 0o755);
  return {
    repo, git, base, head,
    calls: () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [],
    run: (extraEnv = {}, target = 'refs/heads/feature') => spawnSync('sh', [path.join(sourceRoot, '.githooks/pre-push'), 'origin', 'git@github.com:contributor/fork.git'], {
      cwd: repo,
      encoding: 'utf8',
      input: `refs/heads/feature ${git(['rev-parse', 'HEAD']).trim()} ${target} ${'0'.repeat(40)}\n`,
      env: sandboxEnv({ ...extraEnv, PATH: `${bin}${path.delimiter}${process.env.PATH}`, NIM_TEST_PNPM_CALLS: callsFile }),
    }),
  };
}

for (const target of ['refs/heads/feature', 'refs/heads/main', 'refs/tags/v1.0.0']) {
  test(`push to ${target} runs quick checks without builds or the full suite`, (t) => {
    const fixture = hookFixture(t);
    const result = fixture.run({}, target);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fixture.calls(), ['-v', 'run check:override-sync', 'run check:text-nuls --ref HEAD']);
  });
}

test('fast pushes still refuse fixture authors', (t) => {
  const fixture = hookFixture(t);
  fixture.git(['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'escaped fixture']);
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /test-fixture authors/);
  assert.deepEqual(fixture.calls(), ['-v']);
});

test('fast pushes still refuse commits carrying local-only files', (t) => {
  const fixture = hookFixture(t);
  commitFiles(fixture.repo, fixture.git, 'accidental local file', ['nimbalyst-local/private.md']);
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forbidden: nimbalyst-local\/private.md/);
  assert.deepEqual(fixture.calls(), ['-v']);
});

test('manifest changes retain frozen-lockfile validation and propagate failure', (t) => {
  const fixture = hookFixture(t);
  writeFile(fixture.repo, 'package.json', JSON.stringify({ private: true, description: 'changed' }));
  commitFiles(fixture.repo, fixture.git, 'change manifest', ['package.json']);
  const result = fixture.run({ NIM_TEST_LOCKFILE_EXIT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /out of sync/);
  assert.deepEqual(fixture.calls(), ['-v', 'install --frozen-lockfile --lockfile-only']);
});

test('quick-check failures still block the push', (t) => {
  const fixture = hookFixture(t);
  const result = fixture.run({ NIM_TEST_CHECK_EXIT: '7' });
  assert.equal(result.status, 7);
  assert.deepEqual(fixture.calls(), ['-v', 'run check:override-sync']);
});

test('destination restrictions still run before any package-manager checks', (t) => {
  const fixture = hookFixture(t);
  fixture.git(['config', 'nimbalyst.pushAllowRefs', 'refs/heads/main']);
  const result = fixture.run({ NIMBALYST_ALLOW_PUSH: '0' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not in nimbalyst.pushAllowRefs/);
  assert.deepEqual(fixture.calls(), []);
});

test('a commit already delivered to the remote does not repeat quick checks', (t) => {
  const fixture = hookFixture(t);
  fixture.git(['update-ref', 'refs/remotes/origin/feature', fixture.head]);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fixture.calls(), []);
});

const BRANCH_PUSH = 'refs/heads/main abc123 refs/heads/main def456\n';
const TAG_PUSH = `refs/tags/v0.75.1 abc123 refs/tags/v0.75.1 ${'0'.repeat(40)}\n`;

test('gates a push that delivers commits the remote lacks', () => {
  const calls = [];
  const git = (...args) => {
    calls.push(args);
    return '7\n';
  };
  assert.equal(pushDeliversNewCommits({ stdin: BRANCH_PUSH, remote: 'origin', git }), true);
  assert.deepEqual(calls, [['rev-list', '--count', 'abc123', '--not', '--remotes=origin']]);
});

test('skips the release tag push, whose commit the branch push already delivered', () => {
  const git = () => '0\n';
  assert.equal(pushDeliversNewCommits({ stdin: TAG_PUSH, remote: 'origin', git }), false);
});

test('never waves a push through on missing refs or a failing git', () => {
  const git = () => '0\n';
  // Hook run by hand with no stdin, so we cannot tell what is being pushed.
  assert.equal(pushDeliversNewCommits({ stdin: '', git }), true);
  assert.equal(
    pushDeliversNewCommits({
      stdin: BRANCH_PUSH,
      git: () => {
        throw new Error('not a git repository');
      },
    }),
    true
  );
  // A branch deletion carries no commits, so there is nothing left to gate.
  assert.equal(
    pushDeliversNewCommits({ stdin: `refs/heads/old ${'0'.repeat(40)} refs/heads/old abc123\n`, git }),
    false
  );
});
