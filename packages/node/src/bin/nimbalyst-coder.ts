#!/usr/bin/env node
import { closeSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCoderBootstrapEnvironment, initializeCoderEnvironment } from '../host/coderGitHubAuth.js';

const connectionFd = process.env.NIMBALYST_CODER_CONNECTION_FD;
if (connectionFd === undefined) {
  // A clean exec is required: deleting process.env keys alone leaves the initial
  // environment readable in Linux /proc. Python supplies a stdlib-only anonymous
  // pipe across exec; no credential is passed in argv or written to disk.
  const execve = (process as NodeJS.Process & { execve?: (file: string, args: string[], env: Record<string, string>) => never }).execve;
  if (!execve) throw new Error('The Coder launcher requires Node >=22.15 with process.execve support');
  const bridge = `import os,json,sys
keys=['CODER_AGENT_TOKEN','CODER_AGENT_URL','CODER_AGENT_AUTH','CODER_AGENT_NAME','CODER_AGENT_TOKEN_FILE']
connection={key:os.environ[key] for key in keys if key in os.environ}
payload=json.dumps(connection).encode()
if len(payload)>4096: raise SystemExit('Coder connection exceeds bootstrap pipe limit')
reader,writer=os.pipe()
os.write(writer,payload)
os.close(writer)
os.set_inheritable(reader,True)
environment={key:value for key,value in os.environ.items() if key not in keys}
environment['NIMBALYST_CODER_CONNECTION_FD']=str(reader)
os.execve(sys.argv[1],sys.argv[1:],environment)
`;
  execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-S', '-c', bridge, process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], buildCoderBootstrapEnvironment(process.env));
}
const fd = Number(connectionFd);
if (!Number.isInteger(fd) || fd < 3) throw new Error('Invalid Coder bootstrap pipe');
let connection: NodeJS.ProcessEnv;
try { connection = JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
initializeCoderEnvironment(connection);
await import('./nimbalyst-node.js');
