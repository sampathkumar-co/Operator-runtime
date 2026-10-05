import assert from 'node:assert/strict';
import test from 'node:test';
import { CausalGraph, EpistemicStateEngine, assessProgress } from '../src/index.ts';
import type { BeliefResolution, GoalDescriptor } from '../src/index.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const T0 = '2026-10-05T00:00:00.000Z';

function evidence(digest = A) { return { digest, source: 'test', observedAt: T0 }; }
function fact(key: string, valueDigest: string) { return { key, valueDigest, confidence: 1, evidence: [evidence(valueDigest)] }; }

test('one fresh high-confidence observation can be KNOWN without synthetic multi-source inflation', () => {
  const engine = new EpistemicStateEngine({ clock: () => new Date(T0) });
  const result = engine.observe({
    factKey: 'target.visible',
    valueDigest: A,
    polarity: 'supports',
    confidence: 0.95,
    evidence: evidence(A)
  });
  assert.equal(result.status, 'KNOWN');
  assert.ok(result.confidence >= 0.94);
});

test('pre-existing satisfied fact is not miscredited as new subgoal progress', () => {
  const graph = new CausalGraph({ clock: () => new Date(T0) });
  const transition = graph.record({
    before: {
      id: 'before',
      observedAt: T0,
      scopeKey: 'scene',
      facts: [fact('goal.saved', A), fact('irrelevant', A)]
    },
    action: {
      id: 'read-1',
      family: 'read-status',
      capability: 'ui.observe',
      risk: 'read'
    },
    outcome: {
      ok: true,
      sideEffectState: 'none',
      executionPhase: 'effect_observed',
      evidence: [evidence()]
    },
    after: {
      id: 'after',
      observedAt: T0,
      scopeKey: 'scene',
      facts: [fact('goal.saved', A), fact('irrelevant', B)]
    }
  });
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
  const goal: GoalDescriptor = { id: 'g', kind: 'save', objective: 'save', successFactKeys: ['goal.saved'] };
  const result = assessProgress({ goal, transition, beliefs, independentVerification: false });
  assert.equal(result.level, 'STATE_CHANGED');
  assert.ok(!result.creditedSignals.some((item) => item.startsWith('goal-fact-transition:')));
});
