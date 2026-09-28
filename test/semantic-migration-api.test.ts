import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../src/core/device-registry.ts';
import { SemanticCheckpointManager } from '../src/core/semantic-checkpoint.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 0, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

class ReadCapabilityProvider implements CapabilityProvider {
  readonly name = 'migration-read-capability';
  supports(action: ActionRequest): boolean { return action.capability === 'file.read'; }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    return {
      ok: true, capability: action.capability, provider: this.name,
      output: {}, evidence: [], durationMs: 0
    };
  }
}

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage15 private API transfers a signed checkpoint only after destination capability, resource and artifact proof', async (t) => {
  const sourceState = await temp(t, 'operator-migration-api-source-state-');
  const sourceRoot = await temp(t, 'operator-migration-api-source-root-');
  const destinationState = await temp(t, 'operator-migration-api-dest-state-');
  const destinationRoot = await temp(t, 'operator-migration-api-dest-root-');
  const sourceArtifact = path.join(sourceRoot, 'bundle.bin');
  const destinationArtifact = path.join(destinationRoot, 'bundle.bin');
  await fs.writeFile(sourceArtifact, 'portable-artifact');
  await fs.writeFile(destinationArtifact, 'portable-artifact');

  const sourceIdentity = new DeviceIdentityStore(sourceState, { platform: 'linux' });
  const sourcePublic = await sourceIdentity.loadOrCreate('source-device');
  const sourceManager = new SemanticCheckpointManager(sourceState, {
    identity: sourceIdentity,
    registry: new DeviceRegistryStore(sourceState)
  });
  const sourceRuntime = new OperatorRuntime().register(new ReadCapabilityProvider());
  const sourceToken = 's'.repeat(64);
  const sourceAgent = createLocalAgentServer({
    runtime: sourceRuntime,
    token: sourceToken,
    semanticMigration: sourceManager,
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [sourceRoot] }
  });
  t.after(() => Promise.allSettled([sourceAgent.close(), sourceRuntime.close()]));
  const sourceBound = await sourceAgent.listen('127.0.0.1', 0);
  const sourceBase = `http://127.0.0.1:${sourceBound.port}`;
  const sourceHeaders = { authorization: `Bearer ${sourceToken}`, 'content-type': 'application/json' };
  const workloadId = crypto.randomUUID();
  const sourceResource = `file:${sourceArtifact}`;

  const createResponse = await fetch(`${sourceBase}/v1/migration/checkpoints`, {
    method: 'POST',
    headers: sourceHeaders,
    body: JSON.stringify({
      workloadKind: 'task',
      workloadId,
      objective: { kind: 'portable-read' },
      state: { phase: 'resume', completed: 2 },
      requiredCapabilities: ['file.read'],
      resourceKeys: [sourceResource],
      artifacts: [{ key: 'bundle', path: sourceArtifact }],
      continuation: { nextPhase: 'resume' }
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as any;
  assert.equal(created.envelope.checkpoint.sourceDeviceId, sourcePublic.deviceId);
  assert.equal(created.envelope.checkpoint.requiredCapabilities[0], 'file.read');
  assert.equal(created.envelope.checkpoint.artifactDigests[0].size, Buffer.byteLength('portable-artifact'));

  const destinationIdentity = new DeviceIdentityStore(destinationState, { platform: 'linux' });
  const destinationRegistry = new DeviceRegistryStore(destinationState);
  await destinationRegistry.registerVerifiedPeer(sourcePublic);
  const destinationManager = new SemanticCheckpointManager(destinationState, {
    identity: destinationIdentity,
    registry: destinationRegistry
  });
  const destinationRuntime = new OperatorRuntime().register(new ReadCapabilityProvider());
  const destinationToken = 'd'.repeat(64);
  const destinationAgent = createLocalAgentServer({
    runtime: destinationRuntime,
    token: destinationToken,
    semanticMigration: destinationManager,
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [destinationRoot] }
  });
  t.after(() => Promise.allSettled([destinationAgent.close(), destinationRuntime.close()]));
  const destinationBound = await destinationAgent.listen('127.0.0.1', 0);
  const destinationBase = `http://127.0.0.1:${destinationBound.port}`;
  const destinationHeaders = { authorization: `Bearer ${destinationToken}`, 'content-type': 'application/json' };

  assert.equal((await fetch(`${destinationBase}/v1/migration/checkpoints/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope: created.envelope })
  })).status, 401);

  const destinationResource = `file:${destinationArtifact}`;
  const acceptResponse = await fetch(`${destinationBase}/v1/migration/checkpoints/accept`, {
    method: 'POST',
    headers: destinationHeaders,
    body: JSON.stringify({
      envelope: created.envelope,
      expectedWorkloadId: workloadId,
      resourceMap: { [sourceResource]: destinationResource },
      artifactPaths: { bundle: destinationArtifact }
    })
  });
  assert.equal(acceptResponse.status, 200);
  const accepted = await acceptResponse.json() as any;
  assert.equal(accepted.status, 'accepted-for-resume');
  assert.equal(accepted.checkpoint.workloadId, workloadId);
  assert.equal(accepted.checkpoint.continuation.nextPhase, 'resume');
});

test('stage15 private API fails closed on destination artifact or resource mismatch', async (t) => {
  const sourceState = await temp(t, 'operator-migration-api2-source-state-');
  const sourceRoot = await temp(t, 'operator-migration-api2-source-root-');
  const destinationState = await temp(t, 'operator-migration-api2-dest-state-');
  const destinationRoot = await temp(t, 'operator-migration-api2-dest-root-');
  const outsideRoot = await temp(t, 'operator-migration-api2-outside-');
  const sourceArtifact = path.join(sourceRoot, 'bundle.bin');
  const destinationArtifact = path.join(destinationRoot, 'bundle.bin');
  const wrongArtifact = path.join(destinationRoot, 'wrong.bin');
  const outsideArtifact = path.join(outsideRoot, 'outside.bin');
  await fs.writeFile(sourceArtifact, 'expected');
  await fs.writeFile(destinationArtifact, 'expected');
  await fs.writeFile(wrongArtifact, 'wrong');
  await fs.writeFile(outsideArtifact, 'expected');

  const sourceIdentity = new DeviceIdentityStore(sourceState, { platform: 'linux' });
  const sourcePublic = await sourceIdentity.loadOrCreate('source-device-2');
  const sourceManager = new SemanticCheckpointManager(sourceState, { identity: sourceIdentity, registry: new DeviceRegistryStore(sourceState) });
  const sourceRuntime = new OperatorRuntime().register(new ReadCapabilityProvider());
  const token = 'x'.repeat(64);
  const sourceAgent = createLocalAgentServer({
    runtime: sourceRuntime, token, semanticMigration: sourceManager,
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [sourceRoot] }
  });
  t.after(() => Promise.allSettled([sourceAgent.close(), sourceRuntime.close()]));
  const sourceBound = await sourceAgent.listen('127.0.0.1', 0);
  const sourceResource = `file:${sourceArtifact}`;
  const created = await (await fetch(`http://127.0.0.1:${sourceBound.port}/v1/migration/checkpoints`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      workloadKind: 'task', workloadId: crypto.randomUUID(), objective: 'o', state: { phase: 1 },
      requiredCapabilities: ['file.read'], resourceKeys: [sourceResource],
      artifacts: [{ key: 'bundle', path: sourceArtifact }], continuation: { phase: 'resume' }
    })
  })).json() as any;

  const registry = new DeviceRegistryStore(destinationState);
  await registry.registerVerifiedPeer(sourcePublic);
  const destinationRuntime = new OperatorRuntime().register(new ReadCapabilityProvider());
  const destinationAgent = createLocalAgentServer({
    runtime: destinationRuntime, token,
    semanticMigration: new SemanticCheckpointManager(destinationState, {
      identity: new DeviceIdentityStore(destinationState, { platform: 'linux' }), registry
    }),
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [destinationRoot] }
  });
  t.after(() => Promise.allSettled([destinationAgent.close(), destinationRuntime.close()]));
  const bound = await destinationAgent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const wrong = await fetch(`${base}/v1/migration/checkpoints/accept`, {
    method: 'POST', headers,
    body: JSON.stringify({
      envelope: created.envelope,
      resourceMap: { [sourceResource]: `file:${destinationArtifact}` },
      artifactPaths: { bundle: wrongArtifact }
    })
  });
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json() as any).error.code, 'SEMANTIC_CHECKPOINT_ARTIFACT_MISMATCH');

  const escaped = await fetch(`${base}/v1/migration/checkpoints/accept`, {
    method: 'POST', headers,
    body: JSON.stringify({
      envelope: created.envelope,
      resourceMap: { [sourceResource]: `file:${outsideArtifact}` },
      artifactPaths: { bundle: destinationArtifact }
    })
  });
  assert.equal(escaped.status, 409);
  assert.equal((await escaped.json() as any).error.code, 'SEMANTIC_CHECKPOINT_RESOURCE_MISMATCH');
});
