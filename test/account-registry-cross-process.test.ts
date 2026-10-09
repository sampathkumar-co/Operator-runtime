import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { AccountDeviceRegistry } from '../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../src/core/device-registry.ts';

const run = promisify(execFile);
const worker = fileURLToPath(new URL('./fixtures/account-registry-process-worker.mjs', import.meta.url));
async function execute(stateDir: string, operation: string, data: unknown) {
  const { stdout } = await run(process.execPath,
    ['--experimental-strip-types', worker, stateDir, operation, JSON.stringify(data)],
    { timeout: 30_000, maxBuffer: 64 * 1024 });
  return JSON.parse(stdout.trim()) as { ok: boolean; code?: string; result?: any; message?: string };
}
async function isolated(t: test.TestContext) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-account-cross-process-'));
  const identityDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-account-cross-process-key-'));
  t.after(async () => {
    await Promise.all([stateDir, identityDir].map(dir => fs.rm(dir, { force: true, recursive: true })));
  });
  const registry = new DeviceRegistryStore(stateDir);
  const accounts = new AccountDeviceRegistry(stateDir, registry);
  return { stateDir, identityDir, registry, accounts };
}

test('independent registry processes create one exact account for one principal without lost writes', async t => {
  const { stateDir, accounts } = await isolated(t);
  const principal = { issuer: 'multi-process-issuer', subject: 'same-identity' };
  const responses = await Promise.all(Array.from({ length: 4 }, () => execute(stateDir, 'resolve', principal)));
  assert.ok(responses.every(item => item.ok), JSON.stringify(responses));
  const ids = new Set(responses.map(item => item.result.accountId));
  assert.equal(ids.size, 1, 'concurrent processes must converge to a single account identity');
  assert.equal((await accounts.getAccount(principal))?.accountId, [...ids][0]);
  const stored = JSON.parse(await fs.readFile(path.join(stateDir,'account-devices.json'),'utf8'));
  assert.equal(stored.accounts.length, 1);
  assert.equal(stored.accounts[0].principalHash.length, 43);
  assert.equal(JSON.stringify(stored).includes(principal.subject), false);
});

test('independent processes racing different account binds cannot double-own one device', async t => {
  const { stateDir, identityDir, registry, accounts } = await isolated(t);
  const peer = await new DeviceIdentityStore(identityDir, { platform:'linux' }).loadOrCreate('cross-process-device');
  await registry.registerVerifiedPeer(peer);
  const a = await accounts.resolveOrCreateAccount({ issuer: 'test-issuer', subject: 'account-a' });
  const b = await accounts.resolveOrCreateAccount({ issuer: 'test-issuer', subject: 'account-b' });
  const responses = await Promise.all([
    execute(stateDir, 'bind', { accountId: a.accountId, deviceId: peer.deviceId }),
    execute(stateDir, 'bind', { accountId: b.accountId, deviceId: peer.deviceId })
  ]);
  assert.equal(responses.filter(item => item.ok).length, 1, JSON.stringify(responses));
  assert.equal(responses.filter(item => !item.ok).length, 1, JSON.stringify(responses));
  assert.equal(responses.find(item => !item.ok)?.code, 'DEVICE_ACCOUNT_CONFLICT');
  const winning = responses.find(item => item.ok)!.result;
  assert.equal(winning.authorityGeneration, 1);
  assert.equal(await accounts.ownsDevice(winning.accountId, peer.deviceId), true);
  const losingId = winning.accountId === a.accountId ? b.accountId : a.accountId;
  assert.equal(await accounts.ownsDevice(losingId, peer.deviceId), false);
  const stored = JSON.parse(await fs.readFile(path.join(stateDir,'account-devices.json'),'utf8'));
  assert.equal(stored.memberships.filter((m: any) => m.deviceId === peer.deviceId && m.status === 'active').length, 1);
});

test('disable from a second process blocks stale active authority across cold registry instances', async t => {
  const { stateDir, identityDir, registry, accounts } = await isolated(t);
  const peer = await new DeviceIdentityStore(identityDir, { platform:'linux' }).loadOrCreate('cross-process-revoked');
  await registry.registerVerifiedPeer(peer);
  const owner = await accounts.resolveOrCreateAccount({ issuer:'test-issuer',subject:'disable-owner' });
  const membership = await accounts.bindDevice(owner.accountId, peer.deviceId);
  const disabled = await execute(stateDir, 'disable', { accountId:owner.accountId, reason:'cross-process revoke' });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  const resumed = new AccountDeviceRegistry(stateDir, new DeviceRegistryStore(stateDir));
  await assert.rejects(
    resumed.withActiveAuthorityLease({
      accountId: owner.accountId, deviceId:peer.deviceId, generation:membership.authorityGeneration
    }, async () => 'should-not-execute'),
    (error: any) => error?.code === 'ACCOUNT_AUTHORITY_REVOKED'
  );
});
