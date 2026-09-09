import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
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
  'git.diff',
  'git.status',
  'project.inspect',
  'terminal.execute'
];

type ObservedAction = {
  capability?: string;
  risk?: string;
  input?: Record<string, unknown>;
  provenance?: { kind?: string };
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

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
}

async function waitForHealth(url: string, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`MCP server exited before health became ready (exit ${child.exitCode}): ${stderr()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* startup race */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`MCP server health did not become ready: ${stderr()}`);
}

test('official MCP v2 client initializes, lists Operator tools, and executes a read tool through the local agent', async (t) => {
  const observed: ObservedAction[] = [];
  const agent = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/execute') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { action?: ObservedAction };
    const action = body.action ?? {};
    observed.push(action);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      capability: action.capability,
      provider: 'fake.local-agent',
      output: { os: 'ci-test', bounded: true },
      evidence: [{ kind: 'fake_agent', status: 'pass', message: 'CI local-agent boundary reached.', details: {} }],
      durationMs: 1
    }));
  });
  const agentPort = await listen(agent);
  t.after(() => closeServer(agent));

  const mcpPort = await reserveLoopbackPort();
  let stderr = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
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
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  t.after(() => stopChild(child));

  await waitForHealth(`http://127.0.0.1:${mcpPort}/health`, child, () => stderr);

  const client = new Client(
    { name: 'operator-ci-client', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`));
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  const inspectTool = tools.tools.find((tool) => tool.name === 'computer.inspect');
  assert.equal(inspectTool?.annotations?.readOnlyHint, true);

  const result = await client.callTool({ name: 'computer.inspect', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0]?.type, 'text');
  assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /computer\.inspect: VERIFIED via fake\.local-agent/);

  const structured = result.structuredContent as Record<string, unknown> | undefined;
  assert.equal(structured?.ok, true);
  assert.equal(structured?.capability, 'computer.inspect');
  assert.equal(structured?.provider, 'fake.local-agent');
  assert.deepEqual(structured?.output, { os: 'ci-test', bounded: true });

  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.capability, 'computer.inspect');
  assert.equal(observed[0]?.risk, 'read');
  assert.deepEqual(observed[0]?.input, {});
  assert.equal(observed[0]?.provenance?.kind, 'chatgpt');
});
