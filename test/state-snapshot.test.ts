import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StateSnapshotManager, currentSnapshotCatalogDigest, type SnapshotAuthenticator } from '../src/core/state-snapshot.ts';
import { runOfflineStateSnapshot } from '../apps/local-agent/src/state-maintenance.ts';
import { acquireLocalAgentStateInstanceLock } from '../apps/local-agent/src/state-instance-lock.ts';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const quiescent = async <T>(operation: () => Promise<T>): Promise<T> => await operation();

function testAuthenticator(): SnapshotAuthenticator {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    keyId: crypto.createHash('sha256').update(publicPem).digest('base64url'),
    sign: async (payload) => crypto.sign(null, payload, privateKey).toString('base64url'),
    verify: async (payload, signature) => crypto.verify(null, payload, publicKey, Buffer.from(signature, 'base64url'))
  };
}

test('coordinated snapshot verifies per-store digests and restores one catalog epoch', async (t) => {
  const state = await temp(t, 'operator-snapshot-state-');
  const snapshots = await temp(t, 'operator-snapshot-output-');
  await fs.mkdir(path.join(state, 'tasks'));
  await fs.writeFile(path.join(state, 'tasks', 'one.json'), '{"state":"before"}');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"version":1,"entities":[]}');
  await fs.writeFile(path.join(state, 'relay-session.token'), 'excluded-secret');
  const manager = new StateSnapshotManager(state, snapshots, { authenticator: testAuthenticator() });
  const manifest = await manager.create({ epoch: 'epoch-1', withQuiescence: quiescent });
  assert.equal((await manager.verify('epoch-1')).manifestDigest, manifest.manifestDigest);

  await fs.writeFile(path.join(state, 'world-model.json'), '{"version":1,"entities":[{"id":"after"}]}');
  await fs.writeFile(path.join(state, 'evaluations.json'), '{"version":1,"runs":[]}');
  await fs.writeFile(path.join(state, 'relay-session.token'), 'new-secret');
  await manager.restore({ epoch: 'epoch-1', withQuiescence: quiescent });
  assert.equal(await fs.readFile(path.join(state, 'tasks', 'one.json'), 'utf8'), '{"state":"before"}');
  assert.equal(await fs.readFile(path.join(state, 'world-model.json'), 'utf8'), '{"version":1,"entities":[]}');
  await assert.rejects(fs.access(path.join(state, 'evaluations.json')));
  assert.equal(await fs.readFile(path.join(state, 'relay-session.token'), 'utf8'), 'new-secret');
});

test('snapshot interruption leaves no publishable partial epoch', async (t) => {
  const state = await temp(t, 'operator-snapshot-interrupt-state-');
  const snapshots = await temp(t, 'operator-snapshot-interrupt-output-');
  await fs.writeFile(path.join(state, 'audit.ndjson'), 'one\n');
  await fs.writeFile(path.join(state, 'world-model.json'), '{}');
  const manager = new StateSnapshotManager(state, snapshots, { authenticator: testAuthenticator() });
  const controller = new AbortController();
  await assert.rejects(
    manager.create({
      epoch: 'interrupted', withQuiescence: quiescent, signal: controller.signal,
      onFileCopied: () => controller.abort()
    }),
    (error: any) => error?.code === 'SNAPSHOT_ABORTED'
  );
  await assert.rejects(fs.access(path.join(snapshots, 'interrupted')));
  assert.deepEqual((await fs.readdir(snapshots)).filter((name) => name.startsWith('.partial-')), []);
});

