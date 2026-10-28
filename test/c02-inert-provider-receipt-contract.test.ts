import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProviderResultContract, assertProviderReconciliationContract
} from '../src/core/provider-result-contract.ts';

const action = { capability: 'file.read' };
const provider = 'filesystem';
const validEvidence = () => ({
  kind: 'independent_observation', status: 'pass', message: 'Observed source state',
  timestamp: '2026-10-28T00:00:00.000Z'
});
const validResult = () => ({
  ok: true, capability: action.capability, provider, durationMs: 1,
  evidence: [validEvidence()]
});
function denyResult(result: unknown): void {
  assert.throws(
    () => assertProviderResultContract(result, action, provider),
    (error: any) => error?.code === 'PROVIDER_RESULT_CONTRACT_INVALID' &&
      error?.details?.sideEffectState === 'uncertain'
  );
}
function denyReconciliation(result: unknown): void {
  assert.throws(
    () => assertProviderReconciliationContract(result, action, provider),
    (error: any) => error?.code === 'PROVIDER_RECONCILIATION_CONTRACT_INVALID' &&
      error?.details?.sideEffectState === 'uncertain'
  );
}

test('C02 provider receipts accept exact inert evidence and independent completed reconciliation', () => {
  const result = validResult();
  assert.equal(assertProviderResultContract(result, action, provider), result);
  const reconciliation = {
    status: 'completed', evidence: [validEvidence()], result
  };
  assert.equal(assertProviderReconciliationContract(reconciliation, action, provider), reconciliation);
  assert.equal(assertProviderReconciliationContract({
    status: 'uncertain', evidence: []
  }, action, provider).status, 'uncertain');
});

test('C02 sparse evidence cannot silently verify a successful action or reconciliation', () => {
  for (const evidence of [Array(1), [,validEvidence()], [validEvidence(),,]]) {
    denyResult({ ...validResult(), evidence });
    denyReconciliation({ status: 'uncertain', evidence });
    denyReconciliation({ status: 'completed', evidence, result: validResult() });
  }
});

test('C02 provider and reconciliation receipt getters never run during validation', () => {
  let invocations = 0;
  const getter = (object: Record<string, unknown>, key: string, data: unknown) => {
    Object.defineProperty(object, key, {
      enumerable: true, get() { invocations++; return data; }
    });
    return object;
  };
  const returned = validResult();
  denyResult(getter({ ...returned }, 'ok', true));
  denyResult(getter({ ...returned }, 'evidence', [validEvidence()]));
  denyResult({ ...returned, evidence: [getter(validEvidence(), 'status', 'pass')] });
  denyResult({ ...returned, evidence: [getter(validEvidence(), 'timestamp', '2026-10-28T00:00:00.000Z')] });
  const accessorEvidence: unknown[] = [];
  Object.defineProperty(accessorEvidence, '0', {
    enumerable: true, get() { invocations++; return validEvidence(); }
  });
  accessorEvidence.length = 1;
  denyResult({ ...returned, evidence: accessorEvidence });
  denyReconciliation(getter({
    status: 'completed', evidence: [validEvidence()], result: returned
  }, 'result', returned));
  denyReconciliation(getter({
    status: 'uncertain', evidence: [validEvidence()]
  }, 'status', 'uncertain'));
  assert.equal(invocations, 0, 'no provider-controlled property getter should run');
});

test('C02 result contract rejects prototype-backed evidence and executable extra properties', () => {
  const inherited = Object.create({ status: 'pass' });
  Object.assign(inherited, {
    kind: 'independent_observation', message: 'Claimed proof', timestamp: '2026-10-28T00:00:00.000Z'
  });
  denyResult({ ...validResult(), evidence: [inherited] });
  const date = new Date();
  denyResult(Object.assign(date, validResult()));
  const extra = { ...validResult() };
  Object.defineProperty(extra, 'secret', { enumerable: true, get() { throw Error('must not run'); } });
  denyResult(extra);
  const malformedError = {
    ...validResult(), ok: false,
    error: { code: 'INCOMPLETE', message: 'Indeterminate', retryable: false }
  };
  Object.defineProperty(malformedError.error, 'sideEffectState', {
    enumerable: true, get() { throw Error('must not run'); }
  });
  denyResult(malformedError);
  denyReconciliation({ status: 'completed', evidence: [validEvidence()], result: { ...validResult(), provider: 'unrelated' } });
  denyReconciliation({ status: 'uncertain', evidence: [validEvidence()], result: validResult() });
});
