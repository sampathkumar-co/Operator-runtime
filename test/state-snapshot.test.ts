import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StateSnapshotManager } from '../src/core/state-snapshot.ts';

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
