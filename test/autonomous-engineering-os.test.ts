import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autonomousLearningDecision,
  evaluateAutonomousEngineeringOs
} from '../src/core/autonomous-engineering-os.ts';

const authority = {
  schemaVersion: 1 as const,
  principalId: 'agent:builder',
  leaseId: '1'.repeat(64),
  delegationId: 'delegation:1',
  purpose: 'Implement and verify objective',
  authorityDigest: '2'.repeat(64),
  approverPrincipalIds: ['human:a', 'human:b'],
  expiresAt: '2026-10-08T00:00:00.000Z',
  emergencyEpoch: 1
};

const twinReceipt = {
  schemaVersion: 1 as const,
  id: '3'.repeat(64),
  twinId: '4'.repeat(64),
  alternativeId: 'alt:safe',
  adapter: 'isolated',
  status: 'PASSED' as const,
  planDigest: '5'.repeat(64),
  predictedEffectDigest: '6'.repeat(64),
  observedEffectDigest: '6'.repeat(64),
  evidenceArtifactIds: ['7'.repeat(64)],
  verifiedPostconditions: 4,
  riskScore: 0.1,
  durationMs: 100,
  executedAt: '2026-10-07T00:00:00.000Z'
};

test('R10 blocks completion when proof, distributed authority or certification is missing', () => {
  const record = evaluateAutonomousEngineeringOs({
    objectiveId: 'objective:1',
    goalDigest: '8'.repeat(64),
    constraintsDigest: '9'.repeat(64),
    workspaceGraphId: 'a'.repeat(64),
    planDigest: '5'.repeat(64),
    authority,
    twinSelection: { selectedAlternativeId: 'alt:safe', receiptId: twinReceipt.id, reason: 'verified' },
    twinReceipts: [twinReceipt],
    requireDistributedFence: true,
    requireHumanReview: true,
    createdAt: '2026-10-07T01:00:00.000Z'
  });
  assert.equal(record.status, 'BLOCKED');
  assert.ok(record.reasons.includes('DISTRIBUTED_FENCE_MISSING'));
  assert.ok(record.reasons.includes('MACHINE_PROOF_NOT_VALID'));
  assert.ok(record.reasons.includes('OBJECTIVE_NOT_CERTIFIED'));
  assert.equal(record.learningEligible, false);
});

test('R10 certifies only when authority, twin, fence, proof, evidence and human review converge', () => {
  const record = evaluateAutonomousEngineeringOs({
    objectiveId: 'objective:1',
    goalDigest: '8'.repeat(64),
    constraintsDigest: '9'.repeat(64),
    workspaceGraphId: 'a'.repeat(64),
    planDigest: '5'.repeat(64),
    authority,
    twinSelection: { selectedAlternativeId: 'alt:safe', receiptId: twinReceipt.id, reason: 'verified' },
    twinReceipts: [twinReceipt],
    distributedFence: {
      schemaVersion: 1,
      id: 'b'.repeat(64),
      objectiveId: 'objective:1',
      workUnitId: 'work:1',
      role: 'VERIFY',
      placementKey: 'c'.repeat(64),
      reservationId: 'reservation:1',
      deviceId: 'device:1',
      sessionId: 'session:1',
      authorityDigest: authority.authorityDigest,
      generation: 1,
      acquiredAt: '2026-10-07T00:00:00.000Z',
      heartbeatAt: '2026-10-07T00:30:00.000Z',
      expiresAt: '2026-10-07T02:00:00.000Z',
      state: 'ACTIVE'
    },
    proofVerification: {
      status: 'VALID',
      bundleId: 'd'.repeat(64),
      reasons: [],
      requiredClaimsSatisfied: true,
      signatureVerified: true
    },
    objectiveCertification: {
      schemaVersion: 1,
      sessionId: 'session:objective',
      status: 'CERTIFIED',
      reasons: [],
      evidencePackId: 'e'.repeat(64)
    },
    humanReview: {
      principalId: 'human:reviewer',
      approved: true,
      reviewedAt: '2026-10-07T01:00:00.000Z'
    },
    createdAt: '2026-10-07T01:01:00.000Z'
  });
  assert.equal(record.status, 'CERTIFIED');
  assert.equal(record.learningEligible, true);
  assert.deepEqual(autonomousLearningDecision(record), { allowed: true, reason: 'CERTIFIED_RECEIPT' });

  const tampered = structuredClone(record);
  tampered.learningEligible = false;
  assert.throws(() => autonomousLearningDecision(tampered), /id does not match/);
});
