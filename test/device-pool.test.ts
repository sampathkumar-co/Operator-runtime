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

test('preassigned durable reservation IDs cannot be replayed to double allocate capacity', async (t) => {
  const { scheduler, one } = await setup(t);
  const session = crypto.randomUUID();
  const reservationId = crypto.randomUUID();
  const resources = [advert(one.deviceId, session, { maxConcurrentJobs: 2 })];
  const allocated = await scheduler.reserve({ workloadKey: 'idempotent:first' }, resources, { reservationId });
  assert.equal(allocated.id, reservationId);
  await assert.rejects(
    scheduler.reserve({ workloadKey: 'idempotent:second' }, resources, { reservationId }),
    (error: any) => error?.code === 'DEVICE_POOL_RESERVATION_ID_CONFLICT'
  );
  assert.equal((await scheduler.list({ activeOnly: true })).length, 1);
  await scheduler.release(reservationId);
  await assert.rejects(
    scheduler.reserve({ workloadKey: 'idempotent:third' }, resources, { reservationId }),
    (error: any) => error?.code === 'DEVICE_POOL_RESERVATION_ID_CONFLICT'
  );
});

test('independent schedulers sharing a state directory cannot overbook one capacity slot', async (t) => {
  const { state, registry, routing, one } = await setup(t);
  const schedulerA = new DevicePoolScheduler(state, registry, routing);
  const schedulerB = new DevicePoolScheduler(state, registry, routing);
  const advertisements = [advert(one.deviceId, crypto.randomUUID(), { maxConcurrentJobs: 1 })];
  const results = await Promise.allSettled([
    schedulerA.reserve({ workloadKey: 'independent:a' }, advertisements),
    schedulerB.reserve({ workloadKey: 'independent:b' }, advertisements)
  ]);
  const successes = results.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<DevicePoolScheduler['reserve']>>> => item.status === 'fulfilled');
  const errors = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
  assert.equal(successes.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.reason?.code, 'DEVICE_POOL_NO_CAPACITY');
  assert.equal((await schedulerA.list({ activeOnly: true })).length, 1);
  await schedulerB.release(successes[0]!.value.id);
  assert.equal((await schedulerA.list({ activeOnly: true })).length, 0);
});

