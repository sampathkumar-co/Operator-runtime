import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../src/core/audit.ts';
import { DeviceIdentityStore, type DeviceSecretProtector } from '../src/core/device-identity.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { createTask } from '../src/core/task.ts';

function fakeWindowsProtector(): DeviceSecretProtector {
  const prefix = Buffer.from('operator-fake-dpapi-v1:');
  return {
    scheme: 'windows-dpapi-current-user',
    async protect(input: Buffer): Promise<Buffer> {
      return Buffer.concat([prefix, Buffer.from(input).reverse()]);
    },
    async unprotect(input: Buffer): Promise<Buffer> {
      if (input.length <= prefix.length || !input.subarray(0, prefix.length).equals(prefix)) {
        throw new Error('invalid fake DPAPI blob');
      }
      return Buffer.from(input.subarray(prefix.length)).reverse();
    }
  };
}

test('task capsules persist across store instances', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-state-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const task = createTask({ userObjective: 'ship', interpretedObjective: 'ship safely', authorizedScope: ['repo'], prohibitedScope: [], successConditions: ['tests pass'] });
  await new TaskStore(state).put(task);
  const loaded = await new TaskStore(state).get(task.id);
  assert.equal(loaded.id, task.id);
  assert.equal(loaded.userObjective, 'ship');
});

test('audit log redacts secrets recursively', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-audit-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const log = new AuditLog(state);
  await log.append({ capability: 'test', result: 'success', risk: 'read', details: { token: 'secret-value', nested: { password: 'bad' }, safe: 'ok' } });
  const [event] = await log.tail(1);
  assert.deepEqual(event.details, { token: '[REDACTED]', nested: { password: '[REDACTED]' }, safe: 'ok' });
});

test('device identity is stable and signs challenge payloads', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-id-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const store = new DeviceIdentityStore(state);
  const first = await store.loadOrCreate('Test-PC');
  const second = await store.loadOrCreate('Other-Name-Ignored');
  assert.equal(first.deviceId, second.deviceId);
  const payload = Buffer.from('pairing-challenge');
  const signature = await store.sign(payload);
  assert.equal(await store.verify(payload, signature), true);
  assert.equal(await store.verify(Buffer.from('tampered'), signature), false);
});

test('new Windows device identity persists DPAPI ciphertext and no private PEM', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-id-win-protected-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const store = new DeviceIdentityStore(state, { platform: 'win32', secretProtector: fakeWindowsProtector() });
  const identity = await store.loadOrCreate('Protected-PC');

  const raw = await fs.readFile(path.join(state, 'device-identity.json'), 'utf8');
  const persisted = JSON.parse(raw) as any;
  assert.equal(persisted.version, 2);
  assert.equal(persisted.deviceId, identity.deviceId);
  assert.equal(persisted.privateKeyProtection.scheme, 'windows-dpapi-current-user');
  assert.equal(persisted.privateKeyProtection.keyFormat, 'pkcs8-der');
  assert.equal(typeof persisted.privateKeyProtection.ciphertextBase64, 'string');
  assert.equal('privateKeyPem' in persisted, false);
  assert.doesNotMatch(raw, /BEGIN PRIVATE KEY/);

  const payload = Buffer.from('protected-pairing-challenge');
  const signature = await store.sign(payload);
  assert.equal(await store.verify(payload, signature), true);
  assert.equal(await store.verify(Buffer.from('tampered'), signature), false);
});

test('legacy Windows plaintext identity migrates to DPAPI without rotating device identity', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-id-win-migrate-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const legacy = {
    version: 1,
    deviceId: crypto.randomUUID(),
    deviceName: 'Legacy-PC',
    createdAt: '2026-09-09T00:00:00.000Z',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
  await fs.writeFile(path.join(state, 'device-identity.json'), JSON.stringify(legacy, null, 2), { mode: 0o600 });

  const store = new DeviceIdentityStore(state, { platform: 'win32', secretProtector: fakeWindowsProtector() });
  const identity = await store.loadOrCreate('Ignored-New-Name');
  assert.equal(identity.deviceId, legacy.deviceId);
  assert.equal(identity.deviceName, legacy.deviceName);
  assert.equal(identity.createdAt, legacy.createdAt);
  assert.equal(identity.publicKeyPem, legacy.publicKeyPem);

  const raw = await fs.readFile(path.join(state, 'device-identity.json'), 'utf8');
  const persisted = JSON.parse(raw) as any;
  assert.equal(persisted.version, 2);
  assert.equal(persisted.deviceId, legacy.deviceId);
  assert.equal(persisted.publicKeyPem, legacy.publicKeyPem);
  assert.equal('privateKeyPem' in persisted, false);
  assert.doesNotMatch(raw, /BEGIN PRIVATE KEY/);

  const payload = Buffer.from('migrated-pairing-challenge');
  const signature = await store.sign(payload);
  assert.equal(await store.verify(payload, signature), true);
});
