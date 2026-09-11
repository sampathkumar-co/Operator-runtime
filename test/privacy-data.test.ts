import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../src/core/audit.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { createTask } from '../src/core/task.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { LocalPrivacyDataStore } from '../apps/local-agent/src/privacy-data.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('privacy inventory is bounded and purge requires recovery auth while protected identity remains untouched', async (t) => {
  const root = await temp(t, 'operator-privacy-root-');
  const state = await temp(t, 'operator-privacy-state-');
  const identity = new DeviceIdentityStore(state, { platform: 'linux' });
  await identity.loadOrCreate('Privacy PC');
  const audit = new AuditLog(state);
  await audit.append({ capability: 'file.read', result: 'success', risk: 'read', details: { actionId: 'privacy-test' } });
  const tasks = new TaskStore(state);
  await tasks.put(createTask({
    userObjective: 'privacy test',
    interpretedObjective: 'privacy test',
    authorizedScope: [root],
    prohibitedScope: [],
    successConditions: ['done']
  }));
  await fs.writeFile(path.join(state, 'relay-client.json'), '{"version":1}', { mode: 0o600 });
  await fs.writeFile(path.join(state, 'device-sessions.json'), '{"version":1}', { mode: 0o600 });

  const privacy = new LocalPrivacyDataStore(state);
  const inventory = await privacy.inventory();
  assert.equal(inventory.find((item) => item.category === 'activity')?.present, true);
  assert.equal(inventory.find((item) => item.category === 'tasks')?.present, true);
  assert.equal(inventory.find((item) => item.category === 'session-state')?.present, true);
  assert.equal(inventory.find((item) => item.category === 'device-identity')?.deletable, false);

  const token = 'a'.repeat(64);
  const recoveryToken = 'r'.repeat(64);
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const agent = createLocalAgentServer({
    runtime,
    token,
    recoveryToken,
    privacy,
    permissions: { allowedCapabilities: ['computer.inspect'], allowedRoots: [root] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const auth = { authorization: `Bearer ${token}` };

  const listed = await fetch(`${base}/v1/privacy`, { headers: auth });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json() as any).categories.length, 5);

  const wrongRecovery = await fetch(`${base}/v1/privacy/activity`, {
    method: 'DELETE',
    headers: { ...auth, 'x-operator-recovery-token': token }
  });
  assert.equal(wrongRecovery.status, 401);
  await fs.access(path.join(state, 'audit.ndjson'));

  const protectedDelete = await fetch(`${base}/v1/privacy/device-identity`, {
    method: 'DELETE',
    headers: { ...auth, 'x-operator-recovery-token': recoveryToken }
  });
  assert.equal(protectedDelete.status, 400);
  await fs.access(path.join(state, 'device-identity.json'));

  for (const category of ['activity', 'tasks', 'session-state']) {
    const response = await fetch(`${base}/v1/privacy/${category}`, {
      method: 'DELETE',
      headers: { ...auth, 'x-operator-recovery-token': recoveryToken }
    });
    assert.equal(response.status, 200, category);
  }

  await assert.rejects(fs.access(path.join(state, 'audit.ndjson')));
  await assert.rejects(fs.access(path.join(state, 'tasks')));
  await assert.rejects(fs.access(path.join(state, 'relay-client.json')));
  await assert.rejects(fs.access(path.join(state, 'device-sessions.json')));
  await fs.access(path.join(state, 'device-identity.json'));
});

test('privacy purge refuses symlinked state categories and never follows them outside the Operator state directory', async (t) => {
  const state = await temp(t, 'operator-privacy-symlink-state-');
  const outside = await temp(t, 'operator-privacy-symlink-outside-');
  const sentinel = path.join(outside, 'sentinel.txt');
  await fs.writeFile(sentinel, 'must-survive');
  await fs.symlink(outside, path.join(state, 'tasks'), process.platform === 'win32' ? 'junction' : 'dir');

  const privacy = new LocalPrivacyDataStore(state);
  await assert.rejects(privacy.inventory(), /symbolic link/i);
  await assert.rejects(privacy.purge('tasks'), /symbolic link/i);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'must-survive');
});