test('persisted reservation ID history survives compaction and rejects old deterministic UUID replay', async t => {
  const { state, one, scheduler } = await setup(t);
  const session = crypto.randomUUID();
  const ads = [advert(one.deviceId, session, { maxConcurrentJobs: 2 })];
  const oldId = crypto.randomUUID();
  const allocated = await scheduler.reserve({ workloadKey: 'job:old' }, ads, { reservationId: oldId });
  assert.equal(allocated.id, oldId);
  await scheduler.release(oldId);
  const file = path.join(state, 'device-pool.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.version, 2);
  assert.ok(saved.usedReservationIds.includes(oldId));
  // Exact effect of capacity compaction: remove the terminal row while
  // preserving the atomic, append-only ID history.
  saved.reservations = saved.reservations.filter((item: any) => item.id !== oldId);
  await fs.writeFile(file, JSON.stringify(saved));
  const restarted = new DevicePoolScheduler(state, new DeviceRegistryStore(state),
    new DeviceRoutingStore(state, new DeviceRegistryStore(state)));
  await assert.rejects(
    restarted.reserve({ workloadKey: 'job:replacement' }, ads, { reservationId: oldId }),
    (error: any) => error?.code === 'DEVICE_POOL_RESERVATION_ID_CONFLICT'
  );
  const replacement = await restarted.reserve({ workloadKey: 'job:replacement' }, ads, { reservationId: crypto.randomUUID() });
  assert.equal(replacement.state, 'ACTIVE');
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(persisted.usedReservationIds.includes(oldId));
  assert.ok(persisted.usedReservationIds.includes(replacement.id));
});

test('legacy v1 migration preserves all currently retained reservation IDs', async t => {
  const { state, one, scheduler } = await setup(t);
  const session = crypto.randomUUID();
  const ads = [advert(one.deviceId, session, { maxConcurrentJobs: 2 })];
  const oldId = crypto.randomUUID();
  await scheduler.reserve({ workloadKey: 'job:legacy' }, ads, { reservationId: oldId });
  const file = path.join(state, 'device-pool.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  const legacy = { version: 1, reservations: saved.reservations };
  // A real pre-upgrade directory had no v2 initialization marker.
  await fs.rm(path.join(state, 'device-pool-initialized.json'));
  await fs.writeFile(file, JSON.stringify(legacy));
  await scheduler.reserve({ workloadKey: 'job:after-upgrade' }, ads, { reservationId: crypto.randomUUID() });
  const upgraded = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(upgraded.version, 2);
  assert.ok(upgraded.usedReservationIds.includes(oldId));
  await assert.rejects(scheduler.reserve({ workloadKey: 'job:old-replay' }, ads, { reservationId: oldId }),
    (error: any) => error?.code === 'DEVICE_POOL_RESERVATION_ID_CONFLICT');
});

test('v2 reservation state fails closed when a retained row is absent from historical IDs', async t => {
  const { state, one, scheduler } = await setup(t);
  const session = crypto.randomUUID();
  const ads = [advert(one.deviceId, session)];
  await scheduler.reserve({ workloadKey: 'job:typed-history' }, ads);
  const file = path.join(state, 'device-pool.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.usedReservationIds = [];
  await fs.writeFile(file, JSON.stringify(saved));
  await assert.rejects(scheduler.reserve({ workloadKey: 'job:unsafe' }, ads),
    (error: any) => error?.code === 'DEVICE_POOL_STATE_CORRUPT');
});

test('missing device pool ledger cannot become an empty unowned capacity after initialization', async t => {
  const { state, one, registry, routing, scheduler } = await setup(t);
  const session = crypto.randomUUID(), reservationId = crypto.randomUUID();
  const ads = [advert(one.deviceId, session)];
  await scheduler.reserve({ workloadKey: 'before-ledger-loss' }, ads, { reservationId });
  const marker = path.join(state, 'device-pool-initialized.json');
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')),
    { version: 1, initialized: true, allowV1: false });
  await fs.rm(path.join(state, 'device-pool.json'));
  const resumed = new DevicePoolScheduler(state, registry, routing);
  await assert.rejects(resumed.reserve({ workloadKey: 'reused-reservation' }, ads, { reservationId }),
    (error: any) => error?.code === 'DEVICE_POOL_LEDGER_MISSING');
  await assert.rejects(resumed.list({ activeOnly: true }),
    (error: any) => error?.code === 'DEVICE_POOL_LEDGER_MISSING');
  await fs.access(marker);
});

test('restoring a v1 device pool after v2 marker is a rejected history rollback', async t => {
  const { state, registry, routing, one, scheduler } = await setup(t);
  const ads = [advert(one.deviceId, crypto.randomUUID())];
  await scheduler.reserve({ workloadKey: 'upgraded-v2' }, ads);
  const file = path.join(state, 'device-pool.json');
  const v2 = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ version: 1, reservations: v2.reservations }));
  const restarted = new DevicePoolScheduler(state, registry, routing);
  await assert.rejects(restarted.reserve({ workloadKey: 'rollback-replay' }, ads),
    (error: any) => error?.code === 'DEVICE_POOL_HISTORY_INCOMPLETE');
});

test('saturated legacy reservation rows require trusted reconciliation before new allocations', async t => {
  const { state, registry, routing, one, scheduler } = await setup(t);
  const ads = [advert(one.deviceId, crypto.randomUUID())];
  const first = await scheduler.reserve({ workloadKey: 'historic-v1-full' }, ads);
  const file = path.join(state, 'device-pool.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.rm(path.join(state, 'device-pool-initialized.json'));
  const legacyRows = Array.from({ length: 5_000 }, (_, index) => ({
    ...saved.reservations[0],
    id: index === 0 ? first.id : crypto.randomUUID(),
    state: 'RELEASED'
  }));
  await fs.writeFile(file, JSON.stringify({ version: 1, reservations: legacyRows }));
  const restarted = new DevicePoolScheduler(state, registry, routing);
  await assert.rejects(restarted.reserve({ workloadKey: 'unknown-old-id' }, ads),
    (error: any) => error?.code === 'DEVICE_POOL_HISTORY_INCOMPLETE');
  assert.equal((await restarted.list({ activeOnly: true })).length, 0);
});

test('existing v2 history without completeness flag fails closed at original compaction threshold', async t => {
  const { state, registry, routing, one } = await setup(t);
  const usedReservationIds = Array.from({ length: 5_000 }, (_, i) =>
    '00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'));
  await fs.writeFile(path.join(state, 'device-pool.json'), JSON.stringify({
    version: 2, reservations: [], usedReservationIds
  }));
  const restarted = new DevicePoolScheduler(state, registry, routing);
  await assert.rejects(restarted.reserve({
    workloadKey: 'legacy-v2-full'
  }, [advert(one.deviceId, crypto.randomUUID())]),
  (error: any) => error?.code === 'DEVICE_POOL_HISTORY_INCOMPLETE');
  assert.deepEqual((await restarted.list()), []);
});

