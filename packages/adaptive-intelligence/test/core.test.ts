import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdaptiveIntelligenceKernel,
  CausalGraph,
  EpistemicStateEngine,
  assessProgress,
  attributeFailure,
  deriveDelta,
  selectRecovery,
  selectStrategy
} from '../src/index.ts';
import type {
  ActionDescriptor,
  ActionOutcome,
  BeliefResolution,
  GoalDescriptor,
  RecoveryOption,
  StateSnapshot,
  StrategyCandidate
} from '../src/index.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const E = 'e'.repeat(64);
const T0 = '2026-10-05T00:00:00.000Z';

function evidence(digest = A, observedAt = T0) {
  return { digest, source: 'synthetic-test', observedAt };
}

function fact(key: string, valueDigest: string, confidence = 1) {
  return { key, valueDigest, confidence, evidence: [evidence(valueDigest)] };
}

function snapshot(id: string, facts: ReturnType<typeof fact>[], version?: string): StateSnapshot {
  return { id, observedAt: T0, scopeKey: 'synthetic:scene', ...(version ? { stateVersion: version } : {}), facts };
}

function action(overrides: Partial<ActionDescriptor> = {}): ActionDescriptor {
  return {
    id: 'action-1',
    family: 'semantic-invoke',
    capability: 'ui.interact',
    risk: 'write',
    expectedEffects: ['dialog.open'],
    ...overrides
  };
}

function outcome(overrides: Partial<ActionOutcome> = {}): ActionOutcome {
  return {
    ok: true,
    sideEffectState: 'known',
    executionPhase: 'effect_observed',
    evidence: [evidence()],
    ...overrides
  };
}

test('epistemic engine preserves conflicting claims instead of averaging them into fake certainty', () => {
  const engine = new EpistemicStateEngine({ clock: () => new Date(T0) });
  engine.observe({ factKey: 'target.identity', valueDigest: A, polarity: 'supports', confidence: 0.9, evidence: evidence(A) });
  const resolved = engine.observe({ factKey: 'target.identity', valueDigest: B, polarity: 'supports', confidence: 0.9, evidence: evidence(B) });
  assert.equal(resolved.status, 'CONFLICTED');
  assert.equal(resolved.alternatives.length, 2);
  assert.notEqual(resolved.alternatives[0]?.valueDigest, resolved.alternatives[1]?.valueDigest);
});

test('epistemic engine exposes stale and unobservable as different states', () => {
  let now = new Date(T0);
  const engine = new EpistemicStateEngine({ clock: () => now });
  engine.observe({
    factKey: 'target.present',
    valueDigest: A,
    polarity: 'supports',
    confidence: 0.9,
    evidence: evidence(A),
    expiresAt: '2026-10-05T00:00:01.000Z'
  });
  now = new Date('2026-10-05T00:00:02.000Z');
  assert.equal(engine.resolve('target.present').status, 'STALE');
  assert.equal(engine.markUnobservable('screen.hidden-region').status, 'UNOBSERVABLE');
});

test('epistemic engine rejects secret-bearing fact keys', () => {
  const engine = new EpistemicStateEngine({ clock: () => new Date(T0) });
  assert.throws(() => engine.observe({
    factKey: 'api_token',
    valueDigest: A,
    polarity: 'supports',
    confidence: 1,
    evidence: evidence(A)
  }), /Secret-bearing/);
});

test('causal delta credits expected effects but keeps unrelated changes separate', () => {
  const before = snapshot('before', [fact('dialog.open', A), fact('noise', A)]);
  const after = snapshot('after', [fact('dialog.open', B), fact('noise', C), fact('irrelevant', D)]);
  const delta = deriveDelta(before, after, ['dialog.open'], ['subgoal-visible']);
  assert.deepEqual(delta.expectedEffectsSatisfied, ['dialog.open']);
  assert.deepEqual(delta.expectedEffectsMissing, []);
  assert.deepEqual(delta.unrelatedEffects, ['irrelevant', 'noise']);
  assert.deepEqual(delta.progressSignals, ['subgoal-visible']);
});

test('metamorphic irrelevant state insertion cannot manufacture expected-effect success', () => {
  const before = snapshot('before', [fact('goal.saved', A)]);
  const after1 = snapshot('after-1', [fact('goal.saved', A), fact('random.banner', B)]);
  const after2 = snapshot('after-2', [fact('goal.saved', A), fact('random.banner', C), fact('random.clock', D)]);
  assert.deepEqual(deriveDelta(before, after1, ['goal.saved'], []).expectedEffectsSatisfied, []);
  assert.deepEqual(deriveDelta(before, after2, ['goal.saved'], []).expectedEffectsSatisfied, []);
});

