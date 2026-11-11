import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { validateCoderGitHubAuth, type CoderGitHubAuthConfig } from '../config.js';

const run = promisify(execFile);
const platformKeys = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];
const coderKeys = ['CODER_AGENT_TOKEN', 'CODER_AGENT_URL', 'CODER_AGENT_AUTH', 'CODER_AGENT_NAME', 'CODER_AGENT_TOKEN_FILE'];
let coderConnection: Record<string, string> | undefined;

/** Host Git commands and repository hooks must never inherit the Coder connection. */
export function buildCoderServerEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(platformKeys
    .flatMap(key => source[key] === undefined ? [] : [[key, source[key]!]]));
}

/** Only the short-lived exec bridge may receive Coder connection variables. */
export function buildCoderBootstrapEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return { ...buildCoderServerEnvironment(source), ...Object.fromEntries(coderKeys
    .flatMap(key => source[key] === undefined ? [] : [[key, source[key]!]])) };
}

/** Called before importing the runner, so even its initialization subprocesses inherit only platform locations. */
export function initializeCoderEnvironment(connection: NodeJS.ProcessEnv = process.env): void {
  coderConnection = Object.fromEntries(coderKeys
    .flatMap(key => connection[key] === undefined ? [] : [[key, connection[key]!]]));
  const environment = buildCoderServerEnvironment(process.env);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
}

/** Never caches tokens or mutates process.env. Coder validates/refreshes through its workspace agent. */
export function createCoderGitHubLaunch(config: CoderGitHubAuthConfig) {
  validateCoderGitHubAuth(config);
  if (!coderConnection) throw new Error('[nimbalyst-node] Coder GitHub authentication requires the nimbalyst-coder entry point');
  const connection = coderConnection;
  return async (workspacePath: string) => {
    const [root, workspace] = await Promise.all([realpath(config.workspaceRoot), realpath(workspacePath)]);
    const relative = path.relative(root, workspace);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('[nimbalyst-node] Coder GitHub credentials are not authorized for this workspace');
    }
    const env: Record<string, string> = {};
    for (const key of platformKeys) if (process.env[key] !== undefined) env[key] = process.env[key]!;
    const providerEnv = { ...env, ...connection };
    let token: string;
    try {
      const { stdout } = await run(config.coderPath, ['external-auth', 'access-token', config.providerId], {
        env: providerEnv, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
      });
      token = stdout.trim();
      if (!token || /\s/.test(token)) throw new Error('invalid provider response');
    } catch {
      // execFile errors contain stdout/stderr. Never propagate or log them.
      throw new Error('[nimbalyst-node] Coder GitHub credential retrieval failed; check the existing workspace external-auth connection');
    }
    const [currentRoot, currentWorkspace] = await Promise.all([realpath(config.workspaceRoot), realpath(workspacePath)]);
    if (currentRoot !== root || currentWorkspace !== workspace) {
      throw new Error('[nimbalyst-node] Coder GitHub workspace changed during credential retrieval');
    }
    return {
      workspacePath: workspace,
      env: { ...env, GH_TOKEN: token },
      shellEnvironmentPolicy: {
        inherit: 'all', ignore_default_excludes: true,
        // An exact allowlist retains GH_TOKEN without exposing other secret names.
        include_only: [...platformKeys, 'GH_TOKEN'], exclude: [], set: {},
      },
    };
  };
}
