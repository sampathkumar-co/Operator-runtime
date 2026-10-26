import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildControlCenterRuntimeStatus } from '../src/core/control-center-runtime-status.ts';
import { PRODUCT_VERSION } from '../src/core/product-identity.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

const NOW = '2026-10-25T12:10:00.000Z';

test('C10 runtime status exposes bounded source, compatibility, capability and freshness truth', () => {
  const status = buildControlCenterRuntimeStatus({
    productVersion: PRODUCT_VERSION,
    startedAt: '2026-10-25T12:00:00.000Z',
    observedAt: NOW,
    runtimeStatus: {
      packageVersion: PRODUCT_VERSION,
      sourceCommit: 'A'.repeat(40),
      relay: {
        state: 'READY', configured: true, required: true, continuity: 'automatic',
        updatedAt: '2026-10-25T12:09:30.000Z', code: 'READY'
      },
      bearer: 'must-never-project'
    },
    supportedCapabilities: ['file.read', 'browser.inspect'],
    authorizedRootCount: 2,
    settings: { browserAutoLaunch: true, postgresConfigured: false, secret: 'omit-me' }
  });
  assert.equal(status.uptimeMs, 600_000);
  assert.equal(status.product.compatibility, 'MATCH');
  assert.equal(status.product.sourceCommit, 'a'.repeat(40));
  assert.equal(status.product.sourceIdentity, 'KNOWN');
  assert.equal(status.relay.freshness, 'FRESH');
  assert.deepEqual(status.capabilities.names, ['browser.inspect', 'file.read']);
  assert.deepEqual(status.configuration.optionalFeatures, [
    { name: 'browserAutoLaunch', configured: true },
    { name: 'postgresConfigured', configured: false }
  ]);
  assert.equal(JSON.stringify(status).includes('must-never-project'), false);
  assert.equal(JSON.stringify(status).includes('omit-me'), false);
});

test('C10 runtime status labels stale/unknown evidence without fabricating source identity', () => {
  const status = buildControlCenterRuntimeStatus({
    productVersion: PRODUCT_VERSION,
    startedAt: '2026-10-25T10:00:00.000Z',
    observedAt: NOW,
    runtimeStatus: {
      packageVersion: '9.9.9', sourceCommit: 'not-a-commit',
      relay: { state: 'READY', configured: true, required: false, updatedAt: '2026-10-25T12:00:00.000Z' }
    },
    supportedCapabilities: [], authorizedRootCount: 0, settings: {}
  });
  assert.equal(status.product.compatibility, 'MISMATCH');
  assert.equal(status.product.sourceIdentity, 'UNKNOWN');
  assert.equal(status.product.sourceCommit, undefined);
  assert.equal(status.relay.freshness, 'STALE');
});

test('C10 future relay heartbeat never becomes an invented fresh observation', () => {
  const build = (updatedAt: unknown) => buildControlCenterRuntimeStatus({
    productVersion: PRODUCT_VERSION,
    startedAt: '2026-10-25T12:00:00.000Z',
    observedAt: NOW,
    runtimeStatus: { relay: { configured: true, state: 'READY', updatedAt } },
    supportedCapabilities: [], authorizedRootCount: 0
  });
  const future = build('2026-10-25T12:11:00.000Z');
  assert.equal(future.relay.state, 'READY');
  assert.equal(future.relay.freshness, 'UNKNOWN');
  assert.equal(future.relay.ageMs, undefined);
  assert.equal(future.relay.updatedAt, undefined);
  const forged = build(['2026-10-25T12:09:59.000Z']);
  assert.equal(forged.relay.freshness, 'UNKNOWN');
  const genuine = build('2026-10-25T12:09:59.000Z');
  assert.equal(genuine.relay.freshness, 'FRESH');
  assert.equal(genuine.relay.ageMs, 1000);
});

test('C10 runtime status rejects type-confused capabilities and impossible clocks', () => {
  const base = {
    productVersion: PRODUCT_VERSION,
    startedAt: '2026-10-25T12:00:00.000Z', observedAt: NOW,
    runtimeStatus: {}, authorizedRootCount: 0, settings: {}
  };
  assert.throws(() => buildControlCenterRuntimeStatus({ ...base, supportedCapabilities: ['file.read', ['browser.inspect']] }),
    /Supported capability name is invalid/);
  assert.throws(() => buildControlCenterRuntimeStatus({ ...base, startedAt: '2026-10-25T13:00:00.000Z', supportedCapabilities: [] }),
    /Runtime start cannot be after/);
});

test('C10 authenticated status route supports local browser sessions without exposing bearer authority', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c10-status-root-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const token = 's'.repeat(64);
  const sourceCommit = 'b'.repeat(40);
  const agent = createLocalAgentServer({
    runtime,
    token,
    permissions: { allowedCapabilities: ['computer.inspect', 'file.*'], allowedRoots: [root] },
    getRuntimeStatus: () => ({
      packageVersion: PRODUCT_VERSION,
      sourceCommit,
      relay: { state: 'READY', configured: true, required: true, continuity: 'automatic', updatedAt: new Date().toISOString() },
      authorization: token
    }),
    settings: { browserAutoLaunch: true, recoveryToken: token }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;

  assert.equal((await fetch(base + '/v1/control-center/status')).status, 401);
  const bearer = await fetch(base + '/v1/control-center/status', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(bearer.status, 200);
  const bearerBody = await bearer.json() as any;
  assert.equal(bearerBody.status.product.sourceCommit, sourceCommit);
  assert.equal(bearerBody.status.configuration.authorizedRootCount, 1);
  assert.ok(bearerBody.status.capabilities.count > 0);
  assert.equal(JSON.stringify(bearerBody).includes(token), false);
  assert.equal(JSON.stringify(bearerBody).includes(root), false);

  const codeResponse = await fetch(base + '/v1/control-center/browser-login/code', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }
  });
  const code = (await codeResponse.json() as any).code;
  const login = await fetch(base + '/v1/control-center/browser-login', {
    method: 'POST',
    headers: { origin: base, 'x-mecord-control-center': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!;
  const browser = await fetch(base + '/v1/control-center/status', { headers: { cookie, origin: base } });
  assert.equal(browser.status, 200);
  assert.equal((await browser.json() as any).status.product.sourceIdentity, 'KNOWN');
});

test('C10 generated dashboard includes readable runtime status without browser authority storage', async () => {
  const [runtimeScript, builder] = await Promise.all([
    fs.readFile(path.resolve('apps/control-center/src/runtime-status.js'), 'utf8'),
    fs.readFile(path.resolve('apps/control-center/scripts/build.mjs'), 'utf8')
  ]);
  assert.match(runtimeScript, /\/v1\/control-center\/status/);
  assert.match(runtimeScript, /Source commit unavailable/);
  assert.match(runtimeScript, /Supported capabilities/);
  assert.doesNotMatch(runtimeScript, /localStorage|sessionStorage/);
  assert.match(builder, /runtime-status\.js/);
});
