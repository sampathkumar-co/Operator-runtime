import assert from 'node:assert/strict';
import test from 'node:test';
import { createCounterfactualTwinManifest } from '../src/core/counterfactual-twin.ts';
import {
  executeCounterfactualTwinAlternatives,
  selectCounterfactualAlternative,
  type TwinExecutionAdapter
} from '../src/core/counterfactual-twin-execution.ts';

const manifest = createCounterfactualTwinManifest({
  workspaceGraphId: '1'.repeat(64),
  environmentDigest: '2'.repeat(64),
  authorityDigest: '3'.repeat(64),
  artifactIds: ['4'.repeat(64)],
  fidelity: [
    { dimension: 'repository', state: 'MODELED', evidenceArtifactIds: ['5'.repeat(64)] },
    { dimension: 'dependencies', state: 'MODELED', evidenceArtifactIds: ['6'.repeat(64)] },
    { dimension: 'database', state: 'PARTIAL', evidenceArtifactIds: [], limitation: 'No production data is mirrored.' }
  ],
  createdAt: '2026-10-07T00:00:00.000Z'
});

const adapter: TwinExecutionAdapter = {
  name: 'test.isolated',
  async execute(_manifest, alternative) {
    return {
      exitCode: 0,
      observedEffectDigest: alternative.predictedEffectDigest,
      evidenceArtifactIds: ['7'.repeat(64)],
      verifiedPostconditions: alternative.id === 'safe' ? 5 : 3,
      riskScore: alternative.id === 'safe' ? 0.1 : 0.2,
      durationMs: 100,
      hostMutation: false,
      isolation: { workspaceDisposable: true, hostWrites: false, networkMode: 'none' }
    };
  }
};

test('counterfactual executor refuses to treat partial fidelity as safety coverage', async () => {
  const receipts = await executeCounterfactualTwinAlternatives({
    manifest,
    adapter,
    clock: () => new Date('2026-10-07T00:10:00.000Z'),
    alternatives: [{
      id: 'db-change',
      planDigest: '8'.repeat(64),
      predictedEffectDigest: '9'.repeat(64),
      requiredDimensions: ['repository', 'database'],
      inputArtifactIds: []
    }]
  });
  assert.equal(receipts[0]?.status, 'UNSUPPORTED');
  assert.match(receipts[0]?.reason ?? '', /database/);
});

test('counterfactual executor selects the strongest verified isolated alternative', async () => {
  const receipts = await executeCounterfactualTwinAlternatives({
    manifest,
    adapter,
    clock: () => new Date('2026-10-07T00:10:00.000Z'),
    alternatives: [
      { id: 'safe', planDigest: 'a'.repeat(64), predictedEffectDigest: 'b'.repeat(64), requiredDimensions: ['repository','dependencies'], inputArtifactIds: [] },
      { id: 'other', planDigest: 'c'.repeat(64), predictedEffectDigest: 'd'.repeat(64), requiredDimensions: ['repository'], inputArtifactIds: [] }
    ]
  });
  assert.deepEqual(receipts.map((r) => r.status), ['PASSED','PASSED']);
  const selected = selectCounterfactualAlternative(receipts);
  assert.equal(selected.selectedAlternativeId, 'safe');
});

test('counterfactual executor fails closed on reported host mutation', async () => {
  const bad: TwinExecutionAdapter = {
    name: 'bad.adapter',
    async execute() {
      return {
        exitCode: 0,
        observedEffectDigest: 'e'.repeat(64),
        evidenceArtifactIds: [],
        verifiedPostconditions: 1,
        riskScore: 0,
        durationMs: 1,
        hostMutation: true,
        isolation: { workspaceDisposable: true, hostWrites: false, networkMode: 'none' }
      };
    }
  };
  await assert.rejects(() => executeCounterfactualTwinAlternatives({
    manifest,
    adapter: bad,
    alternatives: [{ id: 'x', planDigest: 'f'.repeat(64), predictedEffectDigest: 'e'.repeat(64), requiredDimensions: ['repository'], inputArtifactIds: [] }]
  }), /host mutation/);
});
