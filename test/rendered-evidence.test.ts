import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderedDeltaEvidence, createRenderedEvidence, validateRenderedEvidence } from '../src/core/rendered-evidence.ts';

const first = 'a'.repeat(64);
const second = 'b'.repeat(64);

function evidence(generation = first) {
  return createRenderedEvidence({
    tier: 'target-roi',
    sceneKey: 'desktop:window:abc',
    captureId: generation === first ? 'capture-1' : 'capture-2',
    captureGeneration: generation,
    observedAt: '2026-10-04T00:00:00.000Z',
    expiresAt: '2026-10-04T00:01:00.000Z',
    region: { x: -1200, y: 100, width: 400, height: 200 },
    sourceDimensions: { width: 400, height: 200 },
    returnedDimensions: { width: 200, height: 100 },
    transform: {
      from: 'capture-image', to: 'native-screen', originX: -1200, originY: 100,
      scaleX: 2, scaleY: 2, sourceWidth: 200, sourceHeight: 100,
      targetWidth: 400, targetHeight: 200, generation,
      provenance: 'windows.uia:visual.capture'
    },
    targetAssociation: 'uia:save-button'
  });
}

test('rendered evidence binds ROI, scene, freshness, target, transform, and digest', () => {
  const rendered = evidence();
  assert.equal(rendered.version, 3);
  assert.equal(rendered.tier, 'target-roi');
  assert.equal(rendered.transform.originX, -1200);
  assert.equal(rendered.targetAssociation, 'uia:save-button');
  assert.deepEqual(validateRenderedEvidence(rendered), rendered);
});

test('rendered evidence rejects metadata tamper and stale transform generations', () => {
  const rendered = evidence();
  assert.throws(() => validateRenderedEvidence({ ...rendered, sceneKey: 'visual:screen' }), /digest does not verify/);
  assert.throws(() => createRenderedEvidence({
    ...rendered,
    transform: { ...rendered.transform, generation: second }
  }), /generation does not match/);
});

test('rendered delta reports target-local change without relying on a whole-screen digest', () => {
  const delta = createRenderedDeltaEvidence(evidence(first), evidence(second));
  assert.equal(delta.changed, true);
  assert.equal(delta.scope, 'target-local');
  assert.deepEqual(delta.region, { x: -1200, y: 100, width: 400, height: 200 });
  assert.match(delta.evidenceDigest, /^[0-9a-f]{64}$/);
});
