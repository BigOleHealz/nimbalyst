/**
 * The `nimbalyst-local` server as the Claude Code plugin runs it: `nim mcp`
 * alone, bundled into plugins/nimbalyst-wiki/scripts/nim-local-mcp.mjs by
 * scripts/build-wiki-plugin.mjs, since a plugin installed from git has no
 * `npm install`. Claude Code starts it in the project directory. Codex
 * expands no variables in a plugin's MCP args, so its manifest starts the
 * server in the plugin's own directory and forwards the project as `PWD`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcp } from '../commands/mcp.js';
import { resolvePluginWorkspace } from './pluginWorkspace.js';

declare const __NIM_VERSION__: string;

// The bundle is <plugin>/scripts/nim-local-mcp.mjs.
const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workspace = resolvePluginWorkspace(process.env, process.cwd(), pluginRoot);
runMcp(__NIM_VERSION__, { noun: 'mcp', positionals: [], flags: { workspace } }).catch((err) => {
  process.stderr.write(`nimbalyst-local: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
