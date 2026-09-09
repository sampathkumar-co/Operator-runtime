import path from 'node:path';
import { createRuntime } from './runtime-factory.ts';
import { createLocalAgentServer } from './server.ts';

const allowedRoots = (process.env.OPERATOR_ALLOWED_ROOTS ?? process.cwd())
  .split(path.delimiter)
  .filter(Boolean)
  .map((root) => path.resolve(root));

const allowedExecutables = (process.env.OPERATOR_ALLOWED_EXECUTABLES ?? 'git,node,npm,npx,pnpm,python,python3')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const token = process.env.OPERATOR_AGENT_TOKEN;
if (!token || token.length < 32) {
  console.error('[operator] OPERATOR_AGENT_TOKEN must be set to a secret of at least 32 characters.');
  process.exit(2);
}

const runtime = createRuntime({
  allowedRoots,
  allowedExecutables,
  projectCommandRegistryPath: process.env.OPERATOR_PROJECT_COMMAND_REGISTRY,
  dockerExecutable: process.env.OPERATOR_DOCKER_PATH,
  postgresProfileRegistryPath: process.env.OPERATOR_POSTGRES_PROFILE_REGISTRY,
  psqlExecutable: process.env.OPERATOR_PSQL_PATH,
  vscodeExecutable: process.env.OPERATOR_VSCODE_PATH,
  vscodeDataDir: process.env.OPERATOR_VSCODE_DATA_DIR,
  cdpEndpoint: process.env.OPERATOR_CDP_ENDPOINT,
  browserAutoLaunch: process.env.OPERATOR_BROWSER_AUTO_LAUNCH !== '0',
  browserPath: process.env.OPERATOR_BROWSER_PATH,
  browserDataDir: process.env.OPERATOR_BROWSER_DATA_DIR,
  windowsUiaPath: process.env.OPERATOR_WINDOWS_UIA_PATH
});

const agent = createLocalAgentServer({
  runtime,
  token,
  permissions: {
    allowedCapabilities: ['computer.inspect', 'project.inspect', 'project.command.*', 'project.transaction.*', 'docker.*', 'postgres.*', 'vscode.*', 'file.*', 'git.*', 'terminal.execute', 'browser.inspect', 'browser.navigate', 'browser.interact', 'app.inspect', 'app.operate'],
    allowedRoots,
    allowExternalWrites: false,
    allowSystemChanges: false,
    allowDestructive: false
  }
});

const host = process.env.OPERATOR_AGENT_HOST ?? '127.0.0.1';
const port = Number(process.env.OPERATOR_AGENT_PORT ?? 47100);
const bound = await agent.listen(host, port);
console.error(`[operator] local agent listening on http://${bound.host}:${bound.port}`);
console.error(`[operator] authorized roots: ${allowedRoots.join(', ')}`);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.allSettled([agent.close(), runtime.close()]);
    process.exit(0);
  });
}
