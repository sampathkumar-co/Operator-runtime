import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../src/core/audit.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { createTask } from '../src/core/task.ts';

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
