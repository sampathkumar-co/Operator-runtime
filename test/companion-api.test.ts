import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../src/core/device-registry.ts';
import { createTask } from '../src/core/task.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

test('companion read APIs expose authoritative task/device/settings state without private device keys', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-companion-root-'));
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-companion-state-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(state, { recursive: true, force: true })
  ]));

  const tasks = new TaskStore(state);
  const task = createTask({
    userObjective: 'Inspect the project safely',
    interpretedObjective: 'Read project state without mutation',
    authorizedScope: [root],
    prohibitedScope: ['external writes'],
    successConditions: ['project state inspected']
  });
  await tasks.put(task);

  const identity = new DeviceIdentityStore(state, { platform: 'linux' });
  const local = await identity.loadOrCreate('Companion Test PC');
  const registry = new DeviceRegistryStore(state);
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const token = 'c'.repeat(64);
  const settings = {
    recoveryConfigured: true,
    browserAutoLaunch: false,
    dockerConfigured: true,
    authorizedRootCount: 1
  };
  const agent = createLocalAgentServer({
    runtime,
    token,
    tasks,
    deviceIdentity: identity,
    deviceRegistry: registry,
    settings,
    permissions: { allowedCapabilities: ['computer.inspect', 'file.*'], allowedRoots: [root] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const headers = { authorization: `Bearer ${token}` };

  const tasksResponse = await fetch(`${base}/v1/tasks?limit=10`, { headers });
  assert.equal(tasksResponse.status, 200);
  const tasksBody = await tasksResponse.json() as any;
  assert.equal(tasksBody.configured, true);
  assert.equal(tasksBody.tasks.length, 1);
  assert.deepEqual(tasksBody.tasks[0], {
    id: task.id,
    userObjective: task.userObjective,
    state: task.state,
    updatedAt: task.updatedAt
  });

  const devicesResponse = await fetch(`${base}/v1/devices`, { headers });
  assert.equal(devicesResponse.status, 200);
  const devicesBody = await devicesResponse.json() as any;
  assert.equal(devicesBody.local.deviceId, local.deviceId);
  assert.equal(devicesBody.local.deviceName, 'Companion Test PC');
  assert.equal(devicesBody.local.fingerprint, local.fingerprint);
  assert.deepEqual(devicesBody.peers, []);
  const devicesJson = JSON.stringify(devicesBody);
  assert.equal(devicesJson.includes('PRIVATE KEY'), false);
  assert.equal(devicesJson.includes('privateKey'), false);
  assert.equal(devicesJson.includes('publicKeyPem'), false);

  const settingsResponse = await fetch(`${base}/v1/settings`, { headers });
  assert.equal(settingsResponse.status, 200);
  const settingsBody = await settingsResponse.json() as any;
  assert.deepEqual(settingsBody.settings, settings);
  assert.equal(JSON.stringify(settingsBody).includes(token), false);

  const unauthenticated = await fetch(`${base}/v1/devices`);
  assert.equal(unauthenticated.status, 401);
});
