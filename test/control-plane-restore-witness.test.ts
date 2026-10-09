import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/core/action-identity.ts';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import {
  restoreControlPlaneWithSignedWitness,
  type ControlPlaneRestoreGuard,
  type ControlPlaneRestoreManifest,
  type SignedControlPlaneRestoreManifest
} from '../src/core/control-plane-restore-witness.ts';

const NOW = new Date('2026-10-09T12:00:00.000Z');
async function stores(t: test.TestContext) {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-cp-witness-source-'));
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-cp-witness-dest-'));
  t.after(async () => {
    await Promise.all([fs.rm(source, { recursive: true, force: true }),
      fs.rm(dest, { recursive: true, force: true })]);
  });
  return { source: new EmbeddedControlPlaneStore(source), destination: new EmbeddedControlPlaneStore(dest) };
}

function fixture(snapshotDigest: string, options: { epoch?: number; clock?: Date } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const manifest: ControlPlaneRestoreManifest = {
    schemaVersion: 1, anchorId: 'independent-restore-epoch', epoch: options.epoch ?? 1,
    snapshotDigest, issuedAt: '2026-10-09T11:59:00.000Z',
    expiresAt: '2026-10-09T12:09:00.000Z'
  };
  const sign = (value: ControlPlaneRestoreManifest): SignedControlPlaneRestoreManifest => ({
    manifest: value,
    signature: crypto.sign(null, Buffer.from(canonicalJson(value)), privateKey).toString('base64url')
  });
  let latest = sign(manifest);
  let locked = false;
  let authorizations = 0;
  const guard: ControlPlaneRestoreGuard = {
    anchorId: manifest.anchorId, publicKeyPem,
    clock: () => options.clock ?? NOW,
    authorizeRestore: async () => { authorizations++; },
    anchor: {
      withLatestExclusive: async (work) => {
        assert.equal(locked, false, 'external anchor must serialize restore epochs');
        locked = true;
        try { return await work(latest); }
        finally { locked = false; }
      }
    }
  };
  return { manifest, sign, guard, get authorizations() { return authorizations; },
    setLatest: (w: SignedControlPlaneRestoreManifest) => { latest = w; } };
}

