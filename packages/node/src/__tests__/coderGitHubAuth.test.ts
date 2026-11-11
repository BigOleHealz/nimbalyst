// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCoderServerEnvironment, createCoderGitHubLaunch, initializeCoderEnvironment } from '../host/coderGitHubAuth.js';
import { prepareSessionWorkspace } from '../serve/repoCheckout.js';

const directories: string[] = [];
let originalEnvironment: NodeJS.ProcessEnv;
beforeEach(() => { originalEnvironment = { ...process.env }; });
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(fail = false, delayed = false) {
  const directory = await mkdtemp(join(tmpdir(), 'coder-github-test-'));
  directories.push(directory);
  const root = join(directory, 'workspace');
  const session = join(root, 'session');
  await mkdir(session, { recursive: true });
  const coderPath = join(directory, 'coder');
  const calls = join(directory, 'calls');
  const gate = join(directory, 'continue');
  await writeFile(coderPath, `#!/bin/sh
test "$1/$2/$3" = external-auth/access-token/github || exit 3
test -n "$CODER_AGENT_TOKEN" || exit 4
test -z "$UNRELATED_SECRET$OPENAI_API_KEY$GH_TOKEN" || exit 5
echo called >> '${calls}'
${delayed ? `while [ ! -f '${gate}' ]; do sleep 0.01; done` : ''}
${fail ? 'echo fixture-secret >&2; echo fixture-secret; exit 1' : `count=$(wc -l < '${calls}'); printf 'fixture-github-%d\\n' "$count"`}
`, { mode: 0o700 });
  vi.stubEnv('CODER_AGENT_TOKEN', 'fixture-coder-secret');
  vi.stubEnv('UNRELATED_SECRET', 'fixture-unrelated-secret');
  vi.stubEnv('OPENAI_API_KEY', 'fixture-provider-key');
  vi.stubEnv('GH_TOKEN', 'stale-host-token');
  initializeCoderEnvironment();
  return { root, session, calls, gate, prepare: createCoderGitHubLaunch({ coderPath, providerId: 'github', workspaceRoot: root }) };
}

it('keeps Coder connection credentials out of the ambient server environment even without GitHub opt-in', () => {
  expect(buildCoderServerEnvironment({ HOME: '/home/agent', PATH: '/bin', CODER_AGENT_URL: 'https://coder.test', CODER_AGENT_TOKEN: 'fixture-connection',
    GH_TOKEN: 'stale', GITHUB_TOKEN: 'stale', OPENAI_API_KEY: 'other-account', UNRELATED_SECRET: 'private' }))
    .toEqual({ HOME: '/home/agent', PATH: '/bin' });
});

