import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdaptivePlanningControl,
  assertPromotionEligible,
  type AdaptivePlanningPromotionEvidence
} from '../src/core/adaptive-planning-control.ts';

const D = 'a'.repeat(64);
const R = 'b'.repeat(64);

function evidence(overrides: Partial<AdaptivePlanningPromotionEvidence> = {}): AdaptivePlanningPromotionEvidence {
  return {
    representativeShadowDecisions: 10_000,
    representativeTaskCount: 1_000,
    benchmarkExcluded: true,
    verifiedOutcomeDelta: 0.05,
    falseCompletionDelta: -0.01,
    repeatedFailureDelta: -0.02,
    recoverySuccessDelta: 0.03,
    authorityExpansionCount: 0,
    unsafeReplayCount: 0,
    statisticallyDefensible: true,
    deterministicRestartVerified: true,
    rollbackSnapshotDigest: D,
    verificationReceiptDigests: [R],
    evaluatedAt: '2026-10-06T00:00:00.000Z',
    evaluationLineageDigest: D,
    candidateManifestDigest: R,
    baselineManifestDigest: D,
    criteriaDigest: R,
    ...overrides
  };
}

test('R2 shadow and advisory modes cannot become execution authority', () => {
  const control = new AdaptivePlanningControl();
  assert.equal(control.assessInfluence('REPLAN').effect, 'SHADOW_ONLY');
  control.promote('ADVISORY', evidence({ representativeShadowDecisions: 500, representativeTaskCount: 100, verifiedOutcomeDelta: 0 }));
  const advisory = control.assessInfluence('REPLAN');
  assert.equal(advisory.effect, 'ADVISORY_ONLY');
  assert.equal(advisory.grantsAuthority, false);
  assert.equal(advisory.runtimeVetoRequired, true);
});

test('R2 reversible canary requires low-risk rollback and exact authority/resource binding', () => {
  const control = new AdaptivePlanningControl();
  control.promote('ADVISORY', evidence({ representativeShadowDecisions: 500, representativeTaskCount: 100, verifiedOutcomeDelta: 0 }));
  control.promote('REVERSIBLE_CANARY', evidence({ representativeShadowDecisions: 2_500, representativeTaskCount: 250 }));

  const incomplete = control.assessInfluence('REPLAN', {
    proposalDigest: D,
    risk: 'write',
    reversible: true,
    independentVerificationRequired: true,
    explicitUserOrPolicyAuthority: false
  });
  assert.equal(incomplete.effect, 'CONTROL_BLOCKED');

  const allowed = control.assessInfluence('REPLAN', {
    proposalDigest: D,
    risk: 'write',
    reversible: true,
    checkpointDigest: R,
    rollbackDigest: D,
    authorityDigest: R,
    resourceRevision: 'resource:4',
    fenceToken: 'fence:9',
    independentVerificationRequired: true,
    explicitUserOrPolicyAuthority: false
  });
  assert.equal(allowed.effect, 'CONTROL_ALLOWED');
  assert.equal(allowed.grantsAuthority, false);
});

test('R2 GENERAL promotion enforces the 10,000 non-benchmark decision gate and zero authority/replay violations', () => {
  assert.throws(() => assertPromotionEligible('GENERAL', evidence({ representativeShadowDecisions: 9_999 })), /representative shadow decisions/);
  assert.throws(() => assertPromotionEligible('GENERAL', evidence({ benchmarkExcluded: false })), /Benchmark-contaminated/);
  assert.throws(() => assertPromotionEligible('GENERAL', evidence({ authorityExpansionCount: 1 })), /zero authority expansion/);
  assert.throws(() => assertPromotionEligible('GENERAL', evidence({ unsafeReplayCount: 1 })), /zero unsafe replay/);
  assert.doesNotThrow(() => assertPromotionEligible('GENERAL', evidence()));
});

test('R2 general control still requires fresh explicit authority for high-risk or irreversible proposals', () => {
  const control = new AdaptivePlanningControl();
  control.promote('ADVISORY', evidence({ representativeShadowDecisions: 500, representativeTaskCount: 100, verifiedOutcomeDelta: 0 }));
  control.promote('REVERSIBLE_CANARY', evidence({ representativeShadowDecisions: 2_500, representativeTaskCount: 250 }));
  control.promote('GENERAL', evidence());

  const base = {
    proposalDigest: D,
    risk: 'system' as const,
    reversible: false,
    authorityDigest: R,
    resourceRevision: 'resource:5',
    fenceToken: 'fence:10',
    independentVerificationRequired: true,
    explicitUserOrPolicyAuthority: false
  };
  assert.equal(control.assessInfluence('REPAIR', base).effect, 'CONTROL_BLOCKED');
  const allowed = control.assessInfluence('REPAIR', {
    ...base,
    explicitUserOrPolicyAuthority: true,
    freshAuthorityReceiptDigest: D
  });
  assert.equal(allowed.effect, 'CONTROL_ALLOWED');
  assert.equal(allowed.runtimeVetoRequired, true);
});

test('R2 control state restart is deterministic and rollback is immediate', () => {
  const control = new AdaptivePlanningControl();
  control.promote('ADVISORY', evidence({ representativeShadowDecisions: 500, representativeTaskCount: 100, verifiedOutcomeDelta: 0 }), '2026-10-06T00:01:00.000Z');
  const digest = control.stateDigest();
  const restored = AdaptivePlanningControl.fromState(control.state());
  assert.equal(restored.stateDigest(), digest);
  restored.rollback('SHADOW', D, '2026-10-06T00:02:00.000Z');
  assert.equal(restored.state().mode, 'SHADOW');
  assert.equal(restored.assessInfluence('REPLAN').effect, 'SHADOW_ONLY');
});
