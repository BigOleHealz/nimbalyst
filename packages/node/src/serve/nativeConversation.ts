import {spawn} from 'node:child_process';
import {readdir, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import * as path from 'node:path';
import {JsonRpcClient} from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/jsonRpcClient';
import {resolveCodexBinaryPath, getCodexVendorPathEntries} from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/codexAppServerBinary';
import {buildCoderServerEnvironment} from '../host/coderGitHubAuth.js';
import type {SessionContinuation} from './sessionContinuations.js';

/** Read the provider's own lookup state, without resuming or starting a model turn. */
export async function resolveNativeConversation(entry: SessionContinuation, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (entry.provider === 'claude-code') {
    // The explicit-only runner does not pass CLAUDE_CONFIG_DIR to Claude.
    // UUID resume searches its projects store; an arbitrary JSONL is not a session.
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entry.providerSessionId!)) throw new Error('Invalid native conversation identity.');
    const root = path.join(environment.HOME || homedir(), '.claude', 'projects');
    const matches = new Set<string>();
    try {
      for (const project of await readdir(root, {withFileTypes: true})) {
        if (!project.isDirectory()) continue;
        try { matches.add(await realpath(path.join(root, project.name, `${entry.providerSessionId}.jsonl`))); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      }
    } catch { throw new Error('The native conversation is not discoverable in the runner provider state.'); }
    if (matches.size !== 1) throw new Error('The native conversation is missing or ambiguous in the runner provider state.');
    // Use the installed SDK's read-only parser, in the same filtered environment
    // as the actual Claude child. Module-level SDK config must not capture an
    // ambient CLAUDE_CONFIG_DIR that the explicit-only agent never receives.
    const runtimeRequire = createRequire(import.meta.resolve('@nimbalyst/runtime/ai/server/providers/ClaudeCodeProvider'));
    const sdk = pathToFileURL(runtimeRequire.resolve('@anthropic-ai/claude-agent-sdk')).href;
    const script = 'const sdk = await import(process.argv[1]); const info = await sdk.getSessionInfo(process.argv[2]); process.exit(info?.sessionId === process.argv[2] ? 0 : 1);';
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', script, sdk, entry.providerSessionId!], {
        env: buildCoderServerEnvironment(environment), cwd: entry.remoteWorkspacePath, stdio: 'ignore',
      });
      const fail = () => reject(new Error('The native conversation is not resumable in the runner provider state.'));
      const timer = setTimeout(() => {child.kill('SIGKILL'); fail();}, 15_000);
      child.once('error', () => {clearTimeout(timer); fail();});
      child.once('close', code => {clearTimeout(timer); if (code === 0) resolve(); else fail();});
    });
    return [...matches][0];
  }

  const binary = resolveCodexBinaryPath();
  const env = buildCoderServerEnvironment(environment);
  // A location pointer, never a credential. Coder's clean entry point already
  // removes this when the actual agent also uses the default provider home.
  if (environment.CODEX_HOME) env.CODEX_HOME = environment.CODEX_HOME;
  env.PATH = [...getCodexVendorPathEntries(binary), env.PATH ?? ''].join(path.delimiter);
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {cwd: entry.remoteWorkspacePath, env, stdio: ['pipe', 'pipe', 'pipe']});
  child.stderr.resume();
  const client = new JsonRpcClient(child, {defaultTimeoutMs: 15_000, logger: {log() {}, warn() {}}});
  try {
    await client.request('initialize', {clientInfo: {name: 'nimbalyst_continuation_preflight', version: '1'}});
    client.notify('initialized', {});
    const result = await client.request<{thread: {id: string; path: string | null}}>('thread/read', {threadId: entry.providerSessionId, includeTurns: false});
    if (result.thread?.id !== entry.providerSessionId || !result.thread.path || !path.isAbsolute(result.thread.path)) throw new Error();
    return await realpath(result.thread.path);
  } catch {
    // Provider errors and stderr may include configuration secrets. Never relay them.
    throw new Error('The native conversation is not discoverable in the runner provider state.');
  } finally {
    client.close();
    child.stdin.end();
    child.kill();
  }
}
