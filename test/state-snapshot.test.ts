import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StateSnapshotManager, currentSnapshotCatalogDigest } from '../src/core/state-snapshot.ts';
import { runOfflineStateSnapshot } from '../apps/local-agent/src/state-maintenance.ts';
import { acquireLocalAgentStateInstanceLock } from '../apps/local-agent/src/state-instance-lock.ts';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const quiescent = async <T>(operation: () => Promise<T>): Promise<T> => await operation();

test('coordinated snapshot verifies per-store digests and restores one catalog epoch', async (t) => {
  const state = await temp(t, 'operator-snapshot-state-');
  const snapshots = await temp(t, 'operator-snapshot-output-');
  await fs.mkdir(path.join(state, 'tasks'));
  await fs.writeFile(path.join(state, 'tasks', 'one.json'), '{"state":"before"}');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"version":1,"entities":[]}');
  await fs.writeFile(path.join(state, 'relay-session.token'), 'excluded-secret');
  const manager = new StateSnapshotManager(state, snapshots);
  const manifest = await manager.create({ epoch: 'epoch-1', withQuiescence: quiescent });
  assert.equal((await manager.verify('epoch-1')).manifestDigest, manifest.manifestDigest);

  await fs.writeFile(path.join(state, 'tasks', 'one.json'), '{"state":"after"}');
  await fs.writeFile(path.join(state, 'evaluations.json'), '{"version":1,"runs":[]}');
  await fs.writeFile(path.join(state, 'relay-session.token'), 'new-secret');
  await manager.restore({ epoch: 'epoch-1', withQuiescence: quiescent });
  assert.equal(await fs.readFile(path.join(state, 'tasks', 'one.json'), 'utf8'), '{"state":"before"}');
  await assert.rejects(fs.access(path.join(state, 'evaluations.json')));
  assert.equal(await fs.readFile(path.join(state, 'relay-session.token'), 'utf8'), 'new-secret');
});

test('snapshot interruption leaves no publishable partial epoch', async (t) => {
  const state = await temp(t, 'operator-snapshot-interrupt-state-');
  const snapshots = await temp(t, 'operator-snapshot-interrupt-output-');
  await fs.writeFile(path.join(state, 'audit.ndjson'), 'one\n');
  await fs.writeFile(path.join(state, 'world-model.json'), '{}');
  const manager = new StateSnapshotManager(state, snapshots);
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
  await fs.writeFile(path.join(state, 'audit.ndjson'), 'snapshot-value\n');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"snapshot":true}');
  const manager = new StateSnapshotManager(state, snapshots);
  const manifest = await manager.create({ epoch: 'rollback', withQuiescence: quiescent });
  await fs.writeFile(path.join(state, 'audit.ndjson'), 'live-value\n');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"live":true}');

  const controller = new AbortController();
  await assert.rejects(manager.restore({
    epoch: manifest.epoch, withQuiescence: quiescent, signal: controller.signal,
    onStoreRestored: () => controller.abort()
  }), (error: any) => error?.code === 'SNAPSHOT_ABORTED');
  assert.equal(await fs.readFile(path.join(state, 'audit.ndjson'), 'utf8'), 'live-value\n');
  assert.equal(await fs.readFile(path.join(state, 'world-model.json'), 'utf8'), '{"live":true}');

  const auditFile = manifest.stores.find((store) => store.id === 'audit-active')!.files[0]!.path;
  await fs.writeFile(path.join(snapshots, manifest.epoch, 'data', auditFile), 'tampered');
  await assert.rejects(manager.restore({ epoch: manifest.epoch, withQuiescence: quiescent }), (error: any) => error?.code === 'SNAPSHOT_FILE_TAMPERED');
  assert.equal(await fs.readFile(path.join(state, 'audit.ndjson'), 'utf8'), 'live-value\n');
});

test('production snapshot maintenance cannot overlap a live multi-store mutation owner', async (t) => {
  const state = await temp(t, 'operator-snapshot-owned-state-');
  const snapshots = await temp(t, 'operator-snapshot-owned-output-');
  const owner = await acquireLocalAgentStateInstanceLock(state);
  await fs.mkdir(path.join(state, 'tasks'));
  await fs.writeFile(path.join(state, 'tasks', 'one.json'), '{"epoch":"after"}');

  await assert.rejects(
    runOfflineStateSnapshot({ operation: 'create', stateDir: state, snapshotRoot: snapshots, epoch: 'overlap' }),
    (error: unknown) => (error as { code?: string }).code === 'LOCAL_AGENT_ALREADY_RUNNING'
  );
  await fs.writeFile(path.join(state, 'world-model.json'), '{"epoch":"after"}');
  await owner.release();

  await runOfflineStateSnapshot({ operation: 'create', stateDir: state, snapshotRoot: snapshots, epoch: 'coherent-after' });
  await fs.writeFile(path.join(state, 'tasks', 'one.json'), '{"epoch":"later"}');
  await fs.writeFile(path.join(state, 'world-model.json'), '{"epoch":"later"}');
  await runOfflineStateSnapshot({ operation: 'restore', stateDir: state, snapshotRoot: snapshots, epoch: 'coherent-after' });
  assert.equal(await fs.readFile(path.join(state, 'tasks', 'one.json'), 'utf8'), '{"epoch":"after"}');
  assert.equal(await fs.readFile(path.join(state, 'world-model.json'), 'utf8'), '{"epoch":"after"}');
});

test('cross-release restore requires and applies an exact catalog migration contract', async (t) => {
  const state = await temp(t, 'operator-snapshot-migration-state-');
  const snapshots = await temp(t, 'operator-snapshot-migration-output-');
  await fs.mkdir(path.join(state, 'tasks'));
  await fs.writeFile(path.join(state, 'tasks', 'one.json'), '{"release":"N"}');
  const creator = new StateSnapshotManager(state, snapshots);
  const original = await creator.create({ epoch: 'release-n', withQuiescence: quiescent });

  const manifestFile = path.join(snapshots, original.epoch, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const oldCatalogDigest = 'f'.repeat(64);
  manifest.catalogDigest = oldCatalogDigest;
  const base = {
    version: manifest.version,
    epoch: manifest.epoch,
    createdAt: manifest.createdAt,
    catalogDigest: manifest.catalogDigest,
    stores: manifest.stores
  };
  manifest.manifestDigest = crypto.createHash('sha256').update(JSON.stringify(base)).digest('hex');
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));

  await assert.rejects(creator.verify('release-n'), (error: unknown) =>
    (error as { code?: string }).code === 'SNAPSHOT_CATALOG_MISMATCH');
  const upgrader = new StateSnapshotManager(state, snapshots, { catalogMigrations: [{
    id: 'release-n-to-n-plus-1',
    fromCatalogDigest: oldCatalogDigest,
    toCatalogDigest: currentSnapshotCatalogDigest(),
    stores: manifest.stores.map((store: { id: string }) => ({ targetId: store.id, sourceId: store.id }))
  }] });
  await upgrader.verify('release-n');
  await fs.writeFile(path.join(state, 'tasks', 'one.json'), '{"release":"N+1"}');
  await upgrader.restore({ epoch: 'release-n', withQuiescence: quiescent });
  assert.equal(await fs.readFile(path.join(state, 'tasks', 'one.json'), 'utf8'), '{"release":"N"}');
});
