import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPerceptionConflicts, selectObservation } from '../src/index.ts';
import type { BeliefResolution } from '../src/index.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const T0 = '2026-10-05T00:00:00.000Z';

function evidence(digest: string) {
  return { digest, source: 'synthetic', observedAt: T0 };
}

test('independent high-confidence semantic channels expose disagreement instead of averaging it away', () => {
  const conflicts = detectPerceptionConflicts([
    {
      factKey: 'target.enabled',
      valueDigest: A,
      channel: 'dom',
      confidence: 0.95,
      evidence: evidence(A),
      correlationKey: 'dom-1'
    },
    {
      factKey: 'target.enabled',
      valueDigest: B,
      channel: 'uia',
      confidence: 0.92,
      evidence: evidence(B),
      correlationKey: 'uia-1'
    }
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.factKey, 'target.enabled');
  assert.ok((conflicts[0]?.severity ?? 0) > 0.5);
  assert.deepEqual(conflicts[0]?.independentChannels, ['dom', 'uia']);
});

test('correlated duplicate evidence cannot manufacture cross-channel confidence', () => {
  const conflicts = detectPerceptionConflicts([
    {
      factKey: 'target.enabled',
      valueDigest: A,
      channel: 'visual',
      confidence: 0.95,
      evidence: evidence(A),
      correlationKey: 'same-capture'
    },
    {
      factKey: 'target.enabled',
      valueDigest: B,
      channel: 'visual',
      confidence: 0.95,
      evidence: evidence(B),
      correlationKey: 'same-capture'
    }
  ]);
  assert.equal(conflicts.length, 0);
});

test('active observation policy prefers structured target-local evidence for relevant uncertainty', () => {
  const beliefs: BeliefResolution[] = [{
    factKey: 'target.identity',
    status: 'CONFLICTED',
    confidence: 0.5,
    selectedValueDigest: A,
    supportingEvidence: [evidence(A)],
    contradictingEvidence: [evidence(B)],
    staleEvidence: [],
    alternatives: [
      { valueDigest: A, confidence: 0.5 },
      { valueDigest: B, confidence: 0.5 }
    ],
    updatedAt: T0
  }];

  const selected = selectObservation(beliefs, [
    {
      id: 'full-screen',
      channel: 'visual',
      description: 'capture full screen',
      resolvesFacts: ['target.identity'],
      expectedInformationGain: 0.8,
      expectedCost: 4,
      targetLocal: false
    },
    {
      id: 'target-dom',
      channel: 'dom',
      description: 'inspect target-local DOM semantics',
      resolvesFacts: ['target.identity'],
      expectedInformationGain: 0.8,
      expectedCost: 1,
      targetLocal: true
    },
    {
      id: 'irrelevant',
      channel: 'dom',
      description: 'inspect unrelated status',
      resolvesFacts: ['unrelated.fact'],
      expectedInformationGain: 1,
      expectedCost: 1,
      targetLocal: true
    }
  ]);

  assert.equal(selected.selected.id, 'target-dom');
  assert.ok(selected.ranked.find((item) => item.id === 'irrelevant')?.penalties.includes('does-not-resolve-current-uncertainty'));
});

test('observation policy rejects mutating candidates', () => {
  const beliefs: BeliefResolution[] = [{
    factKey: 'target.identity',
    status: 'UNKNOWN',
    confidence: 0,
    supportingEvidence: [],
    contradictingEvidence: [],
    staleEvidence: [],
    alternatives: [],
    updatedAt: T0
  }];
  assert.throws(() => selectObservation(beliefs, [{
    id: 'mutating-probe',
    channel: 'application',
    description: 'change UI to infer state',
    resolvesFacts: ['target.identity'],
    expectedInformationGain: 1,
    expectedCost: 1,
    targetLocal: true,
    mutating: true
  }]), /read-only/);
});
