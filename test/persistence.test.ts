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

async function tempState(t: test.TestContext, prefix: string): Promise<string> {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  return state;
}

test('task capsules persist across store instances', async (t) => {
  const state = await tempState(t, 'operator-state-');
  const task = createTask({ userObjective: 'ship', interpretedObjective: 'ship safely', authorizedScope: ['repo'], prohibitedScope: [], successConditions: ['tests pass'] });
  await new TaskStore(state).put(task);
  const loaded = await new TaskStore(state).get(task.id);
  assert.equal(loaded.id, task.id);
  assert.equal(loaded.userObjective, 'ship');
});

test('audit log redacts secrets recursively and persists a verified hash-chain head', async (t) => {
  const state = await tempState(t, 'operator-audit-');
  const log = new AuditLog(state);
  const appended = await log.append({ capability: 'test', result: 'success', risk: 'read', details: { token: 'secret-value', nested: { password: 'bad' }, safe: 'ok' } });
  const [event] = await log.tail(1);
  assert.deepEqual(event.details, { token: '[REDACTED]', nested: { password: '[REDACTED]' }, safe: 'ok' });
  assert.equal(event.chainVersion, 1);
  assert.equal(event.previousHash, null);
  assert.match(String(event.hash), /^[0-9a-f]{64}$/);
  assert.equal(event.hash, appended.hash);
  const integrity = await log.verifyIntegrity();
  assert.deepEqual(integrity, { valid: true, count: 1, headHash: event.hash });
  const head = JSON.parse(await fs.readFile(path.join(state, 'audit-head.json'), 'utf8')) as any;
  assert.equal(head.count, 1);
  assert.equal(head.headHash, event.hash);
});

