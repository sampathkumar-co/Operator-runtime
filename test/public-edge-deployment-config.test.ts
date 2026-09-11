import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function text(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

test('public-edge image uses patched pinned Node and a non-root read-only runtime contract', () => {
  const dockerfile = text('deploy/public-edge/Dockerfile');
  assert.match(dockerfile, /^FROM node:22\.23\.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK .*healthcheck\.mjs"\]$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["node", "deploy\/public-edge\/supervisor\.mjs"\]$/m);
  assert.doesNotMatch(dockerfile, /npm ci .*--include=dev/);
});

test('public-edge compose publishes backends only on host loopback and never publishes relay control', () => {
  const compose = text('deploy/public-edge/compose.yml');
  assert.match(compose, /127\.0\.0\.1:\$\{OPERATOR_MCP_LOOPBACK_PORT:-47200\}:47200/);
  assert.match(compose, /127\.0\.0\.1:\$\{OPERATOR_RELAY_LOOPBACK_PORT:-8788\}:8788/);
  assert.match(compose, /127\.0\.0\.1:\$\{OPERATOR_RELAY_RESULT_LOOPBACK_PORT:-8789\}:8789/);
  const ports = compose.match(/ports:\r?\n([\s\S]*?)\r?\n    volumes:/)?.[1] ?? '';
  assert.ok(ports, 'compose ports block must be found');
  assert.doesNotMatch(ports, /8790/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\r?\n\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.doesNotMatch(compose, /privileged:\s*true|network_mode:\s*host/);
});

test('public-edge supervisor shares loopback relay control and waits for both services', () => {
  const supervisor = text('deploy/public-edge/supervisor.mjs');
  assert.match(supervisor, /127\.0\.0\.1:8790\/health/);
  assert.match(supervisor, /127\.0\.0\.1:47200\/health/);
  assert.match(supervisor, /--experimental-strip-types', 'src\/main\.ts'/);
  assert.match(supervisor, /--experimental-strip-types', 'src\/server\.ts'/);
  const exitPromise = supervisor.indexOf('const exit = new Promise');
  const relayStart = supervisor.indexOf("const relay = start('relay'");
  const signalHandler = supervisor.indexOf("for (const signal of ['SIGTERM', 'SIGINT'])");
  const mcpStart = supervisor.indexOf("const mcp = start('mcp'");
  const waitForChildExit = supervisor.indexOf('const firstExit = await Promise.race');
  assert.ok(exitPromise >= 0 && exitPromise < relayStart, 'start() must register child exit before returning it');
  assert.ok(signalHandler > relayStart && signalHandler < mcpStart, 'signal handlers must be installed before MCP startup waits');
  assert.ok(waitForChildExit > mcpStart, 'supervisor must race the pre-registered child exit promises');
  assert.match(supervisor, /Promise\.race\(children\.map\(\(\{ exit \}\) => exit\)\)/);
});

test('loopback probe preserves the canonical Host header without permitting remote targets', async () => {
  const { loopbackHttpStatus } = await import('../deploy/public-edge/http-probe.mjs');
  let observedHost = '';
  const server = createServer((request, response) => {
    observedHost = request.headers.host ?? '';
    response.writeHead(200).end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const status = await loopbackHttpStatus(`http://127.0.0.1:${address.port}/health`, {
      headers: { host: 'edge.operator-runtime.dev' }
    });
    assert.equal(status, 200);
    assert.equal(observedHost, 'edge.operator-runtime.dev');
    await assert.rejects(() => loopbackHttpStatus('http://example.com/health'), /127\.0\.0\.1/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('public-edge deployment templates contain routes but no committed credentials', () => {
  const env = text('deploy/public-edge/operator-edge.env.example');
  const caddy = text('deploy/public-edge/Caddyfile.example');
  for (const name of [
    'OPERATOR_RELAY_CONTROL_TOKEN',
    'OPERATOR_MCP_PUBLIC_URL',
    'OPERATOR_OAUTH_INTROSPECTION_CLIENT_SECRET'
  ]) assert.match(env, new RegExp(`^${name}=`, 'm'));
  assert.match(env, /replace-with-/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:47200/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8788/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8789/);
  assert.doesNotMatch(caddy, /8790/);
});