test('existing non-saturated v2 reservation history upgrades without discarding known IDs', async t => {
  const { state, registry, routing, one, scheduler } = await setup(t);
  const ads = [advert(one.deviceId, crypto.randomUUID())];
  const first = await scheduler.reserve({ workloadKey: 'non-saturated-old-v2' }, ads);
  const file = path.join(state, 'device-pool.json');
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  delete stored.historyComplete;
  await fs.writeFile(file, JSON.stringify(stored));
  const restarted = new DevicePoolScheduler(state, registry, routing);
  await restarted.release(first.id);
  const next = await restarted.reserve({ workloadKey: 'new-v2-identity' }, ads);
  const upgraded = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(upgraded.historyComplete, true);
  assert.ok(upgraded.usedReservationIds.includes(first.id));
  assert.ok(upgraded.usedReservationIds.includes(next.id));
});

test('read-only observation of a pre-upgrade v1 ledger writes a monotonic rollback marker', async t => {
  const { state, registry, routing, one, scheduler } = await setup(t);
  const ads = [advert(one.deviceId, crypto.randomUUID())];
  const first = await scheduler.reserve({ workloadKey: 'before-legacy-observe' }, ads);
  const file = path.join(state, 'device-pool.json');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.rm(path.join(state, 'device-pool-initialized.json'));
  await fs.writeFile(file, JSON.stringify({ version: 1, reservations: data.reservations }));
  const observer = new DevicePoolScheduler(state, registry, routing);
  assert.equal((await observer.list())[0]?.id, first.id);
  const marker = path.join(state, 'device-pool-initialized.json');
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')),
    { version: 1, initialized: true, allowV1: true });
  // A second read-only observer of the same legitimate v1 file must work.
  assert.equal((await observer.list())[0]?.id, first.id);
  await fs.rm(file);
  await assert.rejects(new DevicePoolScheduler(state, registry, routing).list(),
    (error: any) => error?.code === 'DEVICE_POOL_LEDGER_MISSING');
});

test('a stale v1 observer cannot downgrade the independently locked v2 history marker', async t => {
  const { state, registry, routing, one, scheduler } = await setup(t);
  const ads = [advert(one.deviceId, crypto.randomUUID())];
  const first = await scheduler.reserve({ workloadKey: 'old-history' }, ads);
  const file = path.join(state, 'device-pool.json');
  const current = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.rm(path.join(state, 'device-pool-initialized.json'));
  await fs.writeFile(file, JSON.stringify({ version: 1, reservations: current.reservations }));
  const observer = new DevicePoolScheduler(state, registry, routing);
  await observer.list();
  assert.equal(JSON.parse(await fs.readFile(path.join(state, 'device-pool-initialized.json'), 'utf8')).allowV1, true);
  const upgraded = new DevicePoolScheduler(state, registry, routing);
  await upgraded.release(first.id);
  const marker = path.join(state, 'device-pool-initialized.json');
  assert.equal(JSON.parse(await fs.readFile(marker, 'utf8')).allowV1, false);
  const older = { version: 1, reservations: current.reservations };
  await fs.writeFile(file, JSON.stringify(older));
  await assert.rejects(observer.list(),
    (error: any) => error?.code === 'DEVICE_POOL_HISTORY_INCOMPLETE');
  assert.equal(JSON.parse(await fs.readFile(marker, 'utf8')).allowV1, false);
});

test('truncated reservation initialization markers return typed corruption after parent loss', async t => {
  const { state, registry, routing, one, scheduler } = await setup(t);
  await scheduler.reserve({ workloadKey: 'marker-corruption' }, [advert(one.deviceId, crypto.randomUUID())]);
  await fs.rm(path.join(state, 'device-pool.json'));
  await fs.writeFile(path.join(state, 'device-pool-initialized.json'), '{truncated');
  await assert.rejects(new DevicePoolScheduler(state, registry, routing).list(),
    (error: any) => error?.code === 'DEVICE_POOL_STATE_CORRUPT');
});