test('restore verifies payload before mutation and rolls back an interrupted apply', async (t) => {
  const state = await temp(t, 'operator-restore-state-');
  const snapshots = await temp(t, 'operator-restore-output-');
  await fs.writeFile(path.join(state, 'provider-learning.json'), '{"snapshot":true}');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"snapshot":true}');
  const manager = new StateSnapshotManager(state, snapshots, { authenticator: testAuthenticator() });
  const manifest = await manager.create({ epoch: 'rollback', withQuiescence: quiescent });
  await fs.writeFile(path.join(state, 'provider-learning.json'), '{"live":true}');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"live":true}');

  const controller = new AbortController();
  await assert.rejects(manager.restore({
    epoch: manifest.epoch, withQuiescence: quiescent, signal: controller.signal,
    onStoreRestored: () => controller.abort()
  }), (error: any) => error?.code === 'SNAPSHOT_ABORTED');
  assert.equal(await fs.readFile(path.join(state, 'provider-learning.json'), 'utf8'), '{"live":true}');
  assert.equal(await fs.readFile(path.join(state, 'world-model.json'), 'utf8'), '{"live":true}');

  const providerFile = manifest.stores.find((store) => store.id === 'provider-learning')!.files[0]!.path;
  await fs.writeFile(path.join(snapshots, manifest.epoch, 'data', providerFile), 'tampered');
  await assert.rejects(manager.restore({ epoch: manifest.epoch, withQuiescence: quiescent }), (error: any) => error?.code === 'SNAPSHOT_FILE_TAMPERED');
  assert.equal(await fs.readFile(path.join(state, 'provider-learning.json'), 'utf8'), '{"live":true}');
});

test('restore refuses to cross newer monotonic authority before mutating rewindable state', async (t) => {
  const state = await temp(t, 'operator-snapshot-authority-state-');
  const snapshots = await temp(t, 'operator-snapshot-authority-output-');
  await fs.mkdir(path.join(state, 'tasks'));
  await fs.writeFile(path.join(state, 'tasks', 'one.json'), '{"state":"authorized-before"}');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"state":"snapshot"}');
  const manager = new StateSnapshotManager(state, snapshots, { authenticator: testAuthenticator() });
  await manager.create({ epoch: 'authority-before', withQuiescence: quiescent });

  await fs.writeFile(path.join(state, 'tasks', 'one.json'), '{"state":"revoked-newer"}');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"state":"live-newer"}');
  await assert.rejects(
    manager.restore({ epoch: 'authority-before', withQuiescence: quiescent }),
    (error: any) => error?.code === 'SNAPSHOT_AUTHORITY_STALE'
  );
  assert.equal(await fs.readFile(path.join(state, 'tasks', 'one.json'), 'utf8'), '{"state":"revoked-newer"}');
  assert.equal(await fs.readFile(path.join(state, 'world-model.json'), 'utf8'), '{"state":"live-newer"}');
});

test('snapshot manifest remains tamper-evident when an attacker recomputes the public digest', async (t) => {
  const state = await temp(t, 'operator-snapshot-signature-state-');
  const snapshots = await temp(t, 'operator-snapshot-signature-output-');
  const authenticator = testAuthenticator();
  await fs.writeFile(path.join(state, 'world-model.json'), '{"state":"signed"}');
  const manager = new StateSnapshotManager(state, snapshots, { authenticator });
  const original = await manager.create({ epoch: 'signed', withQuiescence: quiescent });

  const manifestFile = path.join(snapshots, original.epoch, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.createdAt = new Date(Date.parse(manifest.createdAt) + 1000).toISOString();
  const unsigned = {
    version: manifest.version,
    epoch: manifest.epoch,
    createdAt: manifest.createdAt,
    catalogDigest: manifest.catalogDigest,
    authorityDigest: manifest.authorityDigest,
    stores: manifest.stores,
    signerKeyId: manifest.signerKeyId
  };
  manifest.manifestDigest = crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));

  await assert.rejects(manager.verify(original.epoch), (error: any) => error?.code === 'SNAPSHOT_SIGNATURE_INVALID');
});

test('restore preserves transaction evidence when rollback itself becomes incomplete', async (t) => {
  const state = await temp(t, 'operator-restore-incomplete-state-');
  const snapshots = await temp(t, 'operator-restore-incomplete-output-');
  await fs.writeFile(path.join(state, 'provider-learning.json'), '{"state":"snapshot"}');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"state":"snapshot"}');
  const manager = new StateSnapshotManager(state, snapshots, { authenticator: testAuthenticator() });
  await manager.create({ epoch: 'rollback-incomplete', withQuiescence: quiescent });
  await fs.writeFile(path.join(state, 'provider-learning.json'), '{"state":"live"}');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"state":"live"}');

  const controller = new AbortController();
  let preservedTransaction = '';
  await assert.rejects(manager.restore({
    epoch: 'rollback-incomplete',
    withQuiescence: quiescent,
    signal: controller.signal,
    onStoreRestored: async (count) => {
      if (count !== 1) return;
      const parent = path.dirname(state);
      for (const name of await fs.readdir(parent)) {
        if (!name.startsWith('.mecord-restore-')) continue;
        const candidate = path.join(parent, name, 'rollback', 'provider-learning.json');
        try {
          if (await fs.readFile(candidate, 'utf8') !== '{"state":"live"}') continue;
          await fs.rm(candidate, { force: true });
          preservedTransaction = path.join(parent, name);
          break;
        } catch { /* not this transaction */ }
      }
      controller.abort();
    }
  }), (error: any) => error?.code === 'SNAPSHOT_ROLLBACK_INCOMPLETE');
  assert.ok(preservedTransaction);
  await fs.access(preservedTransaction);
});

