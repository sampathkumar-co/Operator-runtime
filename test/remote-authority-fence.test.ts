import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { RemoteAuthorityFenceStore, type RemoteAuthoritySubject } from '../src/core/remote-authority-fence.ts';

async function fixture(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-remote-authority-fence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-10-09T00:00:00.000Z');
  let allow = true;
  let allowRevoke = true;
  const calls: string[] = [];
  const make = () => new RemoteAuthorityFenceStore(new EmbeddedControlPlaneStore(dir), {
    clock: () => new Date(now),
    authorizeMutation: async (_subject, mutation) => {
      if (mutation.namespace === 'unauthorized-effects') throw new Error('provider scope denied');
    },
    authorize: async (subject, mode) => {
      calls.push(mode + ':' + subject.authorityGeneration);
      if (mode === 'acquire' ? !allow : !allowRevoke) throw new Error('authoritative policy denied request');
    }
  });
  const subject: RemoteAuthoritySubject = { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), authorityGeneration: 1 };
  return { make, subject, calls, advance: (ms: number) => { now += ms; }, permit: (b: boolean) => { allow = b; },
    permitRevoke: (b: boolean) => { allowRevoke = b; } };
}

test('multiple independent control-plane clients elect one exact lease owner', async (t) => {
  const { make, subject } = await fixture(t);
  const owners = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => make().acquire(subject, 'worker-' + i)));
  const successful = owners.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<ReturnType<typeof make>['acquire']>>> => r.status === 'fulfilled');
  assert.equal(successful.length, 1);
  assert.equal(owners.filter((r) => r.status === 'rejected').length, 7);
  assert.equal((await make().assertCurrent(successful[0]!.value)).ownerId, successful[0]!.value.ownerId);
});

