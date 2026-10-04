import assert from 'node:assert/strict';
import test from 'node:test';
import { conservativeExecutionPhase, conservativeSideEffectState, requiresReconciliation, retrySafeWithoutReconciliation } from '../src/core/side-effect.ts';
import type { ActionResult } from '../src/core/types.ts';

function result(input: Partial<ActionResult>): ActionResult {
  return {
    ok: false,
    capability: 'file.create',
    provider: 'probe',
    evidence: [],
    durationMs: 0,
    ...input
  };
}

test('failed mutations default to uncertain and require reconciliation', () => {
  const state = conservativeSideEffectState('write', result({
    error: { code: 'NETWORK_LOST', message: 'response was lost', retryable: true }
  }));
  assert.equal(state, 'uncertain');
  assert.equal(requiresReconciliation('write', state), true);
  assert.equal(retrySafeWithoutReconciliation('write', state), false);
});

test('pre-dispatch execution truth proves mutation side effects are absent', () => {
  const actionResult = result({
    error: { code: 'STALE', message: 'rejected before native dispatch', retryable: true, executionPhase: 'pre_dispatch' }
  });
  assert.equal(conservativeExecutionPhase(actionResult), 'pre_dispatch');
  assert.equal(conservativeSideEffectState('write', actionResult), 'none');
});

test('trusted explicit no-side-effect failures may be retried without reconciliation', () => {
  const state = conservativeSideEffectState('write', result({
    error: { code: 'PRECONDITION_FAILED', message: 'nothing executed', retryable: true, sideEffectState: 'none' }
  }));
  assert.equal(state, 'none');
  assert.equal(retrySafeWithoutReconciliation('write', state), true);
});

test('policy and router denials are classified as no-side-effect', () => {
  assert.equal(conservativeSideEffectState('destructive', result({ provider: 'policy' })), 'none');
  assert.equal(conservativeSideEffectState('system', result({ provider: 'router' })), 'none');
});

test('successful mutation is known and reads are always non-mutating', () => {
  assert.equal(conservativeSideEffectState('write', result({ ok: true })), 'known');
  assert.equal(conservativeSideEffectState('read', result({
    error: { code: 'BROKEN_READ', message: 'read failed', sideEffectState: 'uncertain' }
  })), 'none');
});