test('production snapshot maintenance cannot overlap a live multi-store mutation owner', async (t) => {
  const state = await temp(t, 'operator-snapshot-owned-state-');
  const snapshots = await temp(t, 'operator-snapshot-owned-output-');
  const authenticator = testAuthenticator();
  const owner = await acquireLocalAgentStateInstanceLock(state);
  await fs.mkdir(path.join(state, 'tasks'));
  await fs.writeFile(path.join(state, 'tasks', 'one.json'), '{"epoch":"after"}');

  await assert.rejects(
    runOfflineStateSnapshot({ operation: 'create', stateDir: state, snapshotRoot: snapshots, epoch: 'overlap', authenticator }),
    (error: unknown) => (error as { code?: string }).code === 'LOCAL_AGENT_ALREADY_RUNNING'
  );
  await fs.writeFile(path.join(state, 'world-model.json'), '{"epoch":"after"}');
  await owner.release();

  await runOfflineStateSnapshot({ operation: 'create', stateDir: state, snapshotRoot: snapshots, epoch: 'coherent-after', authenticator });
  await fs.writeFile(path.join(state, 'world-model.json'), '{"epoch":"later"}');
  await runOfflineStateSnapshot({ operation: 'restore', stateDir: state, snapshotRoot: snapshots, epoch: 'coherent-after', authenticator });
  assert.equal(await fs.readFile(path.join(state, 'tasks', 'one.json'), 'utf8'), '{"epoch":"after"}');
  assert.equal(await fs.readFile(path.join(state, 'world-model.json'), 'utf8'), '{"epoch":"after"}');
});

test('cross-release restore requires and applies an exact catalog migration contract', async (t) => {
  const state = await temp(t, 'operator-snapshot-migration-state-');
  const snapshots = await temp(t, 'operator-snapshot-migration-output-');
  const authenticator = testAuthenticator();
  await fs.writeFile(path.join(state, 'world-model.json'), '{"release":"N"}');
  const creator = new StateSnapshotManager(state, snapshots, { authenticator });
  const original = await creator.create({ epoch: 'release-n', withQuiescence: quiescent });

  const manifestFile = path.join(snapshots, original.epoch, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const oldCatalogDigest = 'f'.repeat(64);
  manifest.catalogDigest = oldCatalogDigest;
  const unsigned = {
    version: manifest.version,
    epoch: manifest.epoch,
    createdAt: manifest.createdAt,
    catalogDigest: manifest.catalogDigest,
    authorityDigest: manifest.authorityDigest,
    stores: manifest.stores,
    signerKeyId: manifest.signerKeyId
  };
  manifest.manifestDigest = crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  const payload = Buffer.from(JSON.stringify({ purpose: 'mecord-state-snapshot-v2', manifestDigest: manifest.manifestDigest, signerKeyId: manifest.signerKeyId }), 'utf8');
  manifest.signature = await authenticator.sign(payload);
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));

  await assert.rejects(creator.verify('release-n'), (error: unknown) =>
    (error as { code?: string }).code === 'SNAPSHOT_CATALOG_MISMATCH');
  const upgrader = new StateSnapshotManager(state, snapshots, { authenticator, catalogMigrations: [{
    id: 'release-n-to-n-plus-1',
    fromCatalogDigest: oldCatalogDigest,
    toCatalogDigest: currentSnapshotCatalogDigest(),
    stores: manifest.stores.map((store: { id: string }) => ({ targetId: store.id, sourceId: store.id }))
  }] });
  await upgrader.verify('release-n');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"release":"N+1"}');
  await upgrader.restore({ epoch: 'release-n', withQuiescence: quiescent });
  assert.equal(await fs.readFile(path.join(state, 'world-model.json'), 'utf8'), '{"release":"N"}');
});
