import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { LocalDeviceResetCoordinator } from '../apps/local-agent/src/device-reset.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-local-device-reset-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const hostedAt = '2026-09-14T06:30:00.000Z';

async function seedAuthorityState(dir: string): Promise<void> {
  for (const name of ['relay-session-credential.json', 'relay-session.token', 'relay-client.json', 'device-sessions.json', 'device-registry.json', 'device-routing.json', 'approvals.json']) {
    await fs.writeFile(path.join(dir, name), `authority:${name}`, 'utf8');
  }
  await fs.mkdir(path.join(dir, 'relay-outbox'), { recursive: true });
  await fs.writeFile(path.join(dir, 'relay-outbox', 'relay-results.json'), 'authority:outbox', 'utf8');
}
test('local device reset revokes hosted authority before erasing local device authority and preserves user history/config', async (t) => {
  const dir = await tempDir(t);
  const identity = new DeviceIdentityStore(dir, { platform: 'linux' });
  const original = await identity.loadOrCreate('Original Device');
  await seedAuthorityState(dir);
  await fs.writeFile(path.join(dir, 'bootstrap.json'), '{"keep":true}', 'utf8');
  await fs.writeFile(path.join(dir, 'audit.ndjson'), '{"keep":"history"}\n', 'utf8');
  let hostedCalls = 0;
  let stopCalls = 0;
  const reset = new LocalDeviceResetCoordinator({
    stateDir: dir,
    identity,
    resetUrl: 'http://127.0.0.1:8789/v1/device-self/reset',
    getResetToken: async () => 'reset-token',
    stopRelay: async () => { stopCalls += 1; },
    fetchImpl: async (_url, init) => {
      hostedCalls += 1;
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer reset-token');
      return Response.json({ ok: true, reset: { status: 'complete', deviceId: original.deviceId, completedAt: hostedAt } });
    }
  });
  const result = await reset.reset();
  assert.equal(result.status, 'complete');
  assert.equal(result.hostedStatus, 'revoked');
  assert.equal(result.deviceId, original.deviceId);
  assert.equal(hostedCalls, 1);
  assert.ok(stopCalls >= 1);
  assert.equal(await identity.loadExisting(), null);
  for (const name of ['relay-session-credential.json', 'relay-session.token', 'relay-client.json', 'device-sessions.json', 'device-registry.json', 'device-routing.json', 'approvals.json', 'relay-outbox']) {
    await assert.rejects(fs.lstat(path.join(dir, name)), (error: any) => error?.code === 'ENOENT');
  }
  assert.equal(await fs.readFile(path.join(dir, 'bootstrap.json'), 'utf8'), '{"keep":true}');
  assert.equal((await fs.readFile(path.join(dir, 'audit.ndjson'), 'utf8')).includes('history'), true);
  const journalText = await fs.readFile(path.join(dir, 'local-device-reset.json'), 'utf8');
  assert.equal(journalText.includes('reset-token'), false);
  assert.equal(JSON.parse(journalText).phase, 'COMPLETE');

  const fresh = await identity.loadOrCreate('Fresh Device');
  assert.notEqual(fresh.deviceId, original.deviceId);
  assert.notEqual(fresh.publicKeyPem, original.publicKeyPem);
});
test('hosted reset failure leaves local identity and authority state untouched', async (t) => {
  const dir = await tempDir(t);
  const identity = new DeviceIdentityStore(dir, { platform: 'linux' });
  const original = await identity.loadOrCreate('Protected Device');
  await seedAuthorityState(dir);
  const reset = new LocalDeviceResetCoordinator({
    stateDir: dir,
    identity,
    resetUrl: 'http://127.0.0.1:8789/v1/device-self/reset',
    getResetToken: async () => 'reset-token',
    fetchImpl: async () => Response.json({ ok: false, error: { code: 'TEMPORARY_FAILURE' } }, { status: 503 })
  });
  await assert.rejects(reset.reset(), (error: any) => error?.code === 'TEMPORARY_FAILURE' && error?.retryable === true);
  assert.equal((await identity.loadExisting())?.deviceId, original.deviceId);
  await fs.access(path.join(dir, 'relay-session-credential.json'));
  await fs.access(path.join(dir, 'device-registry.json'));
  await assert.rejects(fs.access(path.join(dir, 'local-device-reset.json')));
});

test('reset without hosted relay authority still erases local device authority explicitly', async (t) => {
  const dir = await tempDir(t);
  const identity = new DeviceIdentityStore(dir, { platform: 'linux' });
  const original = await identity.loadOrCreate('Local Device');
  await seedAuthorityState(dir);
  const reset = new LocalDeviceResetCoordinator({ stateDir: dir, identity });
  const result = await reset.reset();
  assert.equal(result.deviceId, original.deviceId);
  assert.equal(result.hostedStatus, 'not-configured');
  assert.equal(await identity.loadExisting(), null);
});

test('local device reset API requires the separate recovery token and performs no reset on failed recovery auth', async (t) => {
  const token = 'a'.repeat(64);
  const recovery = 'r'.repeat(64);
  let resetCalls = 0;
  const agent = createLocalAgentServer({
    runtime: { execute: async () => { throw new Error('not used'); } } as any,
    token,
    recoveryToken: recovery,
    deviceReset: async () => {
      resetCalls += 1;
      return { status: 'complete', deviceId: '123e4567-e89b-42d3-a456-426614174000', hostedStatus: 'revoked', removedTargets: [] };
    },
    permissions: { allowedCapabilities: [], allowedRoots: [] }
  });
  t.after(() => agent.close());
  const { port } = await agent.listen('127.0.0.1', 0);
  const url = `http://127.0.0.1:${port}/v1/device/reset`;
  const headers = { authorization: `Bearer ${token}` };
  const missing = await fetch(url, { method: 'POST', headers });
  assert.equal(missing.status, 401);
  const wrong = await fetch(url, { method: 'POST', headers: { ...headers, 'x-operator-recovery-token': 'x'.repeat(64) } });
  assert.equal(wrong.status, 401);
  assert.equal(resetCalls, 0);
  const accepted = await fetch(url, { method: 'POST', headers: { ...headers, 'x-operator-recovery-token': recovery } });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json() as any).reset.status, 'complete');
  assert.equal(resetCalls, 1);
});
