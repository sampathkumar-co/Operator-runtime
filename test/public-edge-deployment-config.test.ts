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
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{OPERATOR_SOURCE_COMMIT\}"/);
  assert.match(dockerfile, /org\.opencontainers\.image\.created="\$\{OPERATOR_BUILD_TIMESTAMP\}"/);
  assert.match(dockerfile, /^HEALTHCHECK .*healthcheck\.mjs"\]$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["node", "deploy\/public-edge\/supervisor\.mjs"\]$/m);
  assert.doesNotMatch(dockerfile, /^COPY PRIVACY\.md TERMS\.md SUPPORT\.md \.\/$/m);
  assert.doesNotMatch(dockerfile, /npm ci .*--include=dev/);
});

test('public-edge CI smoke verifies current Mecord Connect branding', () => {
  const workflow = text('.github/workflows/ci.yml');
  assert.match(workflow, /http:\/\/127\.0\.0\.1:47200\/ \| grep -q 'Mecord Connect'/);
  assert.doesNotMatch(workflow, /grep -q 'SPLCART Operator'/);
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
  assert.match(compose, /OPERATOR_SOURCE_COMMIT: \$\{OPERATOR_SOURCE_COMMIT:-unknown\}/);
  assert.match(compose, /OPERATOR_BUILD_TIMESTAMP: \$\{OPERATOR_BUILD_TIMESTAMP:-unknown\}/);
  assert.match(compose, /cap_drop:\r?\n\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /OPERATOR_PUBLIC_NOTICES_DIR: \/run\/operator-public-notices/);
  assert.match(compose, /source: \.\/production-notices/);
  assert.match(compose, /target: \/run\/operator-public-notices/);
  assert.match(compose, /read_only: true[\s\S]*create_host_path: false/);
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
  assert.match(supervisor, /sourceCommit, buildTimestamp/);
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
  const caddyImage = text('deploy/public-edge/caddy-image.txt').trim();
  const gitignore = text('.gitignore');
  const mcpPackage = JSON.parse(text('apps/mcp-server/package.json')) as { scripts?: Record<string, string> };
  for (const name of [
    'OPERATOR_RELAY_CONTROL_TOKEN',
    'OPERATOR_MCP_PUBLIC_URL',
    'OPERATOR_OAUTH_VERIFICATION_MODE',
    'OPERATOR_OAUTH_JWKS_URL',
    'OPERATOR_OAUTH_AUDIENCE',
    'OPERATOR_PUBLIC_NOTICES_FINAL_ACK'
  ]) assert.match(env, new RegExp(`^${name}=`, 'm'));
  assert.match(env, /replace-with-/);
  assert.match(env, /^OPERATOR_OAUTH_VERIFICATION_MODE=jwks$/m);
  assert.match(env, /^OPERATOR_OAUTH_AUDIENCE=https:\/\/mcp\.your-domain\.tld\/mcp$/m);
  assert.doesNotMatch(env, /^OPERATOR_OAUTH_AUDIENCE=operator-runtime$/m);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:47200/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8788/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8789/);
  assert.match(caddy, /@pair_claim path \/pair\/api\/claim/);
  assert.match(caddy, /@pair_claim[\s\S]*max_size 16KB[\s\S]*reverse_proxy 127\.0\.0\.1:47200/);
  for (const page of ['/', '/privacy', '/terms', '/support']) {
    assert.ok(caddy.includes(page), `Caddy ingress must expose ${page}`);
  }
  for (const route of [
    '/v1/device-result', '/v1/device-session/rotate',
    '/v1/device-enrollment/challenge', '/v1/device-enrollment/complete',
    '/v1/device-enrollment/poll', '/v1/device-self/reset'
  ]) assert.ok(caddy.includes(route), `Caddy ingress must expose ${route}`);
  assert.match(caddy, /max_header_size 32KB/);
  assert.match(caddy, /read_body 15s/);
  assert.match(caddy, /read_header 10s/);
  assert.match(caddy, /max_size 256KB/);
  assert.match(caddy, /stream_timeout 24h/);
  assert.match(caddy, /stream_close_delay 5m/);
  assert.match(caddy, /strict_sni_host on/);
  assert.match(caddy, /0rtt off/);
  assert.match(caddy, /Validated with Caddy 2\.11\.4/);
  assert.equal(caddyImage, 'caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648');
  assert.equal(mcpPackage.scripts?.['certify:oauth-provider'], 'tsx scripts/oauth-provider-preflight.ts');
  assert.equal(mcpPackage.scripts?.['certify:production-edge'], 'tsx scripts/production-edge-preflight.ts');
  assert.doesNotMatch(gitignore, /deploy\/public-edge\/production-notices/);
  assert.doesNotMatch(caddy, /8790/);
});
test('shared-VPS profile preserves the trusted ingress and Caddy exec capability contract', () => {
  const compose = text('deploy/public-edge/compose.shared-vps.example.yml');
  const caddy = text('deploy/public-edge/Caddyfile.shared-vps-internal.example');
  const privacy = text('deploy/public-edge/production-notices/privacy.md');
  const terms = text('deploy/public-edge/production-notices/terms.md');
  const support = text('deploy/public-edge/production-notices/support.md');
  assert.match(compose, /operator_ingress:\r?\n\s+ipv4_address: 172\.16\.3\.20/);
  assert.match(compose, /network_mode: service:operator-edge/);
  assert.match(compose, /image: caddy:2\.11\.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648/);
  assert.match(compose, /cap_drop:\r?\n\s+- ALL[\s\S]*cap_add:\r?\n\s+- NET_BIND_SERVICE/);
  assert.match(compose, /external: true\r?\n\s+name: operator_ingress/);
  assert.match(compose, /source: \.\/production-notices/);
  assert.match(compose, /target: \/run\/operator-public-notices/);
  assert.match(privacy, /^# Mecord Connect Privacy Notice$/m);
  assert.match(terms, /^# Mecord Connect Terms of Service$/m);
  assert.match(support, /^# Mecord Connect Support$/m);
  for (const notice of [privacy, terms, support]) assert.match(notice, /support@splcart\.in/);
  assert.doesNotMatch(compose, /ports:/);
  assert.doesNotMatch(compose, /network_mode:\s*host|privileged:\s*true/);
  assert.match(caddy, /auto_https off/);
  assert.match(caddy, /trusted_proxies static 172\.16\.3\.10\/32/);
  assert.match(caddy, /trusted_proxies_strict/);
  assert.match(caddy, /^:8080 \{/m);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:47200/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8788/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8789/);
  assert.match(caddy, /@pair_claim path \/pair\/api\/claim/);
  assert.match(caddy, /@pair_claim[\s\S]*max_size 16KB[\s\S]*reverse_proxy 127\.0\.0\.1:47200/);
  assert.doesNotMatch(caddy, /8790/);
});
