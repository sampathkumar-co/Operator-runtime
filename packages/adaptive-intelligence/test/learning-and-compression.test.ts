import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CalibrationTracker,
  LearningFirewall,
  compressTrajectory,
  validateSkillDraft
} from '../src/index.ts';
import type {
  BeliefResolution,
  FailureAttribution,
  GoalDescriptor,
  SkillDraft,
  TrajectoryStep
} from '../src/index.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const T0 = '2026-10-05T00:00:00.000Z';

function evidence(digest = A) { return { digest, source: 'test', observedAt: T0 }; }

function skill(overrides: Partial<SkillDraft> = {}): SkillDraft {
  return {
    id: 'dynamic-hierarchy-navigation',
    objectiveKind: 'navigate-hierarchy',
    title: 'Navigate dynamically revealed hierarchy',
    scopeClass: 'authorized-ui-scene',
    assumptions: ['semantic observation is available'],
    steps: [{
      actionFamily: 'hierarchy-discovery',
      capability: 'ui.observe',
      preconditions: ['parent visible'],
      expectedEffects: ['descendants.discovered'],
      verificationFacts: ['descendants.actionable'],
      recoveryFamilies: ['reobserve', 'reground']
    }],
    verificationDigests: [A],
    sourceRunIds: ['synthetic-run-1'],
    ...overrides
  };
}

test('verified generic skill is promotable only in NORMAL mode', () => {
  const firewall = new LearningFirewall();
  const frozen = firewall.evaluate({
    skill: skill(),
    mode: 'EVALUATION_FROZEN',
    policyVersion: 'p1',
    independentlyVerified: true
  });
  assert.equal(frozen.promoted, false);

  const normal = firewall.evaluate({
    skill: skill(),
    mode: 'NORMAL',
    policyVersion: 'p1',
    independentlyVerified: true
  });
  assert.equal(normal.promoted, true);
});

test('benchmark identifier contamination blocks learning promotion', () => {
  const firewall = new LearningFirewall();
  const result = firewall.evaluate({
    skill: skill({ title: 'Solve click-menu through dynamic hierarchy' }),
    mode: 'NORMAL',
    policyVersion: 'p1',
    independentlyVerified: true,
    blockedIdentifiers: ['click-menu']
  });
  assert.equal(result.promoted, false);
  assert.match(result.reason, /contamination/i);
});

test('skill fingerprint is semantic and independent of verification receipt ordering', () => {
  const one = validateSkillDraft(skill({ verificationDigests: [A, B] }));
  const two = validateSkillDraft(skill({ verificationDigests: [B, A] }));
  assert.equal(one.fingerprint, two.fingerprint);
});

test('calibration tracker reports Brier score and ECE instead of trusting confidence blindly', () => {
  const tracker = new CalibrationTracker();
  tracker.record({ prediction: 0.9, outcome: 1 });
  tracker.record({ prediction: 0.1, outcome: 0 });
  const report = tracker.report(10);
  assert.equal(report.samples, 2);
  assert.ok(Math.abs(report.brierScore - 0.01) < 1e-9);
  assert.ok(Math.abs(report.expectedCalibrationError - 0.1) < 1e-9);
});

test('trajectory compression retains unresolved hypotheses and repeated failure families while dropping raw history', () => {
  const failure: FailureAttribution = {
    primary: {
      class: 'TARGET_STALE',
      probability: 0.8,
      reasons: ['target identity changed'],
      evidence: [evidence()]
    },
    alternatives: [{
      class: 'PERCEPTION_INCOMPLETE',
      probability: 0.2,
      reasons: ['observation incomplete'],
      evidence: []
    }],
    entropy: 0.5,
    evidenceCoverage: 0.5
  };
  const baseStep = (index: number): TrajectoryStep => ({
    index,
    action: {
      id: 'a' + index,
      family: 'pointer-click',
      capability: 'ui.interact',
      risk: 'write',
      strategyId: 'click-strategy',
      expectedEffects: ['menu.open']
    },
    outcome: {
      ok: false,
      errorCode: 'STALE_TARGET',
      sideEffectState: 'none',
      executionPhase: 'pre_dispatch',
      evidence: [evidence()]
    },
    delta: {
      changedFactKeys: [],
      addedFactKeys: [],
      removedFactKeys: [],
      expectedEffectsSatisfied: [],
      expectedEffectsMissing: ['menu.open'],
      unrelatedEffects: [],
      progressSignals: []
    },
    progress: {
      level: 'NONE',
      confidence: 0,
      creditedSignals: [],
      rejectedSignals: ['provider-action-failed'],
      goalFactsSatisfied: [],
      goalFactsMissing: ['menu.open'],
      forbiddenFactsObserved: [],
      verificationRequired: true
    },
    failure
  });

  const beliefs: BeliefResolution[] = [{
    factKey: 'menu.open',
    status: 'STALE',
    confidence: 0,
    supportingEvidence: [],
    contradictingEvidence: [],
    staleEvidence: [evidence()],
    alternatives: [],
    updatedAt: T0
  }];
  const goal: GoalDescriptor = { id: 'g', kind: 'hierarchy', objective: 'open menu', successFactKeys: ['menu.open'] };
  const compressed = compressTrajectory({ goal, steps: [baseStep(0), baseStep(1), baseStep(2)], beliefs, maxRecentStrategies: 2 });
  assert.deepEqual(compressed.repeatedFailureFamilies, ['pointer-click']);
  assert.equal(compressed.activeHypotheses[0]?.class, 'TARGET_STALE');
  assert.ok(compressed.unresolvedFacts.includes('menu.open'));
  assert.equal(compressed.recentStrategies.length, 2);
  assert.equal(compressed.omittedSteps, 1);
});
