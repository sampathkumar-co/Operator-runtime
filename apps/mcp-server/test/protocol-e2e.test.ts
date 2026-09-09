import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const TOKEN = 'operator-ci-token-0123456789abcdef0123456789';
const EXPECTED_TOOLS = [
  'app.inspect',
  'app.operate',
  'browser.inspect',
  'browser.interact',
  'browser.navigate',
  'computer.inspect',
  'file.list',
  'file.read',
  'file.write',
  'git.checkpoint',
  'git.diff',
  'git.status',
  'git.write',
  'project.inspect',
  'terminal.execute'
];

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not expose an IPv4 port');
  return address.port;
}

async function reserveLoopbackPort(): Promise<number> {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try { child.kill('SIGTERM'); } catch { return; }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

async function waitForHealth(label: string, url: string, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before health became ready (exit ${child.exitCode}): ${stderr()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* startup race */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`${label} health did not become ready: ${stderr()}`);
}

async function runCommand(executable: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<CommandResult> {
  const child = spawn(executable, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-128_000); });
  child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-128_000); });
  const completed = new Promise<CommandResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
  const timedOut = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(new Error(`${path.basename(executable)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', () => clearTimeout(timer));
  });
  return Promise.race([completed, timedOut]);
}

function parseInspectorJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  try { return JSON.parse(trimmed) as Record<string, unknown>; } catch { /* try NDJSON/log-tolerant parsing below */ }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { /* next */ }
  }
  throw new Error(`MCP Inspector did not emit JSON: ${trimmed.slice(-2_000)}`);
}

test('official MCP client and Inspector traverse the real local-agent boundary while risky actions remain approval-gated', async (t) => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-agent-e2e-'));
  t.after(() => fs.rm(testRoot, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd: testRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Operator CI'], { cwd: testRoot });
  execFileSync('git', ['config', 'user.email', 'operator-ci@example.invalid'], { cwd: testRoot });
  await fs.writeFile(path.join(testRoot, 'project.txt'), 'base\n');
  execFileSync('git', ['add', 'project.txt'], { cwd: testRoot });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: testRoot, stdio: 'ignore' });

  const agentPort = await reserveLoopbackPort();
  const agentEntry = path.resolve(process.cwd(), '..', 'local-agent', 'src', 'main.ts');
  let agentStderr = '';
  const agent = spawn(process.execPath, ['--experimental-strip-types', agentEntry], {
    cwd: testRoot,
    env: {
      ...process.env,
      OPERATOR_AGENT_HOST: '127.0.0.1',
      OPERATOR_AGENT_PORT: String(agentPort),
      OPERATOR_AGENT_TOKEN: TOKEN,
      OPERATOR_ALLOWED_ROOTS: testRoot,
      OPERATOR_ALLOWED_EXECUTABLES: '',
      OPERATOR_BROWSER_AUTO_LAUNCH: '0',
      OPERATOR_CDP_ENDPOINT: 'http://127.0.0.1:1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  agent.stderr?.setEncoding('utf8');
  agent.stderr?.on('data', (chunk: string) => { agentStderr = `${agentStderr}${chunk}`.slice(-12_000); });
  t.after(() => stopChild(agent));
  await waitForHealth('local agent', `http://127.0.0.1:${agentPort}/health`, agent, () => agentStderr);

  const mcpPort = await reserveLoopbackPort();
  let mcpStderr = '';
  const mcp = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPERATOR_AGENT_URL: `http://127.0.0.1:${agentPort}`,
      OPERATOR_AGENT_TOKEN: TOKEN,
      OPERATOR_MCP_HOST: '127.0.0.1',
      OPERATOR_MCP_PORT: String(mcpPort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  mcp.stderr?.setEncoding('utf8');
  mcp.stderr?.on('data', (chunk: string) => { mcpStderr = `${mcpStderr}${chunk}`.slice(-12_000); });
  t.after(() => stopChild(mcp));

  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  await waitForHealth('MCP server', `http://127.0.0.1:${mcpPort}/health`, mcp, () => mcpStderr);

  const client = new Client(
    { name: 'operator-ci-client', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  const inspectTool = tools.tools.find((tool) => tool.name === 'computer.inspect');
  assert.equal(inspectTool?.annotations?.readOnlyHint, true);
  const checkpointTool = tools.tools.find((tool) => tool.name === 'git.checkpoint');
  assert.equal(checkpointTool?.annotations?.destructiveHint, true);
  const gitWriteTool = tools.tools.find((tool) => tool.name === 'git.write');
  assert.equal(gitWriteTool?.annotations?.destructiveHint, false);
  assert.equal(gitWriteTool?.annotations?.readOnlyHint, false);

  const result = await client.callTool({ name: 'computer.inspect', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0]?.type, 'text');
  assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /computer\.inspect: VERIFIED via system\.native/);

  const structured = result.structuredContent as Record<string, unknown> | undefined;
  assert.equal(structured?.ok, true);
  assert.equal(structured?.capability, 'computer.inspect');
  assert.equal(structured?.provider, 'system.native');
  const systemOutput = structured?.output as Record<string, unknown> | undefined;
  assert.equal(typeof systemOutput?.platform, 'string');
  assert.equal(typeof systemOutput?.arch, 'string');

  await fs.writeFile(path.join(testRoot, 'project.txt'), 'checkpoint state\n');
  const checkpointCreated = await client.callTool({
    name: 'git.checkpoint',
    arguments: { operation: 'create', cwd: testRoot, label: 'MCP E2E checkpoint' }
  });
  assert.notEqual(checkpointCreated.isError, true);
  const checkpointCreatedStructured = checkpointCreated.structuredContent as Record<string, unknown> | undefined;
  assert.equal(checkpointCreatedStructured?.ok, true);
  const checkpointOutput = checkpointCreatedStructured?.output as Record<string, unknown> | undefined;
  const checkpointId = String(checkpointOutput?.id ?? '');
  assert.match(checkpointId, /^[0-9a-f-]{36}$/i);

  await fs.writeFile(path.join(testRoot, 'project.txt'), 'new work after checkpoint\n');
  const checkpointInspected = await client.callTool({
    name: 'git.checkpoint',
    arguments: { operation: 'inspect', cwd: testRoot }
  });
  assert.notEqual(checkpointInspected.isError, true);
  const checkpointInspectedStructured = checkpointInspected.structuredContent as Record<string, unknown> | undefined;
  const inspectOutput = checkpointInspectedStructured?.output as Record<string, unknown> | undefined;
  const currentState = inspectOutput?.current as Record<string, unknown> | undefined;
  const currentFingerprint = String(currentState?.fingerprint ?? '');
  assert.match(currentFingerprint, /^[0-9a-f]{64}$/i);

  const restoreBlocked = await client.callTool({
    name: 'git.checkpoint',
    arguments: {
      operation: 'restore',
      cwd: testRoot,
      checkpointId,
      expectedCurrentFingerprint: currentFingerprint
    }
  });
  assert.equal(restoreBlocked.isError, true);
  const restoreBlockedStructured = restoreBlocked.structuredContent as Record<string, unknown> | undefined;
  assert.equal(restoreBlockedStructured?.provider, 'policy');
  const restoreBlockedError = restoreBlockedStructured?.error as Record<string, unknown> | undefined;
  assert.equal(restoreBlockedError?.code, 'APPROVAL_REQUIRED');
  assert.equal(await fs.readFile(path.join(testRoot, 'project.txt'), 'utf8'), 'new work after checkpoint\n');

  const staged = await client.callTool({
    name: 'git.write',
    arguments: {
      operation: 'stage',
      cwd: testRoot,
      paths: ['project.txt'],
      expectedCurrentFingerprint: currentFingerprint
    }
  });
  assert.notEqual(staged.isError, true);
  const stagedStructured = staged.structuredContent as Record<string, unknown> | undefined;
  assert.equal(stagedStructured?.provider, 'git.write.native');
  assert.equal(stagedStructured?.ok, true);
  assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: testRoot, encoding: 'utf8' }).trim(), 'project.txt');

  const stagedStateResult = await client.callTool({
    name: 'git.checkpoint',
    arguments: { operation: 'inspect', cwd: testRoot }
  });
  assert.notEqual(stagedStateResult.isError, true);
  const stagedStateStructured = stagedStateResult.structuredContent as Record<string, unknown> | undefined;
  const stagedInspectOutput = stagedStateStructured?.output as Record<string, unknown> | undefined;
  const stagedCurrent = stagedInspectOutput?.current as Record<string, unknown> | undefined;
  const stagedFingerprint = String(stagedCurrent?.fingerprint ?? '');
  assert.match(stagedFingerprint, /^[0-9a-f]{64}$/i);

  const committed = await client.callTool({
    name: 'git.write',
    arguments: {
      operation: 'commit',
      cwd: testRoot,
      message: 'test: MCP structured Git write',
      expectedCurrentFingerprint: stagedFingerprint
    }
  });
  assert.notEqual(committed.isError, true);
  const committedStructured = committed.structuredContent as Record<string, unknown> | undefined;
  assert.equal(committedStructured?.ok, true);
  assert.equal(committedStructured?.provider, 'git.write.native');
  assert.equal(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: testRoot, encoding: 'utf8' }).trim(), 'test: MCP structured Git write');
  assert.equal(execFileSync('git', ['status', '--porcelain=v1'], { cwd: testRoot, encoding: 'utf8' }).trim(), '');

  const browserBlocked = await client.callTool({
    name: 'browser.interact',
    arguments: {
      targetId: 'policy-test-target',
      operation: 'click',
      target: { role: 'button', name: 'Never execute' }
    }
  });
  assert.equal(browserBlocked.isError, true);
  const browserBlockedStructured = browserBlocked.structuredContent as Record<string, unknown> | undefined;
  const browserBlockedError = browserBlockedStructured?.error as Record<string, unknown> | undefined;
  assert.equal(browserBlockedError?.code, 'APPROVAL_REQUIRED');

  const inspectorHome = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-mcp-inspector-'));
  t.after(() => fs.rm(inspectorHome, { recursive: true, force: true }));
  const inspectorBinary = path.join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'mcp-inspector.cmd' : 'mcp-inspector'
  );
  const inspector = await runCommand(inspectorBinary, [
    '--cli',
    '--server-url', mcpUrl,
    '--transport', 'http',
    '--method', 'tools/list'
  ], { ...process.env, HOME: inspectorHome });
  assert.equal(inspector.code, 0, `MCP Inspector failed: ${inspector.stderr}`);
  const inspectorResult = parseInspectorJson(inspector.stdout);
  const inspectorTools = Array.isArray(inspectorResult.tools) ? inspectorResult.tools as Array<Record<string, unknown>> : [];
  assert.deepEqual(inspectorTools.map((tool) => String(tool.name ?? '')).sort(), EXPECTED_TOOLS);
});