test('pinned independently approved restore retains live and tombstone generations', async (t) => {
  const { source, destination } = await stores(t);
  const [one, other] = await source.transact([
    { namespace: 'authority', key: 'erased', expectedGeneration: null, value: { owner: 'old' } },
    { namespace: 'authority', key: 'live', expectedGeneration: null, value: { owner: 'current' } }
  ], '2026-10-09T11:01:00.000Z');
  await source.transact([{
    namespace: 'authority', key: 'erased', expectedGeneration: one!.generation, value: null
  }], '2026-10-09T11:02:00.000Z');
  const snapshot = await source.snapshot('2026-10-09T11:03:00.000Z');
  assert.equal(snapshot.tombstones?.length, 1);
  const approve = fixture(snapshot.digest, { epoch: 4 });
  await restoreControlPlaneWithSignedWitness(destination, snapshot, approve.guard);
  assert.equal(approve.authorizations, 1);
  assert.equal((await destination.get('authority', 'live'))?.generation, other!.generation);
  const [recreated] = await destination.transact([
    { namespace: 'authority', key: 'erased', expectedGeneration: null, value: { owner: 'new' } }
  ], '2026-10-09T12:01:00.000Z');
  assert.equal(recreated!.generation, 2);
  await assert.rejects(destination.transact([
    { namespace: 'authority', key: 'erased', expectedGeneration: 1, value: { owner: 'stale' } }
  ], '2026-10-09T12:02:00.000Z'), (e: any) => e?.code === 'CONTROL_PLANE_CAS_MISMATCH');
  await assert.rejects(restoreControlPlaneWithSignedWitness(destination, snapshot, approve.guard),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_CONFLICT');
});

test('historically signed but superseded backup cannot restore against the latest external epoch', async (t) => {
  const { source, destination } = await stores(t);
  await source.transact([
    { namespace: 'account', key: 'device', expectedGeneration: null, value: { owner: 'old' } }
  ], '2026-10-09T11:01:00.000Z');
  const oldSnapshot = await source.snapshot('2026-10-09T11:02:00.000Z');
  await source.transact([
    { namespace: 'account', key: 'device', expectedGeneration: 1, value: null }
  ], '2026-10-09T11:03:00.000Z');
  const [newRecord] = await source.transact([
    { namespace: 'account', key: 'device', expectedGeneration: null, value: { owner: 'new' } }
  ], '2026-10-09T11:04:00.000Z');
  assert.equal(newRecord!.generation, 2);
  const latestSnapshot = await source.snapshot('2026-10-09T11:05:00.000Z');
  const approve = fixture(oldSnapshot.digest);
  const signedNewest = approve.sign({ ...approve.manifest, epoch: 2, snapshotDigest: latestSnapshot.digest });
  approve.setLatest(signedNewest);
  await assert.rejects(
    restoreControlPlaneWithSignedWitness(destination, oldSnapshot, approve.guard),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_STALE'
  );
  assert.equal(await destination.get('account', 'device'), null);
  await restoreControlPlaneWithSignedWitness(destination, latestSnapshot, approve.guard);
  assert.equal((await destination.get('account', 'device'))?.generation, 2);
});

test('invalid signer, altered digest and expired or future witness fail closed', async (t) => {
  const { source, destination } = await stores(t);
  await source.transact([{ namespace: 'n', key: 'k', expectedGeneration: null, value: { ok: true } }]);
  const snapshot = await source.snapshot();
  const approve = fixture(snapshot.digest);
  const valid = approve.sign(approve.manifest);
  approve.setLatest({ ...valid, signature: crypto.sign(null, Buffer.from('unrelated'), crypto.generateKeyPairSync('ed25519').privateKey).toString('base64url') });
  await assert.rejects(restoreControlPlaneWithSignedWitness(destination, snapshot, approve.guard),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_INVALID');
  approve.setLatest(approve.sign({ ...approve.manifest, expiresAt: '2026-10-09T11:59:59.000Z' }));
  await assert.rejects(restoreControlPlaneWithSignedWitness(destination, snapshot, approve.guard),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_EXPIRED');
  approve.setLatest(approve.sign({ ...approve.manifest, issuedAt: '2026-10-09T12:01:00.000Z' }));
  await assert.rejects(restoreControlPlaneWithSignedWitness(destination, snapshot, approve.guard),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_EXPIRED');
  approve.setLatest(approve.sign(approve.manifest));
  const wrongAnchor: ControlPlaneRestoreGuard = { ...approve.guard, anchorId: 'different-authority' };
  await assert.rejects(restoreControlPlaneWithSignedWitness(destination, snapshot, wrongAnchor),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_STALE');
  assert.equal(await destination.get('n','k'), null);
});

test('offline external witness, denial and missing authority cannot restore any data', async (t) => {
  const { source, destination } = await stores(t);
  await source.transact([{ namespace: 'n', key: 'k', expectedGeneration: null, value: { ok: true } }]);
  const snapshot = await source.snapshot();
  const approve = fixture(snapshot.digest);
  await assert.rejects(restoreControlPlaneWithSignedWitness(destination, snapshot, {
    ...approve.guard, anchor: { withLatestExclusive: async () => { throw new Error('anchor unavailable'); } }
  }), /anchor unavailable/);
  await assert.rejects(restoreControlPlaneWithSignedWitness(destination, snapshot, {
    ...approve.guard, authorizeRestore: async () => { throw new Error('operator not permitted'); }
  }), /operator not permitted/);
  await assert.rejects(restoreControlPlaneWithSignedWitness(destination, snapshot, {
    ...approve.guard, publicKeyPem: 'not a pinned public key'
  }), (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_INVALID');
  assert.equal(await destination.get('n','k'), null);
});

test('strict embedded restore cannot bypass the pinned external witness using direct store or helper APIs', async t => {
  const { source } = await stores(t);
  await source.transact([{ namespace: 'authority', key: 'device', expectedGeneration: null,
    value: { owner: 'original' } }]);
  const snapshot = await source.snapshot('2026-10-09T11:58:00.000Z');
  const approved = fixture(snapshot.digest);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-strict-control-plane-restore-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.throws(() => new EmbeddedControlPlaneStore(dir, { requireWitnessForRestore: true }),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_REQUIRED');
  const strict = new EmbeddedControlPlaneStore(dir, {
    restoreGuard: approved.guard, requireWitnessForRestore: true
  });
  await assert.rejects(strict.restore(snapshot),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_REQUIRED');
  await assert.rejects(restoreControlPlaneWithSignedWitness(strict, snapshot, approved.guard),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_REQUIRED');
  assert.equal(await strict.get('authority', 'device'), null);
  await strict.restoreWithConfiguredWitness(snapshot);
  assert.equal(approved.authorizations, 2, 'direct caller cannot bypass the witnessed guard');
  assert.equal((await strict.get('authority','device'))?.value.owner, 'original');
  await assert.rejects(strict.restoreWithConfiguredWitness(snapshot),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_CONFLICT');
});

test('a configured witness cannot be switched to another caller-supplied signer or authority', async t => {
  const { source } = await stores(t);
  await source.transact([{ namespace:'authority', key:'device', expectedGeneration:null,
    value:{owner:'trusted'} }]);
  const snapshot = await source.snapshot('2026-10-09T11:58:00.000Z');
  const approved = fixture(snapshot.digest);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-witness-authority-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const strict = new EmbeddedControlPlaneStore(dir, { restoreGuard: approved.guard });
  const untrusted = fixture(snapshot.digest);
  await assert.rejects(restoreControlPlaneWithSignedWitness(strict, snapshot, untrusted.guard),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_REQUIRED');
  const denied = fixture(snapshot.digest);
  denied.setLatest(denied.sign({ ...denied.manifest, epoch:2,
    snapshotDigest: crypto.createHash('sha256').update('other snapshot').digest('hex') }));
  const rejected = new EmbeddedControlPlaneStore(dir, { restoreGuard: denied.guard });
  await assert.rejects(rejected.restoreWithConfiguredWitness(snapshot),
    (e: any) => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_STALE');
  assert.equal(await rejected.get('authority','device'), null);
  await strict.restoreWithConfiguredWitness(snapshot);
  assert.equal((await strict.get('authority','device'))?.value.owner, 'trusted');
});
