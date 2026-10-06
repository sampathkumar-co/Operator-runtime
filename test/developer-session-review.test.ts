import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/core/artifact-store.ts';
import {
  createDeveloperSession,
  DeveloperSessionStore,
  updateDeveloperSession
} from '../src/core/developer-session.ts';
import { DeveloperSessionReviewCoordinator } from '../src/core/developer-session-review.ts';

test('Developer Session pause survives coordinator restart and resumes only from immutable manifest', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-review-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(stateDir);
  const evidence = await artifacts.put({
    bytes: 'verified test output',
    kind: 'test-report',
    mediaType: 'text/plain',
    privacy: 'internal'
  });

  const store = new DeveloperSessionStore(stateDir);
  const created = createDeveloperSession({
    objective: 'Ship a verified parser change.',
    acceptanceCriteria: ['Parser tests pass.'],
    constraints: ['No unrelated files.'],
    workspaceRootNodeId: 'workspace:root',
    now: '2026-10-06T00:00:00.000Z'
  });
  const active = updateDeveloperSession(created, {
    status: 'ACTIVE',
    artifactIds: [evidence.id],
    checkpointIds: ['checkpoint-1'],
    approvalIds: ['approval-1'],
    activeResourceKeys: [
      'fs-path:/worktrees/session',
      'network:tcp:43123',
      'process:00000000-0000-4000-8000-000000000001'
    ]
  }, '2026-10-06T00:00:01.000Z');
  await store.put(active);

  const first = new DeveloperSessionReviewCoordinator(stateDir);
  const paused = await first.pause({
    sessionId: active.id,
    resumeSummary: 'Edit is applied; rerun parser tests after reboot.',
    now: '2026-10-06T00:00:02.000Z'
  });
  assert.equal(paused.session.status, 'PAUSED');
  assert.ok(paused.session.artifactIds.includes(paused.artifactId));
  assert.deepEqual(paused.manifest.activeResourceKeys, active.activeResourceKeys);

  const restarted = new DeveloperSessionReviewCoordinator(stateDir);
  const resumed = await restarted.resume({
    sessionId: active.id,
    resumeManifestArtifactId: paused.artifactId,
    now: '2026-10-06T00:00:03.000Z'
  });
  assert.equal(resumed.session.status, 'ACTIVE');
  assert.deepEqual(resumed.session.activeResourceKeys, active.activeResourceKeys);
  assert.match(resumed.session.resumeSummary ?? '', /re-observe active resources/);
});

test('resume fails closed if durable session changed after pause manifest', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-review-tamper-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const store = new DeveloperSessionStore(stateDir);
  const active = updateDeveloperSession(createDeveloperSession({
    objective: 'Objective',
    acceptanceCriteria: ['Criterion'],
    workspaceRootNodeId: 'workspace:root'
  }), { status: 'ACTIVE' });
  await store.put(active);

  const coordinator = new DeveloperSessionReviewCoordinator(stateDir);
  const paused = await coordinator.pause({
    sessionId: active.id,
    resumeSummary: 'Resume exactly here.'
  });
  const stored = await store.get(active.id);
  await store.put(updateDeveloperSession(stored, {
    activeResourceKeys: ['network:tcp:9999']
  }));

  await assert.rejects(
    () => new DeveloperSessionReviewCoordinator(stateDir).resume({
      sessionId: active.id,
      resumeManifestArtifactId: paused.artifactId
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_RESUME_STATE_CHANGED');
      return true;
    }
  );
});

test('external review summary binds session state and attached Evidence Pack without prose trust', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-review-external-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(stateDir);
  const pack = await artifacts.put({
    bytes: '{"proof":"immutable"}',
    kind: 'evidence-pack',
    mediaType: 'application/json',
    privacy: 'internal'
  });
  const store = new DeveloperSessionStore(stateDir);
  const completed = updateDeveloperSession(createDeveloperSession({
    objective: 'Reviewable objective',
    acceptanceCriteria: ['Verified outcome exists.'],
    workspaceRootNodeId: 'workspace:root'
  }), {
    status: 'COMPLETED',
    artifactIds: [pack.id]
  });
  await store.put(completed);

  const review = await new DeveloperSessionReviewCoordinator(stateDir).publishExternalReview({
    sessionId: completed.id,
    evidencePackArtifactId: pack.id
  });
  assert.match(review.summary.id, /^[0-9a-f]{64}$/);
  assert.equal(review.summary.evidencePackArtifactId, pack.id);
  const saved = await artifacts.read(review.artifactId);
  assert.equal(saved.record.kind, 'review-summary');
  assert.equal(saved.record.metadata.reviewType, 'developer-external-review');
});
