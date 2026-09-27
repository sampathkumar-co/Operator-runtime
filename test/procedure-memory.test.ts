import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProcedureMemoryStore, assumptionFingerprint } from '../src/core/procedure-memory.ts';

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-procedure-memory-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage5 reuses only active unexpired procedures whose verified assumptions still match', async (t) => {
  const state = await tempDir(t);
  const store = new ProcedureMemoryStore(state);
  const node = assumptionFingerprint({ runtime: 'node-22', lock: 'abc' });
  const git = assumptionFingerprint({ head: '123' });
  const procedure = await store.recordVerified({
    key: 'deploy-next',
    title: 'Deploy verified Next app',
    objectiveKind: 'deployment',
    scopeKey: 'project:shop',
    steps: [
      { capability: 'project.command.run', risk: 'read', summary: 'Run trusted build.' },
      { capability: 'project.transaction.run', risk: 'destructive', summary: 'Run bounded release transaction.' }
    ],
    assumptions: [{ key: 'runtime', fingerprint: node }, { key: 'git', fingerprint: git }],
    resources: ['repo:shop'],
    verificationDigest: 'a'.repeat(64),
    verifierEvidenceDigest: 'b'.repeat(64)
  });

  const reusable = await store.findReusable({
    objectiveKind: 'deployment',
    scopeKey: 'project:shop',
    assumptions: [{ key: 'runtime', fingerprint: node }, { key: 'git', fingerprint: git }]
  });
  assert.equal(reusable.length, 1);
  assert.equal(reusable[0]?.procedure.id, procedure.id);

  const changed = await store.findReusable({
    objectiveKind: 'deployment',
    scopeKey: 'project:shop',
    assumptions: [{ key: 'runtime', fingerprint: node }, { key: 'git', fingerprint: assumptionFingerprint({ head: 'changed' }) }]
  });
  assert.equal(changed.length, 0);
});

test('stage5 never stores raw assumption values and persists only fingerprints/summaries', async (t) => {
  const state = await tempDir(t);
  const store = new ProcedureMemoryStore(state);
  const secret = 'super-secret-token';
  await store.recordVerified({
    key: 'safe-procedure',
    title: 'Safe',
    objectiveKind: 'build',
    scopeKey: 'project:alpha',
    steps: [{ capability: 'project.command.run', risk: 'read', summary: 'Run trusted build alias; no raw args persisted.' }],
    assumptions: [{ key: 'secret-config', fingerprint: assumptionFingerprint({ secret }) }],
    verificationDigest: 'c'.repeat(64),
    verifierEvidenceDigest: 'd'.repeat(64)
  });
  const persisted = await fs.readFile(path.join(state, 'verified-procedures.json'), 'utf8');
  assert.doesNotMatch(persisted, /super-secret-token/);
  assert.match(persisted, /secret-config/);
});

test('stage5 repeated failed reuse suspends a procedure instead of blindly preferring it', async (t) => {
  const state = await tempDir(t);
  const store = new ProcedureMemoryStore(state);
  const procedure = await store.recordVerified({
    key: 'fragile',
    title: 'Fragile',
    objectiveKind: 'test',
    scopeKey: 'project:x',
    steps: [{ capability: 'project.command.run', risk: 'read', summary: 'Test.' }],
    assumptions: [],
    verificationDigest: 'e'.repeat(64),
    verifierEvidenceDigest: 'f'.repeat(64)
  });
  await store.recordOutcome(procedure.id, 'failed');
  await store.recordOutcome(procedure.id, 'failed');
  const suspended = await store.recordOutcome(procedure.id, 'failed');
  assert.equal(suspended.status, 'SUSPENDED');
  assert.equal((await store.findReusable({ objectiveKind: 'test', scopeKey: 'project:x', assumptions: [] })).length, 0);
});

test('stage5 explicit invalidation prevents reuse until a newly verified version is promoted', async (t) => {
  const state = await tempDir(t);
  const store = new ProcedureMemoryStore(state);
  const first = await store.recordVerified({
    key: 'release',
    title: 'Release',
    objectiveKind: 'release',
    scopeKey: 'project:r',
    steps: [{ capability: 'git.status', risk: 'read', summary: 'Inspect.' }],
    assumptions: [],
    verificationDigest: '1'.repeat(64),
    verifierEvidenceDigest: '2'.repeat(64)
  });
  const invalid = await store.invalidate(first.id, 'runtime upgraded');
  assert.equal(invalid.status, 'INVALIDATED');
  assert.equal((await store.findReusable({ objectiveKind: 'release', scopeKey: 'project:r', assumptions: [] })).length, 0);

  const second = await store.recordVerified({
    key: 'release',
    title: 'Release v2',
    objectiveKind: 'release',
    scopeKey: 'project:r',
    steps: [{ capability: 'git.status', risk: 'read', summary: 'Inspect with new runtime.' }],
    assumptions: [],
    verificationDigest: '3'.repeat(64),
    verifierEvidenceDigest: '4'.repeat(64)
  });
  assert.equal(second.id, first.id);
  assert.equal(second.version, 2);
  assert.equal(second.status, 'ACTIVE');
});

test('stage5 required capabilities filter procedure selection without granting any capability', async (t) => {
  const state = await tempDir(t);
  const store = new ProcedureMemoryStore(state);
  await store.recordVerified({
    key: 'inspect-only',
    title: 'Inspect',
    objectiveKind: 'maintenance',
    scopeKey: 'project:m',
    steps: [{ capability: 'file.read', risk: 'read', summary: 'Read.' }],
    assumptions: [],
    verificationDigest: '5'.repeat(64),
    verifierEvidenceDigest: '6'.repeat(64)
  });
  assert.equal((await store.findReusable({
    objectiveKind: 'maintenance', scopeKey: 'project:m', assumptions: [], requiredCapabilities: ['file.read']
  })).length, 1);
  assert.equal((await store.findReusable({
    objectiveKind: 'maintenance', scopeKey: 'project:m', assumptions: [], requiredCapabilities: ['process.manage']
  })).length, 0);
});
