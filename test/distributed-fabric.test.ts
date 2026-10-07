import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDistributedArtifactHandoff,
  DistributedWorkFenceStore
} from '../src/core/distributed-fabric.ts';

test('distributed work fences prevent split-brain and rotate generation after expiry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-fence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = new Date('2026-10-07T00:00:00.000Z');
  const store = new DistributedWorkFenceStore(root, { clock: () => now });
  const first = await store.acquire({
    objectiveId: 'objective:1',
    workUnitId: 'work:compile',
    role: 'CHANGE',
    placementKey: '1'.repeat(64),
    reservationId: 'reservation:1',
    deviceId: 'device:a',
    sessionId: 'session:a',
    authorityDigest: '2'.repeat(64),
    leaseMs: 10_000
  });
  assert.equal(first.generation, 1);
  await assert.rejects(() => store.acquire({
    objectiveId: 'objective:1',
    workUnitId: 'work:compile',
    role: 'CHANGE',
    placementKey: '1'.repeat(64),
    reservationId: 'reservation:2',
    deviceId: 'device:b',
    sessionId: 'session:b',
    authorityDigest: '2'.repeat(64)
  }), /active distributed owner/);

  now = new Date('2026-10-07T00:00:11.000Z');
  const second = await store.acquire({
    objectiveId: 'objective:1',
    workUnitId: 'work:compile',
    role: 'RECOVERY',
    placementKey: '3'.repeat(64),
    reservationId: 'reservation:2',
    deviceId: 'device:b',
    sessionId: 'session:b',
    authorityDigest: '4'.repeat(64)
  });
  assert.equal(second.generation, 2);
  await assert.rejects(() => store.assertCurrent({
    fenceId: first.id,
    generation: 1,
    authorityDigest: '2'.repeat(64),
    placementKey: '1'.repeat(64),
    now: '2026-10-07T00:00:11.000Z'
  }), /no longer active/);
});

test('distributed fence rejects stale session and changed authority', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-fence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DistributedWorkFenceStore(root, { clock: () => new Date('2026-10-07T00:00:00.000Z') });
  const fence = await store.acquire({
    objectiveId: 'objective:2',
    workUnitId: 'work:test',
    role: 'TEST',
    placementKey: '5'.repeat(64),
    reservationId: 'reservation:x',
    deviceId: 'device:x',
    sessionId: 'session:x',
    authorityDigest: '6'.repeat(64)
  });
  await assert.rejects(() => store.heartbeat({
    fenceId: fence.id,
    generation: fence.generation,
    sessionId: 'session:replacement'
  }), /session changed/);
  await assert.rejects(() => store.assertCurrent({
    fenceId: fence.id,
    generation: fence.generation,
    authorityDigest: '7'.repeat(64),
    placementKey: '5'.repeat(64),
    now: '2026-10-07T00:01:00.000Z'
  }), /Authority changed/);
});

test('artifact-only worker handoff is causally bound to source and destination fences', () => {
  const handoff = createDistributedArtifactHandoff({
    objectiveId: 'objective:3',
    workUnitId: 'work:verify',
    fromFenceId: '8'.repeat(64),
    toFenceId: '9'.repeat(64),
    artifactIds: ['a'.repeat(64)],
    evidenceArtifactIds: ['b'.repeat(64)],
    createdAt: '2026-10-07T00:00:00.000Z'
  });
  assert.match(handoff.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(handoff.artifactIds, ['a'.repeat(64)]);
});