test('uncertain mutation is attributed to uncertainty and recovery forces reconciliation', () => {
  const graph = new CausalGraph({ clock: () => new Date(T0) });
  const transition = graph.record({
    before: snapshot('before', [fact('record.value', A)], 'v1'),
    action: action({ expectedEffects: ['record.value'] }),
    outcome: outcome({
      ok: false,
      errorCode: 'PROVIDER_CONNECTION_LOST',
      sideEffectState: 'uncertain',
      executionPhase: 'dispatching'
    }),
    after: snapshot('after', [fact('record.value', A)], 'v1')
  });
  const attribution = attributeFailure({ transition });
  assert.equal(attribution.primary.class, 'SIDE_EFFECT_UNCERTAIN');

  const options: RecoveryOption[] = [
    {
      id: 'retry',
      kind: 'REPAIR',
      description: 'blind retry',
      expectedInformationGain: 0,
      expectedSuccess: 0.9,
      expectedCost: 1,
      risk: 0.8,
      resolvesHypotheses: ['PROVIDER_TRANSIENT']
    },
    {
      id: 'reconcile',
      kind: 'RECONCILE',
      description: 'read provider post-state',
      expectedInformationGain: 0.9,
      expectedSuccess: 0.8,
      expectedCost: 2,
      risk: 0.05,
      resolvesHypotheses: ['SIDE_EFFECT_UNCERTAIN']
    }
  ];
  assert.equal(selectRecovery({ attribution, options }).selected.kind, 'RECONCILE');
});

test('goal facts do not become GOAL_ACHIEVED without independent verification', () => {
  const beliefs: BeliefResolution[] = [{
    factKey: 'goal.saved',
    status: 'KNOWN',
    confidence: 0.95,
    selectedValueDigest: A,
    supportingEvidence: [evidence(A)],
    contradictingEvidence: [],
    staleEvidence: [],
    alternatives: [{ valueDigest: A, confidence: 0.95 }],
    updatedAt: T0
  }];
  const graph = new CausalGraph({ clock: () => new Date(T0) });
  const transition = graph.record({
    before: snapshot('before', [fact('goal.saved', B)]),
    action: action({ expectedEffects: ['goal.saved'] }),
    outcome: outcome(),
    after: snapshot('after', [fact('goal.saved', A)]),
    progressSignals: ['saved']
  });
  const goal: GoalDescriptor = { id: 'g1', kind: 'synthetic', objective: 'save', successFactKeys: ['goal.saved'] };
  const unverified = assessProgress({ goal, transition, beliefs, independentVerification: false });
  assert.equal(unverified.level, 'SUBGOAL_PROGRESS');
  assert.equal(unverified.verificationRequired, true);
  const verified = assessProgress({ goal, transition, beliefs, independentVerification: true });
  assert.equal(verified.level, 'GOAL_ACHIEVED');
});

test('strategy engine penalizes repeated equivalent failure and selects a materially different family', () => {
  const graph = new CausalGraph({ clock: () => new Date(T0) });
  for (let index = 0; index < 2; index += 1) {
    graph.record({
      before: snapshot('b' + index, [fact('menu.open', A)]),
      action: action({ id: 'a' + index, family: 'pointer-click', expectedEffects: ['menu.open'] }),
      outcome: outcome({ ok: false, errorCode: 'NO_PROGRESS', sideEffectState: 'none', executionPhase: 'effect_observed' }),
      after: snapshot('c' + index, [fact('menu.open', A)])
    });
  }
  const candidates: StrategyCandidate[] = [
    {
      id: 'click-again',
      family: 'pointer-click',
      description: 'repeat pointer strategy',
      expectedSuccess: 0.82,
      expectedCost: 1,
      uncertainty: 0.15,
      verificationStrength: 0.8,
      expectedEffects: ['menu.open']
    },
    {
      id: 'keyboard-nav',
      family: 'keyboard-navigation',
      description: 'use semantic keyboard navigation',
      expectedSuccess: 0.72,
      expectedCost: 1,
      uncertainty: 0.15,
      verificationStrength: 0.8,
      expectedEffects: ['menu.open']
    }
  ];
  const selected = selectStrategy({ candidates, recentTransitions: graph.recent(10).reverse() });
  assert.equal(selected.selected.id, 'keyboard-nav');
  assert.ok(selected.ranked.find((item) => item.id === 'click-again')?.penalties.includes('repeated-equivalent-failure'));
});

test('adaptive kernel composes causal truth, failure reasoning and verified progress without gaining authority', () => {
  const kernel = new AdaptiveIntelligenceKernel({ clock: () => new Date(T0) });
  kernel.observeBelief({
    factKey: 'goal.saved',
    valueDigest: A,
    polarity: 'supports',
    confidence: 0.99,
    evidence: evidence(A)
  });
  const result = kernel.analyzeOutcome({
    goal: { id: 'goal-1', kind: 'synthetic-save', objective: 'save document', successFactKeys: ['goal.saved'] },
    before: snapshot('before', [fact('goal.saved', B)], 'v1'),
    action: action({ expectedEffects: ['goal.saved'] }),
    outcome: outcome(),
    after: snapshot('after', [fact('goal.saved', A)], 'v2'),
    relevantFactKeys: ['goal.saved'],
    progressSignals: ['saved'],
    independentVerification: true
  });
  assert.equal(result.progress.level, 'GOAL_ACHIEVED');
  assert.equal(result.failure, undefined);
  assert.equal(kernel.trajectory().length, 1);
});
