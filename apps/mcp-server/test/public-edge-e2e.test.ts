import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port unavailable');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 1500))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function request(port: number, path: string, options: { method?: string; host?: string; origin?: string; body?: string } = {}) {
  return await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path,
      method: options.method ?? 'GET',
      headers: {
        host: options.host ?? 'edge.operator-runtime.dev',
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(options.body) } : {})
      }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.once('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitForHealth(port: number, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`public edge exited early: ${stderr()}`);
    try {
      const response = await request(port, '/health');
      if (response.status === 200) return;
    } catch { /* startup race */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`public edge health timeout: ${stderr()}`);
}

test('public MCP edge serves OAuth metadata and challenges unauthenticated callers', async (t) => {
  const port = await reservePort();
  let stderr = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPERATOR_EXECUTION_MODE: 'relay',
      OPERATOR_RELAY_CONTROL_TOKEN: 'relay-control-token-0123456789abcdef',
      OPERATOR_MCP_PUBLIC_EDGE: '1',
      OPERATOR_MCP_PUBLIC_BIND_ACK: 'TLS_TERMINATES_UPSTREAM',
      OPERATOR_MCP_PUBLIC_URL: 'https://edge.operator-runtime.dev/mcp',
      OPERATOR_MCP_HOST: '127.0.0.1',
      OPERATOR_MCP_PORT: String(port),
      OPERATOR_OAUTH_ISSUER: 'https://login.operator-runtime.dev',
      OPERATOR_OAUTH_AUTHORIZATION_URL: 'https://login.operator-runtime.dev/authorize',
      OPERATOR_OAUTH_TOKEN_URL: 'https://login.operator-runtime.dev/token',
      OPERATOR_OAUTH_INTROSPECTION_URL: 'https://login.operator-runtime.dev/introspect',
      OPERATOR_OAUTH_AUDIENCE: 'operator-runtime',
      OPERATOR_OAUTH_INTROSPECTION_CLIENT_ID: 'operator-edge',
      OPERATOR_OAUTH_INTROSPECTION_CLIENT_SECRET: 'test-secret-not-production'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  t.after(() => stop(child));
  await waitForHealth(port, child, () => stderr);

  const metadata = await request(port, '/.well-known/oauth-protected-resource/mcp');
  assert.equal(metadata.status, 200, metadata.body);
  const document = JSON.parse(metadata.body) as Record<string, unknown>;
  assert.equal(document.resource, 'https://edge.operator-runtime.dev/mcp');
  assert.deepEqual(document.authorization_servers, ['https://login.operator-runtime.dev/']);

  const challenge = await request(port, '/mcp', { method: 'POST', body: '{}' });
  assert.equal(challenge.status, 401, challenge.body);
  assert.match(String(challenge.headers['www-authenticate'] ?? ''), /invalid_token/);
  assert.match(String(challenge.headers['www-authenticate'] ?? ''), /oauth-protected-resource/);
  const wrongHost = await request(port, '/mcp', { method: 'POST', host: 'evil.operator-runtime.dev', body: '{}' });
  assert.ok(wrongHost.status >= 400);
  assert.notEqual(wrongHost.status, 401);

  const wrongOrigin = await request(port, '/mcp', {
    method: 'POST',
    origin: 'https://evil.operator-runtime.dev',
    body: '{}'
  });
  assert.ok(wrongOrigin.status >= 400);
  assert.notEqual(wrongOrigin.status, 401);
});