test('revocation barrier invalidates an already-issued worker token on another store instance', async (t) => {
  const { make, subject } = await fixture(t);
  const stale = await make().acquire(subject, 'remote-host-A');
  const barrier = await make().revoke(subject);
  assert.ok(barrier.generation > stale.generation);
  await assert.rejects(make().assertCurrent(stale), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  await assert.rejects(make().heartbeat(stale), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  await assert.rejects(make().acquire(subject, 'replay-host'), (e: any) => e?.code === 'REMOTE_AUTHORITY_REVOKED');
  const replacement = { ...subject, authorityGeneration: subject.authorityGeneration + 1 };
  const fresh = await make().acquire(replacement, 'fresh-host');
  assert.ok(fresh.generation > barrier.generation);
  await assert.rejects(make().revoke(subject), (e: any) => e?.code === 'REMOTE_AUTHORITY_NEWER_GENERATION');
  assert.deepEqual((await make().assertCurrent(fresh)).leaseId, fresh.leaseId);
});

test('heartbeat advances the fence and rejects an old lease incarnation', async (t) => {
  const { make, subject, advance } = await fixture(t);
  const previous = await make().acquire(subject, 'host-A', 5_000);
  advance(1_000);
  const renewed = await make().heartbeat(previous, 5_000);
  assert.equal(renewed.leaseId, previous.leaseId);
  assert.ok(renewed.generation > previous.generation);
  await assert.rejects(make().assertCurrent(previous), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  assert.equal((await make().assertCurrent(renewed)).generation, renewed.generation);
  advance(5_001);
  await assert.rejects(make().assertCurrent(renewed), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  const takeover = await make().acquire(subject, 'host-B', 5_000);
  assert.ok(takeover.generation > renewed.generation);
  await assert.rejects(make().assertCurrent(renewed), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
});

test('authorization hooks reject acquisition and revocation without writing state', async (t) => {
  const { make, subject, permit, permitRevoke } = await fixture(t);
  permit(false);
  await assert.rejects(make().acquire(subject, 'forbidden'));
  permit(true);
  const lease = await make().acquire(subject, 'permitted');
  permitRevoke(false);
  await assert.rejects(make().revoke(subject));
  assert.equal((await make().assertCurrent(lease)).leaseId, lease.leaseId);
});

test('replayed or substituted bearer cannot satisfy exact owner, token, or process binding', async (t) => {
  const { make, subject } = await fixture(t);
  const lease = await make().acquire(subject, 'host-A');
  for (const mutated of [
    { ...lease, ownerId: 'host-B' },
    { ...lease, leaseId: crypto.randomUUID() },
    { ...lease, fenceToken: crypto.randomBytes(32).toString('base64url') },
    { ...lease, process: { ...lease.process, started: 'other-process-start' } },
    { ...lease, authorityGeneration: 2 },
  ]) {
    await assert.rejects(make().assertCurrent(mutated), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  }
});

test('read-only provider commit verification fails after a revoker races with a delayed effect', async (t) => {
  const { make, subject } = await fixture(t);
  const lease = await make().acquire(subject, 'host-A');
  const committed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let begin!: () => void;
  const entered = new Promise<void>((resolve) => { begin = resolve; });
  const effect = (async () => {
    await make().assertCurrent(lease);
    begin();
    await gate;
    await make().assertCurrent(lease); // provider's final effect/commit boundary
    committed.push('should-never-commit');
  })();
  await entered;
  await make().revoke(subject);
  release();
  await assert.rejects(effect, (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  assert.deepEqual(committed, []);
});

test('revocation remains durable after restart and cannot be undone by a fabricated or old token', async (t) => {
  const { make, subject } = await fixture(t);
  const old = await make().acquire(subject, 'old-process');
  const revoke = await make().revoke(subject);
  const current = make(); // new control-plane adapter / cold restart
  await assert.rejects(current.assertCurrent(old), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  await assert.rejects(current.acquire(subject, 'other'), (e: any) => e?.code === 'REMOTE_AUTHORITY_REVOKED');
  assert.ok((await current.revoke(subject)).generation > revoke.generation);
});

test('a protected provider write advances the lease and commits in the same CAS transaction', async (t) => {
  const { make, subject } = await fixture(t);
  const first = await make().acquire(subject, 'provider-A');
  const mutation = { namespace: 'provider-effects', key: 'effect-one', expectedGeneration: null,
    value: { state: 'committed', requestId: 'effect-one' } };
  const committed = await make().commitProtected(first, mutation);
  assert.equal(committed.record?.value.state, 'committed');
  assert.equal(committed.lease.leaseId, first.leaseId);
  assert.ok(committed.lease.generation > first.generation);
  await assert.rejects(make().commitProtected(first, {
    namespace: 'provider-effects', key: 'stale', expectedGeneration: null, value: { state: 'should-not-write' }
  }), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  assert.equal((await make().assertCurrent(committed.lease)).generation, committed.lease.generation);
  await make().revoke(subject);
  await assert.rejects(make().commitProtected(committed.lease, {
    namespace: 'provider-effects', key: 'post-revoke', expectedGeneration: null, value: { state: 'should-not-write' }
  }), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
});

test('revocation between provider authority check and atomic write rejects the entire effect', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-authority-provider-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new EmbeddedControlPlaneStore(dir);
  const subject: RemoteAuthoritySubject = {
    accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), authorityGeneration: 1
  };
  const authorize = async () => {};
  const authority = () => new RemoteAuthorityFenceStore(new EmbeddedControlPlaneStore(dir), { authorize });
  const old = await authority().acquire(subject, 'old-provider');
  let signal!: () => void;
  const entered = new Promise<void>((resolve) => { signal = resolve; });
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const delayed = {
    get: store.get.bind(store),
    list: store.list.bind(store),
    snapshot: store.snapshot.bind(store),
    restore: store.restore.bind(store),
    transact: async (...args: Parameters<typeof store.transact>) => {
      if (args[0].length === 2) {
        signal();
        await gate;
      }
      return store.transact(...args);
    }
  };
  const mutating = new RemoteAuthorityFenceStore(delayed, { authorize, authorizeMutation: async () => {} }).commitProtected(old, {
    namespace: 'protected-effects', key: 'mutated-after-revocation',
    expectedGeneration: null, value: { sensitive: true }
  });
  await entered;
  await authority().revoke(subject);
  unblock();
  await assert.rejects(mutating, (e: any) => e?.code === 'CONTROL_PLANE_CAS_MISMATCH');
  assert.equal(await store.get('protected-effects', 'mutated-after-revocation'), null);
});

test('protected commits cannot mutate the fence namespace or bypass an effect CAS mismatch', async (t) => {
  const { make, subject } = await fixture(t);
  const lease = await make().acquire(subject, 'provider');
  await assert.rejects(make().commitProtected(lease, {
    namespace: '__mecord_remote_authority', key: subject.deviceId,
    expectedGeneration: null, value: { kind: 'revoked' }
  }), (e: any) => e?.code === 'REMOTE_AUTHORITY_INVALID');
  await assert.rejects(make().commitProtected(lease, {
    namespace: 'provider-effects', key: 'missing-effect',
    expectedGeneration: 1, value: { data: 'not-authorized-to-overwrite' }
  }), (e: any) => e?.code === 'CONTROL_PLANE_CAS_MISMATCH');
  assert.equal((await make().assertCurrent(lease)).generation, lease.generation);
});

test('voluntary release preserves monotonic token generation and does not override revocation', async (t) => {
  const { make, subject } = await fixture(t);
  const previous = await make().acquire(subject, 'lease-owner');
  await make().release(previous);
  await assert.rejects(make().assertCurrent(previous), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  const replacement = await make().acquire(subject, 'other-owner');
  assert.ok(replacement.generation > previous.generation);
  await assert.rejects(make().release(previous), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  assert.equal((await make().assertCurrent(replacement)).ownerId, 'other-owner');
  await make().revoke(subject);
  await assert.rejects(make().release(replacement), (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  await assert.rejects(make().acquire(subject, 'revoked-worker'), (e: any) => e?.code === 'REMOTE_AUTHORITY_REVOKED');
});

test('a valid lease cannot commit an effect without independently authorized resource scope', async (t) => {
  const { make, subject } = await fixture(t);
  const lease = await make().acquire(subject, 'provider');
  await assert.rejects(make().commitProtected(lease, {
    namespace: 'unauthorized-effects', key: 'another-account', expectedGeneration: null,
    value: { leak: true }
  }), /provider scope denied/);
  assert.equal((await make().assertCurrent(lease)).generation, lease.generation);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-authority-no-mutation-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new EmbeddedControlPlaneStore(root);
  const noPolicy = new RemoteAuthorityFenceStore(store, { authorize: async () => {} });
  const token = await noPolicy.acquire({ ...subject, deviceId: crypto.randomUUID() }, 'no-scope-policy');
  await assert.rejects(noPolicy.commitProtected(token, {
    namespace: 'provider-effects', key: 'denied', expectedGeneration: null,
    value: { data: 1 }
  }), (e: any) => e?.code === 'REMOTE_AUTHORITY_MUTATION_POLICY_REQUIRED');
});

test('revoked authoritative account policy blocks old leases even before a global barrier arrives', async (t) => {
  const { make, subject, permit } = await fixture(t);
  const lease = await make().acquire(subject, 'delayed-remote-provider');
  assert.equal((await make().assertCurrent(lease)).generation, lease.generation);
  // Simulate a policy-plane revoke followed by an asynchronously delayed
  // cross-host control-plane revocation event. The policy check must deny
  // execution without relying only on the still-live lease record.
  permit(false);
  await assert.rejects(make().assertCurrent(lease), /authoritative policy denied request/);
  await assert.rejects(make().heartbeat(lease), /authoritative policy denied request/);
  await assert.rejects(make().release(lease), /authoritative policy denied request/);
  await assert.rejects(make().commitProtected(lease, {
    namespace: 'provider-effects', key: 'forbidden-after-policy-revoke',
    expectedGeneration: null, value: { effect: 'not-allowed' }
  }), /authoritative policy denied request/);
  // Prove this is a policy denial, not merely a CAS lease that happened to
  // expire. The owner token is otherwise unchanged and still present.
  permit(true);
  assert.equal((await make().assertCurrent(lease)).generation, lease.generation);
  await make().revoke(subject);
  await assert.rejects(make().assertCurrent(lease),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
});

test('foreign account cannot revoke another owner at a reused generation', async (t) => {
  const { make, subject } = await fixture(t);
  const unrelated = { ...subject, accountId: crypto.randomUUID() };
  const owner = await make().acquire(subject, 'owner-A');
  await assert.rejects(make().revoke(unrelated),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_FOREIGN_OWNER');
  assert.equal((await make().assertCurrent(owner)).ownerId, 'owner-A');
  const barrier = await make().revoke(subject);
  const before = barrier.generation;
  await assert.rejects(make().revoke(unrelated),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_FOREIGN_OWNER');
  const repeated = await make().revoke(subject);
  assert.ok(repeated.generation > before);
  assert.equal(repeated.revokedGeneration, subject.authorityGeneration);
  // Merely claiming a higher generation must not let a foreign tenant
  // rewrite the barrier; that tenant has not acquired authority yet.
  await assert.rejects(make().revoke({ ...unrelated, authorityGeneration: 2 }),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_FOREIGN_OWNER');
  await assert.rejects(make().acquire(unrelated, 'foreign-account-at-same-generation'),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_REVOKED');
  const newer = await make().acquire({ ...unrelated, authorityGeneration: 2 }, 'new-authority');
  assert.equal((await make().assertCurrent(newer)).ownerId, 'new-authority');
  await assert.rejects(make().revoke({ ...subject, authorityGeneration: 3 }),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_FOREIGN_OWNER');
  await assert.rejects(make().revoke(subject),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_NEWER_GENERATION');
  assert.equal((await make().assertCurrent(newer)).leaseId, newer.leaseId);
  const newerBarrier = await make().revoke({ ...unrelated, authorityGeneration: 2 });
  await assert.rejects(make().revoke(subject),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_NEWER_GENERATION');
  const finalBarrier = await make().revoke({ ...unrelated, authorityGeneration: 2 });
  assert.equal(finalBarrier.revokedGeneration, 2);
  assert.ok(finalBarrier.generation > newerBarrier.generation);
});

test('revoked authority record with forged device identity fails closed', async (t) => {
  const { make, subject } = await fixture(t);
  await make().revoke(subject);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-authority-corrupt-barrier-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // A forged state with valid schema cannot be used to revoke someone
  // else's record: read-side binding validates stored device versus CAS key.
  const store = new EmbeddedControlPlaneStore(dir);
  await store.transact([{ namespace: '__mecord_remote_authority', key: subject.deviceId,
    expectedGeneration: null, value: { kind: 'revoked', schemaVersion: 1,
      accountId: subject.accountId, deviceId: crypto.randomUUID(), revokedGeneration: 1 } }]);
  const scoped = new RemoteAuthorityFenceStore(store, { authorize: async () => {} });
  await assert.rejects(scoped.revoke(subject),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_CORRUPT');
});

test('expiry never transfers account ownership at a recycled generation', async (t) => {
  const { make, subject, advance } = await fixture(t);
  const first = await make().acquire(subject, 'old-owner', 5_000);
  const other = { ...subject, accountId: crypto.randomUUID() };
  advance(5_001);
  await assert.rejects(make().acquire(other, 'foreign-owner', 5_000),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_FOREIGN_OWNER');
  // A crashed worker from the same account can reacquire after its exact TTL,
  // with a new owner token and strictly higher control-plane CAS generation.
  const recovered = await make().acquire(subject, 'replacement-same-account', 5_000);
  assert.ok(recovered.generation > first.generation);
  await assert.rejects(make().assertCurrent(first),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  advance(5_001);
  const legitimatelyRebound = await make().acquire({
    ...other, authorityGeneration: subject.authorityGeneration + 1
  }, 'new-account-generation', 5_000);
  assert.ok(legitimatelyRebound.generation > recovered.generation);
});
