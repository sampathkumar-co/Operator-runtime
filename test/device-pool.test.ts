import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../src/core/device-registry.ts';
import { DeviceRoutingStore } from '../src/core/device-routing.ts';
import { DevicePoolScheduler, type DeviceResourceAdvertisement } from '../src/core/device-pool.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t: test.TestContext) {
  const state = await tempDir(t, 'operator-device-pool-state-');
  const registry = new DeviceRegistryStore(state);
  const routing = new DeviceRoutingStore(state, registry);
  const one = await new DeviceIdentityStore(await tempDir(t, 'operator-device-one-'), { platform: 'linux' }).loadOrCreate('one');
  const two = await new DeviceIdentityStore(await tempDir(t, 'operator-device-two-'), { platform: 'linux' }).loadOrCreate('two');
  await registry.registerVerifiedPeer(one);
  await registry.registerVerifiedPeer(two);
  return { state, registry, routing, one, two, scheduler: new DevicePoolScheduler(state, registry, routing) };
}

function advert(deviceId: string, sessionId: string, options: Partial<DeviceResourceAdvertisement> = {}): DeviceResourceAdvertisement {
  return {
    deviceId,
    sessionId,
    capabilities: ['file.read', 'project.command.run'],
    observedAt: new Date().toISOString(),
    cpuSlots: 8,
    memoryMb: 16384,
    gpu: false,
    tags: [],
    activeJobs: 0,
    maxConcurrentJobs: 2,
    ...options
  };
}

test('stage7 selects capable resource pool device and reserves bounded capacity', async (t) => {
  const { scheduler, one, two } = await setup(t);
  const s1 = crypto.randomUUID();
  const s2 = crypto.randomUUID();
  const reservation = await scheduler.reserve({
    workloadKey: 'render:1',
    requiredCapabilities: ['project.command.run'],
    requireGpu: true,
    minMemoryMb: 8000
  }, [
    advert(one.deviceId, s1, { gpu: false }),
    advert(two.deviceId, s2, { gpu: true, memoryMb: 32768 })
  ]);
  assert.equal(reservation.deviceId, two.deviceId);
  assert.equal(reservation.sessionId, s2);
  assert.equal(reservation.state, 'ACTIVE');
});

test('stage7 respects existing project-to-device authority even when another machine scores higher', async (t) => {
  const { scheduler, routing, one, two } = await setup(t);
  await routing.bindProject('project:alpha', one.deviceId);
  const reservation = await scheduler.reserve({
    workloadKey: 'build:alpha',
    projectKey: 'project:alpha',
    requiredCapabilities: ['file.read']
  }, [
    advert(one.deviceId, crypto.randomUUID(), { memoryMb: 4096, maxConcurrentJobs: 1 }),
    advert(two.deviceId, crypto.randomUUID(), { memoryMb: 65536, maxConcurrentJobs: 8, gpu: true })
  ]);
  assert.equal(reservation.deviceId, one.deviceId);
});

test('stage7 active reservations prevent overbooking until release', async (t) => {
  const { scheduler, one } = await setup(t);
  const session = crypto.randomUUID();
  const advertisements = [advert(one.deviceId, session, { maxConcurrentJobs: 1 })];
  const first = await scheduler.reserve({ workloadKey: 'job:1' }, advertisements);
  await assert.rejects(
    scheduler.reserve({ workloadKey: 'job:2' }, advertisements),
    (error: any) => error?.code === 'DEVICE_POOL_NO_CAPACITY'
  );
  await scheduler.release(first.id);
  const second = await scheduler.reserve({ workloadKey: 'job:2' }, advertisements);
  assert.equal(second.deviceId, one.deviceId);
});

test('stage7 refuses stale advertisements and session heartbeat drift', async (t) => {
  const { scheduler, one } = await setup(t);
  await assert.rejects(
    scheduler.reserve({ workloadKey: 'stale', livenessMs: 5000 }, [
      advert(one.deviceId, crypto.randomUUID(), { observedAt: new Date(Date.now() - 60_000).toISOString() })
    ]),
    (error: any) => error?.code === 'DEVICE_POOL_STALE_ADVERTISEMENT'
  );

  const session = crypto.randomUUID();
  const reservation = await scheduler.reserve({ workloadKey: 'fresh' }, [advert(one.deviceId, session)]);
  await assert.rejects(
    scheduler.heartbeat(reservation.id, crypto.randomUUID()),
    (error: any) => error?.code === 'DEVICE_POOL_SESSION_CHANGED'
  );
});

test('stage7 revoked paired device is excluded even when advertised with perfect capacity', async (t) => {
  const { scheduler, registry, one, two } = await setup(t);
  await registry.revokeDevice(two.deviceId, 'test revoke');
  const reservation = await scheduler.reserve({ workloadKey: 'safe' }, [
    advert(one.deviceId, crypto.randomUUID(), { memoryMb: 4096 }),
    advert(two.deviceId, crypto.randomUUID(), { memoryMb: 100000, gpu: true, maxConcurrentJobs: 100 })
  ]);
  assert.equal(reservation.deviceId, one.deviceId);
});


test('cross-component project binding cannot be bypassed by an explicit scheduler device', async (t) => {
  const { scheduler, routing, one, two } = await setup(t);
  await routing.bindProject('project:locked', one.deviceId);
  await assert.rejects(
    scheduler.reserve({ workloadKey: 'build:locked', projectKey: 'project:locked', explicitDeviceId: two.deviceId }, [
      advert(one.deviceId, crypto.randomUUID()),
      advert(two.deviceId, crypto.randomUUID())
    ]),
    (error: any) => error?.code === 'DEVICE_POOL_PROJECT_DEVICE_CONFLICT'
  );
  assert.deepEqual(await scheduler.list({ activeOnly: true }), []);
});

test('revoked device cannot renew an existing reservation after registry state changes', async (t) => {
  const { scheduler, registry, one } = await setup(t);
  const session = crypto.randomUUID();
  const reservation = await scheduler.reserve({ workloadKey: 'before-revoke' }, [advert(one.deviceId, session)]);
  await registry.revokeDevice(one.deviceId, 'authority revoked');
  await assert.rejects(
    scheduler.heartbeat(reservation.id, session),
    (error: any) => error?.code === 'DEVICE_POOL_DEVICE_INACTIVE'
  );
  const released = await scheduler.release(reservation.id);
  assert.equal(released.state, 'RELEASED');
});

test('device pool rejects duplicate cross-device sessions just as routing does', async (t) => {
  const { scheduler, one, two } = await setup(t);
  const session = crypto.randomUUID();
  await assert.rejects(
    scheduler.reserve({ workloadKey: 'ambiguous-session' }, [
      advert(one.deviceId, session),
      advert(two.deviceId, session)
    ]),
    (error: any) => error?.code === 'DEVICE_POOL_INPUT_INVALID'
  );
});
