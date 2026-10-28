import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime, BUILT_IN_PROVIDER_DECLARATIONS } from '../apps/local-agent/src/runtime-factory.ts';
import {
  createBuiltInProviderConformanceCensus,
  GENERIC_PROVIDER_CONFORMANCE_CASES
} from '../src/core/capability-conformance.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityProvider } from '../src/core/types.ts';

const read: ActionRequest = { id: 'read', capability: 'git.status', risk: 'read', input: {}, provenance: { kind: 'runtime' } };
const write: ActionRequest = { id: 'write', capability: 'file.write', risk: 'write', input: {}, provenance: { kind: 'runtime' } };
const permissions = { allowedCapabilities: ['git.status', 'file.write'], allowedRoots: [], maxRisk: 'destructive' as const };
const score = { reliability: 1, latency: 0, determinism: 1, security: 1, reversibility: 1, informationQuality: 1, interactionCost: 0 };
const result = (action: ActionRequest, provider: string, error?: ActionResult['error']): ActionResult => ({
  ok: !error, capability: action.capability, provider, evidence: [], ...(error ? { error } : {}), durationMs: 0
});
function provider(name: string, execute: CapabilityProvider['execute'], supports: CapabilityProvider['supports'] = () => true): CapabilityProvider {
  return { name, supports, score: () => score, execute };
}

test('C02-09 census accounts for every built-in and labels default-off providers without physical certification', async () => {
  const runtime = createRuntime({ allowedRoots: [process.cwd()], allowedExecutables: [] });
  try {
    const census = createBuiltInProviderConformanceCensus(runtime.router, BUILT_IN_PROVIDER_DECLARATIONS);
    assert.equal(census.providers.length, BUILT_IN_PROVIDER_DECLARATIONS.length);
    assert.deepEqual(census.genericCases, [...GENERIC_PROVIDER_CONFORMANCE_CASES]);
    assert.equal(census.providers.every((item) => item.physicalOutcome === 'NOT_VERIFIED'), true);
    assert.deepEqual(census.providers.filter((item) => item.registration === 'default_off').map((item) => [item.name, item.configured]), [
      ['workspace.worktree.git', false], ['perception.graph', false]
    ]);
    assert.equal(census.providers.filter((item) => item.registration === 'always').every((item) => item.configured), true);
  } finally { await runtime.close(); }
});

test('C02-09 generic boundary covers allow/deny, cancellation, malformed result, uncertainty/no replay, missing provider and recovery', async () => {
  let calls: string[] = [];
  const runtime = new OperatorRuntime()
    .register(provider('deny', async (action) => result(action, 'deny'), () => false))
    .register(provider('allow', async (action) => { calls.push('allow'); return result(action, 'allow'); }));
  assert.equal((await runtime.execute(read, permissions)).ok, true);
  assert.deepEqual(calls, ['allow']);

  const cancelled = new AbortController(); cancelled.abort();
  calls = [];
  const cancelledResult = await runtime.execute(read, permissions, { signal: cancelled.signal });
  assert.equal(cancelledResult.error?.code, 'EXECUTION_ABORTED');
  assert.deepEqual(calls, []);

  const afterDispatch = new AbortController();
  let afterDispatchCalls = 0;
  const afterDispatchRuntime = new OperatorRuntime().register(provider('after-dispatch', async (action) => {
    afterDispatchCalls++; return result(action, 'after-dispatch');
  }));
  const afterDispatchResult = await afterDispatchRuntime.execute(write, permissions, {
    signal: afterDispatch.signal, onProviderDispatch: () => afterDispatch.abort()
  });
  assert.equal(afterDispatchResult.error?.code, 'EXECUTION_ABORTED');
  assert.equal(afterDispatchResult.error?.sideEffectState, 'uncertain');
  assert.equal(afterDispatchCalls, 0);

  const malformed = new OperatorRuntime().register(provider('malformed', async () => ({ ok: true }) as any));
  const malformedResult = await malformed.execute(write, permissions);
  assert.equal(malformedResult.error?.code, 'PROVIDER_RESULT_CONTRACT_INVALID');
  assert.equal(malformedResult.error?.sideEffectState, 'uncertain');
  assert.equal(malformedResult.error?.retryable, false);

  calls = [];
  const noReplay = new OperatorRuntime()
    .register(provider('uncertain', async (action) => { calls.push('uncertain'); return result(action, 'uncertain', { code: 'LOST', message: 'bounded', retryable: true, sideEffectState: 'uncertain' }); }))
    .register({ ...provider('fallback', async (action) => { calls.push('fallback'); return result(action, 'fallback'); }),
      score: () => ({ ...score, reliability: 0, determinism: 0, security: 0 }) });
  const uncertain = await noReplay.execute(write, permissions);
  assert.equal(uncertain.error?.sideEffectState, 'uncertain');
  assert.deepEqual(calls, ['uncertain']);

  const absent = await new OperatorRuntime().execute(read, permissions);
  assert.equal(absent.error?.code, 'CAPABILITY_UNAVAILABLE');
  await assert.rejects(new OperatorRuntime().reconcile(write, 'missing'), (error: any) => error?.code === 'PROVIDER_RECONCILIATION_UNAVAILABLE');
  await assert.rejects(new OperatorRuntime().register(provider('no-reconcile', async (action) => result(action, 'no-reconcile'))).reconcile(write, 'no-reconcile'),
    (error: any) => error?.code === 'PROVIDER_RECONCILIATION_CONTRACT_MISSING');
  const recoverable = provider('recoverable', async (action) => result(action, 'recoverable'));
  recoverable.reconcile = async ({ action }) => ({ status: 'completed', result: result(action, 'recoverable'), evidence: [] });
  assert.equal((await new OperatorRuntime().register(recoverable).reconcile(write, 'recoverable')).status, 'completed');
  recoverable.reconcile = async ({ action }) => ({ status: 'completed', result: result(action, 'other-provider'), evidence: [] });
  await assert.rejects(new OperatorRuntime().register(recoverable).reconcile(write, 'recoverable'),
    (error: any) => error?.code === 'PROVIDER_RECONCILIATION_CONTRACT_INVALID');
});

test('C02-09 untrusted thrown diagnostics are bounded by the runtime result surface', async () => {
  const secret = 'provider-secret-must-not-cross';
  const runtime = new OperatorRuntime().register(provider('thrower', async () => { throw new Error(secret); }));
  const outcome = await runtime.execute(read, permissions);
  assert.equal(outcome.error?.code, 'PROVIDER_EXCEPTION');
  assert.equal(outcome.error?.message, 'Provider execution failed.');
  assert.equal(JSON.stringify(outcome).includes(secret), false);
});

test('C02-09 census rejects undeclared, duplicate, and missing required built-ins', () => {
  const router = new OperatorRuntime().register(provider('unexpected', async (action) => result(action, 'unexpected'))).router;
  assert.throws(() => createBuiltInProviderConformanceCensus(router, []), /declaration collection/);
  assert.throws(() => createBuiltInProviderConformanceCensus(router, [{ name: 'required', registration: 'always' }]), /not registered/);
  assert.throws(() => createBuiltInProviderConformanceCensus(router, [
    { name: 'unexpected', registration: 'always' }, { name: 'unexpected', registration: 'always' }
  ]), /declaration is invalid/);
});
