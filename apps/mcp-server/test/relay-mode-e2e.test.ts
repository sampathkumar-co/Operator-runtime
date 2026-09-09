import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ActionRequest, ActionResult } from '../../../src/core/types.ts';

const CONTROL_TOKEN = 'relay-control-ci-0123456789abcdef0123456789';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_KEY = 'ci-project';
const EXPECTED_TOOLS = [
  'app.inspect', 'app.operate', 'browser.inspect', 'browser.interact', 'browser.navigate',
  'computer.inspect', 'docker.inspect', 'docker.manage', 'file.list', 'file.read', 'file.write',
  'git.checkpoint', 'git.diff', 'git.status', 'git.write', 'postgres.query', 'project.command',
  'project.inspect', 'project.transaction', 'terminal.execute', 'vscode.inspect', 'vscode.open'
];

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve loopback port');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not expose port');
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try { child.kill('SIGTERM'); } catch { return; }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null) try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

async function waitForHealth(url: string, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MCP server exited before health: ${stderr()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* startup race */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`MCP relay-mode health timed out: ${stderr()}`);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function runInspector(mcpUrl: string, home: string): Promise<Record<string, unknown>> {
  const binary = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'mcp-inspector.cmd' : 'mcp-inspector');
  const child = spawn(binary, ['--cli', '--server-url', mcpUrl, '--transport', 'http', '--method', 'tools/list'], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, `MCP Inspector relay mode failed: ${stderr}`);
  const trimmed = stdout.trim();
  try { return JSON.parse(trimmed) as Record<string, unknown>; } catch { /* NDJSON fallback */ }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { /* next */ }
  }
  throw new Error(`Inspector did not emit JSON: ${trimmed.slice(-2000)}`);
}

test('official MCP client and Inspector execute through relay control mode with unchanged tool schemas', async (t) => {
  const seen: Array<{ accountId: string; deviceId?: string; projectKey?: string; action: ActionRequest }> = [];
  const control = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/v1/execute') return send(res, 404, { ok: false });
    assert.equal(req.headers.authorization, `Bearer ${CONTROL_TOKEN}`);
    const body = await readBody(req);
    assert.equal(body.accountId, ACCOUNT_ID);
    assert.equal(body.deviceId, DEVICE_ID);
    assert.equal(body.projectKey, PROJECT_KEY);
    const action = body.action as ActionRequest;
    seen.push({ accountId: body.accountId, deviceId: body.deviceId, projectKey: body.projectKey, action });
    const result: ActionResult = action.capability === 'browser.interact'
      ? {
          ok: false,
          capability: action.capability,
          provider: 'policy',
          evidence: [{ kind: 'policy', status: 'fail', message: 'approval required', timestamp: new Date().toISOString() }],
          error: { code: 'APPROVAL_REQUIRED', message: 'External action requires approval.', retryable: false },
          durationMs: 1
        }
      : {
          ok: true,
          capability: action.capability,
          provider: 'relay-ci-device',
          output: { remote: true, deviceId: DEVICE_ID },
          evidence: [{ kind: 'relay-ci', status: 'pass', message: 'remote result persisted', timestamp: new Date().toISOString() }],
          durationMs: 2
        };
    return send(res, 200, result);
  });
  const controlPort = await listen(control);
  t.after(() => new Promise<void>((resolve) => control.close(() => resolve())));

  const mcpPort = await reservePort();
  let stderr = '';
  const mcp = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPERATOR_EXECUTION_MODE: 'relay',
      OPERATOR_AGENT_TOKEN: CONTROL_TOKEN,
      OPERATOR_RELAY_CONTROL_TOKEN: CONTROL_TOKEN,
      OPERATOR_RELAY_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
      OPERATOR_RELAY_ACCOUNT_ID: ACCOUNT_ID,
      OPERATOR_RELAY_DEVICE_ID: DEVICE_ID,
      OPERATOR_RELAY_PROJECT_KEY: PROJECT_KEY,
      OPERATOR_MCP_HOST: '127.0.0.1',
      OPERATOR_MCP_PORT: String(mcpPort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  mcp.stderr?.setEncoding('utf8');
  mcp.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-12000); });
  t.after(() => stopChild(mcp));

  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  await waitForHealth(`http://127.0.0.1:${mcpPort}/health`, mcp, () => stderr);
  const client = new Client({ name: 'operator-relay-mode-ci', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);

  const inspect = await client.callTool({ name: 'computer.inspect', arguments: {} });
  assert.notEqual(inspect.isError, true);
  const inspectResult = inspect.structuredContent as Record<string, unknown>;
  assert.equal(inspectResult.provider, 'relay-ci-device');
  assert.deepEqual(inspectResult.output, { remote: true, deviceId: DEVICE_ID });

  const blocked = await client.callTool({
    name: 'browser.interact',
    arguments: { targetId: 'remote-target', operation: 'click', target: { role: 'button', name: 'External action' } }
  });
  assert.equal(blocked.isError, true);
  const blockedResult = blocked.structuredContent as Record<string, unknown>;
  assert.equal(blockedResult.provider, 'policy');
  assert.equal((blockedResult.error as Record<string, unknown>)?.code, 'APPROVAL_REQUIRED');
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.action.provenance.kind, 'chatgpt');
  assert.equal(seen[1]?.action.risk, 'external');

  const inspectorHome = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-mcp-relay-inspector-'));
  t.after(() => fs.rm(inspectorHome, { recursive: true, force: true }));
  const inspector = await runInspector(mcpUrl, inspectorHome);
  const inspectorTools = Array.isArray(inspector.tools) ? inspector.tools as Array<Record<string, unknown>> : [];
  assert.deepEqual(inspectorTools.map((tool) => String(tool.name ?? '')).sort(), EXPECTED_TOOLS);
});
