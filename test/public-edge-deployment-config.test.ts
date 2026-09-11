import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const ports = compose.match(/ports:\n([\s\S]*?)\n    volumes:/)?.[1] ?? '';
  assert.doesNotMatch(ports, /8790/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.doesNotMatch(compose, /privileged:\s*true|network_mode:\s*host/);
});

test('public-edge supervisor shares loopback relay control and waits for both services', () => {
  const supervisor = text('deploy/public-edge/supervisor.mjs');
  assert.match(supervisor, /127\.0\.0\.1:8790\/health/);
  assert.match(supervisor, /127\.0\.0\.1:47200\/health/);
  assert.match(supervisor, /--experimental-strip-types', 'src\/main\.ts'/);
  assert.match(supervisor, /--experimental-strip-types', 'src\/server\.ts'/);
  const signalHandler = supervisor.indexOf("for (const signal of ['SIGTERM', 'SIGINT'])");
  const waitForChildExit = supervisor.indexOf('const firstExit = await Promise.race');
  assert.ok(signalHandler >= 0 && waitForChildExit > signalHandler, 'signal handlers must be installed before waiting on child exit');
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