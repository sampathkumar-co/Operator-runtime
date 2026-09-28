import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../src/core/device-registry.ts';
import { SemanticCheckpointManager, semanticCheckpointDigest } from '../src/core/semantic-checkpoint.ts';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage15 accepts only checkpoints signed by an active paired source device', async (t) => {
  const sourceDir = await temp(t, 'operator-migrate-source-');
  const destinationDir = await temp(t, 'operator-migrate-dest-');
  const sourceIdentity = new DeviceIdentityStore(sourceDir, { platform: 'linux' });
  const sourcePublic = await sourceIdentity.loadOrCreate('source');
  const destinationIdentity = new DeviceIdentityStore(destinationDir, { platform: 'linux' });
  const registry = new DeviceRegistryStore(destinationDir);
  await registry.registerVerifiedPeer(sourcePublic);

  const sourceManager = new SemanticCheckpointManager(sourceDir, {
    identity: sourceIdentity,
    registry: new DeviceRegistryStore(sourceDir)
  });
  const destinationManager = new SemanticCheckpointManager(destinationDir, {
    identity: destinationIdentity,
    registry
  });
  const workloadId = crypto.randomUUID();
  const envelope = await sourceManager.create({
    workloadKind: 'task',
    workloadId,
    objectiveDigest: semanticCheckpointDigest('finish task'),
    stateDigest: semanticCheckpointDigest({ phase: 'verify', step: 4 }),
    authorityDigest: semanticCheckpointDigest({ capabilities: ['file.read'] }),
    requiredCapabilities: ['file.read'],
    resourceKeys: ['file:/project/a.txt'],
    artifactDigests: [{ key: 'a.txt', digest: semanticCheckpointDigest('content'), size: 7 }],
    worldAssumptions: [{ entityKey: 'project:test', factKey: 'revision', valueDigest: semanticCheckpointDigest('abc') }],
    completedStepDigests: [semanticCheckpointDigest('step-1')],
    continuation: { nextPhase: 'verify', planner: { kind: 'controlled-file-change' } }
  });
  const accepted = await destinationManager.verifyAndAccept(envelope, {
    expectedWorkloadId: workloadId,
    expectedAuthorityDigest: envelope.checkpoint.authorityDigest
  });
  assert.equal(accepted.sourceDeviceId, sourcePublic.deviceId);
  assert.equal(accepted.continuation.nextPhase, 'verify');

  await registry.revokeDevice(sourcePublic.deviceId, 'test revocation');
  await assert.rejects(
    () => destinationManager.verifyAndAccept(envelope),
    (error: any) => error?.code === 'SEMANTIC_CHECKPOINT_SOURCE_REVOKED'
  );
});

test('stage15 rejects tampering and secret-bearing continuation state', async (t) => {
  const sourceDir = await temp(t, 'operator-migrate-source-');
  const destDir = await temp(t, 'operator-migrate-dest-');
  const identity = new DeviceIdentityStore(sourceDir, { platform: 'linux' });
  const publicIdentity = await identity.loadOrCreate('source');
  const registry = new DeviceRegistryStore(destDir);
  await registry.registerVerifiedPeer(publicIdentity);
  const manager = new SemanticCheckpointManager(sourceDir, {
    identity,
    registry: new DeviceRegistryStore(sourceDir)
  });
  await assert.rejects(
    () => manager.create({
      workloadKind: 'operation',
      workloadId: crypto.randomUUID(),
      objectiveDigest: semanticCheckpointDigest('objective'),
      stateDigest: semanticCheckpointDigest('state'),
      authorityDigest: semanticCheckpointDigest('authority'),
      continuation: { authToken: 'should-never-migrate' }
    }),
    (error: any) => error?.code === 'SEMANTIC_CHECKPOINT_SECRET_REJECTED'
  );

  const envelope = await manager.create({
    workloadKind: 'operation',
    workloadId: crypto.randomUUID(),
    objectiveDigest: semanticCheckpointDigest('objective'),
    stateDigest: semanticCheckpointDigest('state'),
    authorityDigest: semanticCheckpointDigest('authority'),
    continuation: { phase: 'resume' }
  });
  const tampered = structuredClone(envelope);
  tampered.checkpoint.continuation.phase = 'different';
  const destination = new SemanticCheckpointManager(destDir, {
    identity: new DeviceIdentityStore(destDir, { platform: 'linux' }),
    registry
  });
  await assert.rejects(
    () => destination.verifyAndAccept(tampered),
    (error: any) => error?.code === 'SEMANTIC_CHECKPOINT_SIGNATURE_INVALID'
  );
});