test('audit chain detects modification of an earlier record', async (t) => {
  const state = await tempState(t, 'operator-audit-tamper-');
  const log = new AuditLog(state);
  await log.append({ capability: 'one', result: 'success', risk: 'read' });
  await log.append({ capability: 'two', result: 'success', risk: 'read' });
  await log.append({ capability: 'three', result: 'success', risk: 'read' });

  const file = path.join(state, 'audit.ndjson');
  const records = (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  records[1].capability = 'forged-two';
  await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  await assert.rejects(
    () => new AuditLog(state).tail(10),
    (error: any) => error?.code === 'AUDIT_INTEGRITY_FAILED' && /hash verification failed/.test(error.message)
  );
});

test('audit head detects tail truncation and refuses to bless the shorter chain', async (t) => {
  const state = await tempState(t, 'operator-audit-truncate-');
  const log = new AuditLog(state);
  await log.append({ capability: 'one', result: 'success', risk: 'read' });
  await log.append({ capability: 'two', result: 'success', risk: 'read' });

  const file = path.join(state, 'audit.ndjson');
  const [first] = (await fs.readFile(file, 'utf8')).trim().split('\n');
  await fs.writeFile(file, `${first}\n`);

  await assert.rejects(
    () => new AuditLog(state).verifyIntegrity(),
    (error: any) => error?.code === 'AUDIT_INTEGRITY_FAILED' && /head metadata disagree/.test(error.message)
  );
});

test('audit head repairs only the one-record append-before-head crash window', async (t) => {
  const state = await tempState(t, 'operator-audit-repair-');
  const log = new AuditLog(state);
  const first = await log.append({ capability: 'one', result: 'success', risk: 'read' });
  const second = await log.append({ capability: 'two', result: 'success', risk: 'read' });

  await fs.writeFile(path.join(state, 'audit-head.json'), `${JSON.stringify({
    version: 1,
    count: 1,
    headHash: first.hash,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`);

  const integrity = await new AuditLog(state).verifyIntegrity();
  assert.deepEqual(integrity, { valid: true, count: 2, headHash: second.hash });
  const repaired = JSON.parse(await fs.readFile(path.join(state, 'audit-head.json'), 'utf8')) as any;
  assert.equal(repaired.count, 2);
  assert.equal(repaired.headHash, second.hash);
});

test('legacy unchained audit records migrate atomically before the next append', async (t) => {
  const state = await tempState(t, 'operator-audit-migrate-');
  const legacy = [
    { id: 'legacy-1', timestamp: '2026-09-01T00:00:00.000Z', capability: 'old.one', result: 'success', risk: 'read' },
    { id: 'legacy-2', timestamp: '2026-09-01T00:01:00.000Z', capability: 'old.two', result: 'blocked', risk: 'external' }
  ];
  await fs.writeFile(path.join(state, 'audit.ndjson'), `${legacy.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 });

  const log = new AuditLog(state);
  await log.append({ capability: 'new.three', result: 'success', risk: 'read' });
  const events = await log.tail(10);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.capability), ['old.one', 'old.two', 'new.three']);
  for (const event of events) {
    assert.equal(event.chainVersion, 1);
    assert.match(String(event.hash), /^[0-9a-f]{64}$/);
  }
  assert.equal(events[0].previousHash, null);
  assert.equal(events[1].previousHash, events[0].hash);
  assert.equal(events[2].previousHash, events[1].hash);
  assert.deepEqual(await log.verifyIntegrity(), { valid: true, count: 3, headHash: events[2].hash });
});

test('audit rotates bounded segments while preserving one verifiable cross-segment chain', async (t) => {
  const state = await tempState(t, 'operator-audit-rotation-');
  const log = new AuditLog(state, { maxSegmentBytes: 256 * 1024 });
  for (let index = 0; index < 24; index += 1) {
    await log.append({ capability: `rotate.${index}`, result: 'success', risk: 'read', details: { payload: 'x'.repeat(16_000) } });
  }
  const segments = await fs.readdir(path.join(state, 'audit-segments'));
  assert.ok(segments.length >= 1);
  const integrity = await new AuditLog(state).verifyIntegrity();
  assert.equal(integrity.count, 24);
  const tail = await new AuditLog(state).tail(3);
  assert.deepEqual(tail.map((item) => item.capability), ['rotate.21', 'rotate.22', 'rotate.23']);

  const firstSegment = path.join(state, 'audit-segments', segments.sort()[0]!);
  const text = await fs.readFile(firstSegment, 'utf8');
  await fs.writeFile(firstSegment, text.replace('rotate.0', 'forged.0'));
  await assert.rejects(() => new AuditLog(state).verifyIntegrity(), (error: any) => error?.code === 'AUDIT_INTEGRITY_FAILED');
});

test('audit rotation serializes concurrent appends without gaps or duplicate chain links', async (t) => {
  const state = await tempState(t, 'operator-audit-concurrent-rotation-');
  const log = new AuditLog(state, { maxSegmentBytes: 256 * 1024 });
  await Promise.all(Array.from({ length: 40 }, (_, index) => log.append({
    capability: `concurrent.${index}`,
    result: 'success',
    risk: 'read',
    details: { payload: 'x'.repeat(12_000) }
  })));

  const events = await log.tail(100);
  assert.equal(events.length, 40);
  assert.deepEqual(new Set(events.map((event) => event.capability)).size, 40);
  assert.deepEqual(await log.verifyIntegrity(), { valid: true, count: 40, headHash: events.at(-1)!.hash! });
});

test('audit restart recovers when rotation finalized the old segment before a new active file exists', async (t) => {
  const state = await tempState(t, 'operator-audit-rotation-crash-');
  const log = new AuditLog(state);
  const event = await log.append({ capability: 'before.rotation', result: 'success', risk: 'read' });
  const segmentDir = path.join(state, 'audit-segments');
  await fs.mkdir(segmentDir, { recursive: true });
  await fs.rename(
    path.join(state, 'audit.ndjson'),
    path.join(segmentDir, `0000000000000001-${event.hash}.ndjson`)
  );

  const restarted = new AuditLog(state, { maxSegmentBytes: 256 * 1024 });
  assert.deepEqual(await restarted.verifyIntegrity(), { valid: true, count: 1, headHash: event.hash! });
  await restarted.append({ capability: 'after.restart', result: 'success', risk: 'read' });
  assert.deepEqual((await restarted.tail(10)).map((item) => item.capability), ['before.rotation', 'after.restart']);
});

test('audit integrity fails closed when an archived segment is missing', async (t) => {
  const state = await tempState(t, 'operator-audit-missing-segment-');
  const log = new AuditLog(state, { maxSegmentBytes: 256 * 1024 });
  for (let index = 0; index < 36; index += 1) {
    await log.append({ capability: `missing.${index}`, result: 'success', risk: 'read', details: { payload: 'x'.repeat(16_000) } });
  }
  const segmentDir = path.join(state, 'audit-segments');
  const segments = (await fs.readdir(segmentDir)).sort();
  assert.ok(segments.length >= 2);
  await fs.rm(path.join(segmentDir, segments[0]!));

  await assert.rejects(
    () => new AuditLog(state).verifyIntegrity(),
    (error: any) => error?.code === 'AUDIT_INTEGRITY_FAILED'
  );
});

test('device identity is stable and signs challenge payloads', async (t) => {
  const state = await tempState(t, 'operator-id-');
  const store = new DeviceIdentityStore(state, { platform: 'linux' });
  const first = await store.loadOrCreate('Test-PC');
  const second = await store.loadOrCreate('Other-Name-Ignored');
  assert.equal(first.deviceId, second.deviceId);
  const payload = Buffer.from('pairing-challenge');
  const signature = await store.sign(payload);
  assert.equal(await store.verify(payload, signature), true);
  assert.equal(await store.verify(Buffer.from('tampered'), signature), false);
});

test('new Windows device identity persists DPAPI ciphertext and no private PEM', async (t) => {
  const state = await tempState(t, 'operator-id-win-protected-');
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
  const state = await tempState(t, 'operator-id-win-migrate-');
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