it('boots with a clean initial OS environment and retrieves Coder credentials only through the closed bootstrap pipe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coder-bootstrap-'));
  directories.push(directory);
  await mkdir(join(directory, 'bin')); await mkdir(join(directory, 'host'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  // The credential-bearing Python bridge must not import repository modules or
  // user/site startup hooks before it replaces itself with the clean runner.
  await writeFile(join(directory, 'json.py'), 'raise SystemExit(42)\n');
  await writeFile(join(directory, 'sitecustomize.py'), 'raise SystemExit(43)\n');
  for (const relative of ['bin/nimbalyst-coder', 'host/coderGitHubAuth', 'config']) {
    const source = await readFile(new URL(`../${relative}.ts`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    await writeFile(join(directory, relative + '.js'), compiled);
  }
  const coderPath = join(directory, 'coder');
  await writeFile(coderPath, '#!/bin/sh\ntest "$CODER_AGENT_TOKEN" = fixture-bootstrap-connection || exit 1\necho fixture-refreshed-github\n', { mode: 0o700 });
  await writeFile(join(directory, 'bin/nimbalyst-node.js'), `
import fs from 'node:fs';
import {createCoderGitHubLaunch} from '../host/coderGitHubAuth.js';
const initial = process.platform === 'linux' ? fs.readFileSync('/proc/self/environ', 'utf8') : '';
const launch = await createCoderGitHubLaunch(${JSON.stringify({coderPath, providerId:'github',workspaceRoot:directory})})(${JSON.stringify(directory)});
console.log(JSON.stringify({ambientConnection:!!process.env.CODER_AGENT_TOKEN,ambientOtherSecret:!!process.env.UNRELATED_SECRET,
initialSecret:initial.includes('fixture-bootstrap-connection')||initial.includes('fixture-unrelated-bootstrap'),pipeMarkerPresent:!!process.env.NIMBALYST_CODER_CONNECTION_FD,
privateConnectionWorked:launch.env.GH_TOKEN==='fixture-refreshed-github',childCoderCredential:!!launch.env.CODER_AGENT_TOKEN}));
`);
  const output = execFileSync(process.execPath, [join(directory, 'bin/nimbalyst-coder.js')], { encoding: 'utf8', cwd: directory,
    env: {HOME:process.env.HOME,PATH:process.env.PATH,CODER_AGENT_TOKEN:'fixture-bootstrap-connection',CODER_AGENT_URL:'https://coder.test',UNRELATED_SECRET:'fixture-unrelated-bootstrap'} });
  expect(JSON.parse(output)).toEqual({ambientConnection:false,ambientOtherSecret:false,initialSecret:false,pipeMarkerPresent:false,privateConnectionWorked:true,childCoderCredential:false});
});

it('refreshes from the supported Coder command on every launch without changing the host or exposing its credentials', async () => {
  const f = await fixture();
  const first = await f.prepare(f.session), second = await f.prepare(f.session);
  expect(first.env.GH_TOKEN).toBe('fixture-github-1');
  expect(second.env.GH_TOKEN).toBe('fixture-github-2');
  expect(first.env).not.toHaveProperty('CODER_AGENT_TOKEN');
  expect(first.env).not.toHaveProperty('UNRELATED_SECRET');
  expect(first.env).not.toHaveProperty('OPENAI_API_KEY');
  expect(process.env.GH_TOKEN).toBeUndefined();
  expect(process.env.CODER_AGENT_TOKEN).toBeUndefined();
  expect(first.workspacePath).toBe(await realpath(f.session));
  expect(second.shellEnvironmentPolicy).toMatchObject({ ignore_default_excludes: true, include_only: expect.arrayContaining(['GH_TOKEN', 'PATH', 'HOME']) });
  expect(JSON.stringify(second.shellEnvironmentPolicy)).not.toContain(second.env.GH_TOKEN);
});

it('does not expose Coder credentials to an actual repository post-checkout hook', async () => {
  const f = await fixture();
  const repository = join(f.root, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', '-q', repository]);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']);
  const hookResult = join(f.root, 'hook-presence');
  await writeFile(join(repository, '.git/hooks/post-checkout'), `#!/bin/sh\nif [ -n "$CODER_AGENT_TOKEN$CODER_AGENT_URL$GH_TOKEN$OPENAI_API_KEY" ]; then echo present; else echo absent; fi > '${hookResult}'\n`, { mode: 0o700 });
  await prepareSessionWorkspace({projectId:'fixture',repoUrl:'https://github.com/fixture/repo.git',branch:'main',checkoutDir:repository,sessionWorktrees:true}, 'auth-test', {checkoutRoot:f.root});
  expect((await readFile(hookResult, 'utf8')).trim()).toBe('absent');
  expect((await f.prepare(f.session)).env.GH_TOKEN).toBe('fixture-github-1');
});

it('rejects a workspace symlink changed while Coder retrieves credentials', async () => {
  const f = await fixture(false, true);
  const alias = join(f.root, 'alias'), outside = f.root + '-outside';
  await mkdir(outside); await symlink(f.session, alias);
  const pending = f.prepare(alias);
  const rejected = expect(pending).rejects.toThrow(/workspace changed/);
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await readFile(f.calls).then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await unlink(alias); await symlink(outside, alias); await writeFile(f.gate, 'continue');
  await rejected;
});

it('fails closed when Coder GitHub authentication is configured without the dedicated entry point', async () => {
  vi.resetModules();
  const fresh = await import('../host/coderGitHubAuth.js');
  expect(() => fresh.createCoderGitHubLaunch({coderPath:'/usr/bin/coder',providerId:'github',workspaceRoot:'/workspace/foss'})).toThrow(/entry point/);
});

it('rejects a different project, a prefix sibling, and a symlink escape before fetching credentials', async () => {
  const f = await fixture();
  const sibling = f.root + '-other';
  await mkdir(sibling);
  const escape = join(f.root, 'escape');
  await symlink(sibling, escape);
  for (const workspace of [tmpdir(), sibling, escape]) await expect(f.prepare(workspace)).rejects.toThrow(/not authorized/);
  await expect(readFile(f.calls)).rejects.toThrow(/ENOENT/);
});

it('fails closed and discards provider stdout/stderr instead of leaking credentials or using the stale host token', async () => {
  const f = await fixture(true);
  const error = await f.prepare(f.session).catch(error => error);
  expect(error.message).toMatch(/credential retrieval failed/);
  expect(error.message).not.toContain('fixture-secret');
  expect(error).not.toHaveProperty('stdout');
  expect(error).not.toHaveProperty('stderr');
});
