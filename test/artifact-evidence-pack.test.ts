import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/core/artifact-store.ts';
import { createEvidencePack, publishEvidencePack } from '../src/core/evidence-pack.ts';
import { executionContextDigest } from '../src/core/execution-context-identity.ts';

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
  const context = {
    schemaVersion: 1 as const, taskId: 'task-1', actionId: 'action-1', attempt: 1
  };
  const source = await store.put({
    bytes: JSON.stringify({ passed: 42, failed: 0 }),
    kind: 'test-report',
    mediaType: 'application/json',
    executionContextDigest: executionContextDigest(context),
    now: '2026-10-06T00:00:00.000Z'
  });
  const result = await publishEvidencePack(store, {
    executionContext: context,
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

test('artifact metadata owns and digests prototype-named JSON data fields without aliasing', async (t) => {
  const dir = await tempState();
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const store = new ArtifactStore(dir);
  const base = {
    bytes: 'same verified evidence',
    kind: 'test-report' as const,
    mediaType: 'application/json',
    now: '2026-10-09T00:00:00.000Z'
  };
  const ordinary = await store.put({ ...base, metadata: { role: 'reader' } });
  const specialMetadata = JSON.parse('{"__proto__":"principal-override","role":"reader"}');
  assert.equal(Object.hasOwn(specialMetadata, '__proto__'), true);
  const special = await store.put({ ...base, metadata: specialMetadata });
  assert.notEqual(ordinary.id, special.id);
  assert.equal(Object.hasOwn(special.metadata, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(special.metadata), Object.prototype);
  assert.equal(special.metadata['__proto__'], 'principal-override');
  assert.deepEqual(JSON.parse(JSON.stringify(special.metadata)), specialMetadata);
  const persisted = await new ArtifactStore(dir).get(special.id);
  assert.equal(Object.hasOwn(persisted.metadata, '__proto__'), true);
  assert.equal(persisted.metadata['__proto__'], 'principal-override');
  assert.equal((await store.read(special.id)).record.id, special.id);
});

test('C07 evidence publication rejects foreign and contextless artifacts despite valid hashes', async (t) => {
  const state = await tempState();
  t.after(async () => fs.rm(state, { recursive: true, force: true }));
  const store = new ArtifactStore(state);
  const taskA = { schemaVersion: 1 as const, taskId: 'task-A', actionId: 'save-A' };
  const taskB = { schemaVersion: 1 as const, taskId: 'task-B', actionId: 'save-B' };
  const foreign = await store.put({
    bytes: 'successful foreign task', kind: 'test-report', mediaType: 'text/plain',
    executionContextDigest: executionContextDigest(taskB)
  });
  const unbound = await store.put({
    bytes: 'unbound legacy output', kind: 'test-report', mediaType: 'text/plain'
  });
  for (const artifactId of [foreign.id, unbound.id]) {
    await assert.rejects(publishEvidencePack(store, {
      executionContext: taskA,
      artifactIds: [artifactId],
      claims: [{ id: 'verified', statement: 'Task A independently verified.',
        level: 'EMPIRICALLY_VERIFIED', artifactIds: [artifactId] }]
    }), (err: any) => err?.code === 'EVIDENCE_PACK_CONTEXT_MISMATCH');
  }
  assert.deepEqual(await store.list(), [unbound, foreign].sort((a,b) =>
    b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)));
});

test('C07 published evidence privacy cannot downgrade referenced sensitive data', async (t) => {
  const state = await tempState();
  t.after(async () => fs.rm(state, { recursive: true, force: true }));
  const store = new ArtifactStore(state);
  const context = { schemaVersion: 1 as const, taskId: 'private-verified' };
  const source = await store.put({
    bytes: 'redacted sensitive fixture', kind: 'test-report', mediaType: 'text/plain',
    privacy: 'sensitive', executionContextDigest: executionContextDigest(context)
  });
  const packInput = {
    executionContext: context, artifactIds: [source.id],
    claims: [{ id: 'proof', statement: 'Private task state observed.',
      level: 'EMPIRICALLY_VERIFIED' as const, artifactIds: [source.id] }]
  };
  for (const privacy of ['public', 'internal'] as const) {
    await assert.rejects(publishEvidencePack(store, packInput, privacy),
      (err: any) => err?.code === 'EVIDENCE_PACK_PRIVACY_DOWNGRADE');
  }
  const result = await publishEvidencePack(store, packInput, 'sensitive');
  assert.equal(result.artifact.privacy, 'sensitive');
  assert.equal(result.pack.executionContextDigest, executionContextDigest(context));
});

test('C07 proof identifiers must be dense literal digests and never execute coercion', () => {
  const digest = 'A'.repeat(64);
  let conversions = 0;
  const forged = { toString() { conversions++; return digest; } };
  const base = {
    executionContext: { schemaVersion: 1 as const, taskId: 'strict-proof' },
    artifactIds: [digest],
    claims: [{ id: 'claim', statement: 'A result is proven.',
      level: 'PROVEN' as const, artifactIds: [digest] }]
  };
  for (const artifacts of [[forged], new Array(1), Object.assign([digest], { extra: 'hidden' })]) {
    assert.throws(() => createEvidencePack({ ...base, artifactIds: artifacts as any }),
      (err: any) => err?.code === 'EVIDENCE_PACK_INVALID');
  }
  assert.equal(conversions, 0);
  const ordinary = createEvidencePack(base);
  assert.deepEqual(ordinary.artifactIds, ['a'.repeat(64)]);
});
