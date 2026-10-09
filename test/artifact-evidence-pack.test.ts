import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/core/artifact-store.ts';
import { createEvidencePack, publishEvidencePack } from '../src/core/evidence-pack.ts';

async function tempState(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-artifacts-'));
}

test('artifact store content-addresses blobs and reuses identical immutable records', async (t) => {
  const dir = await tempState();
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const store = new ArtifactStore(dir);
  const input = {
    bytes: 'verified output',
    kind: 'test-report' as const,
    mediaType: 'text/plain',
    privacy: 'internal' as const,
    metadata: { suite: 'unit', passed: true },
    now: '2026-10-06T00:00:00.000Z'
  };
  const first = await store.put(input);
  const second = await store.put({ ...input, now: '2026-10-06T00:01:00.000Z' });
  assert.equal(first.id, second.id);
  assert.equal(second.createdAt, first.createdAt);
  const read = await store.read(first.id);
  assert.equal(read.bytes.toString('utf8'), 'verified output');
  assert.equal(read.record.blobDigest, first.blobDigest);
});

test('artifact store detects blob tampering', async (t) => {
  const dir = await tempState();
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const store = new ArtifactStore(dir);
  const record = await store.put({
    bytes: 'original',
    kind: 'log',
    mediaType: 'text/plain',
    now: '2026-10-06T00:00:00.000Z'
  });
  const blob = path.join(dir, 'artifacts', 'blobs', 'sha256', record.blobDigest.slice(0, 2), record.blobDigest);
  await fs.writeFile(blob, 'tampered');
  await assert.rejects(() => store.read(record.id), /digest or size does not match/);
});

test('Evidence Pack refuses strong proof claims without referenced evidence', () => {
  const artifactId = 'a'.repeat(64);
  assert.throws(() => createEvidencePack({
    executionContext: { schemaVersion: 1, taskId: 'task-1' },
    artifactIds: [artifactId],
    claims: [{
      id: 'claim-1',
      statement: 'The deployment is healthy.',
      level: 'PROVEN',
      artifactIds: []
    }],
    now: '2026-10-06T00:00:00.000Z'
  }), /requires evidence artifacts/);
});

test('Evidence Pack can be published as a content-addressed artifact', async (t) => {
  const dir = await tempState();
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const store = new ArtifactStore(dir);
  const source = await store.put({
    bytes: JSON.stringify({ passed: 42, failed: 0 }),
    kind: 'test-report',
    mediaType: 'application/json',
    executionContextDigest: 'b'.repeat(64),
    now: '2026-10-06T00:00:00.000Z'
  });
  const result = await publishEvidencePack(store, {
    executionContext: {
      schemaVersion: 1,
      taskId: 'task-1',
      actionId: 'action-1',
      attempt: 1
    },
    artifactIds: [source.id],
    claims: [{
      id: 'tests-pass',
      statement: 'The focused test suite passed.',
      level: 'EMPIRICALLY_VERIFIED',
      artifactIds: [source.id],
      verifier: 'node:test'
    }],
    residualUncertainty: ['Full platform certification has not run.'],
    rollbackStatus: 'AVAILABLE',
    now: '2026-10-06T00:00:01.000Z'
  });
  assert.equal(result.artifact.kind, 'evidence-pack');
  const stored = await store.read(result.artifact.id);
  assert.match(stored.bytes.toString('utf8'), /EMPIRICALLY_VERIFIED/);
});

test('artifact list limits by recency rather than lexicographic content address', async (t) => {
  const scratchDir = await tempState();
  const stateDir = await tempState();
  t.after(async () => {
    await fs.rm(scratchDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const scratch = new ArtifactStore(scratchDir);
  const candidates = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    scratch.put({
      bytes: 'candidate-' + i,
      kind: 'test-report',
      mediaType: 'text/plain',
      now: '2026-10-06T00:00:00.000Z'
    })
  ));

  // Arrange timestamps in increasing *hash* order, so the newest records
  // necessarily fall beyond any naive ID-sorted prefix.
  const orderedById = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const store = new ArtifactStore(stateDir);
  const inserted = [];
  for (const [index, item] of orderedById.entries()) {
    const candidateIndex = candidates.findIndex(row => row.id === item.id);
    const record = await store.put({
      bytes: 'candidate-' + candidateIndex,
      kind: 'test-report',
      mediaType: 'text/plain',
      now: new Date(Date.UTC(2026, 9, 6, 0, index)).toISOString()
    });
    assert.equal(record.id, item.id);
    inserted.push(record);
  }
  const expected = [...inserted].reverse().slice(0, 2).map(record => record.id);
  const limited = await new ArtifactStore(stateDir).list(2);
  assert.deepEqual(limited.map(record => record.id), expected);
  assert.deepEqual((await store.list(5)).map(record => record.id), [...inserted].reverse().map(record => record.id));
});
