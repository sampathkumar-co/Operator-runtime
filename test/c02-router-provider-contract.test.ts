import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityRouter } from '../src/core/router.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';

const action: ActionRequest = {
  id: 'c02-routing-contract',
  capability: 'git.status',
  risk: 'read',
  input: {},
  provenance: { kind: 'runtime' }
};
const score: CapabilityScore = {
  reliability: 1, latency: 0, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

function provider(supports: CapabilityProvider['supports']): CapabilityProvider {
  return {
    name: 'c02-fixture',
    supports,
    score: () => score,
    execute: async (request) => ({
      ok: true, capability: request.capability, provider: 'c02-fixture', evidence: [], durationMs: 0
    })
  };
}

test('C02 routing refuses non-boolean provider support, including truthy objects and coercible values', async () => {
  for (const value of [{ supported: true }, ['true'], 'true', 1, null, undefined]) {
    let dispatches = 0;
    const router = new CapabilityRouter();
    router.register({
      ...provider(() => value as boolean),
      execute: async () => { dispatches++; throw new Error('must not dispatch'); }
    });
    await assert.rejects(router.rank(action), (error: any) =>
      error?.code === 'PROVIDER_SUPPORT_CONTRACT_INVALID');
    await assert.rejects(router.supports(action), (error: any) =>
      error?.code === 'PROVIDER_SUPPORT_CONTRACT_INVALID');
    assert.equal(dispatches, 0);
  }
});

test('C02 advertisement is never silently promoted by truthy or malformed provider declarations', async () => {
  const router = new CapabilityRouter();
  router.register({ ...provider(() => true), advertises: () => ['true'] as unknown as boolean });
  await assert.rejects(router.advertises(action), (error: any) =>
    error?.code === 'PROVIDER_ADVERTISEMENT_CONTRACT_INVALID');
});

test('C02 malformed numeric provider scoring never silently determines route selection', async () => {
  const router = new CapabilityRouter();
  router.register({
    ...provider(() => true),
    score: () => ({ ...score, reliability: '1' as unknown as number })
  });
  await assert.rejects(router.rank(action), (error: any) =>
    error?.code === 'PROVIDER_SCORE_CONTRACT_INVALID');
  const nonfinite = new CapabilityRouter();
  nonfinite.register({ ...provider(() => true), score: () => ({ ...score, security: NaN }) });
  await assert.rejects(nonfinite.rank(action), (error: any) =>
    error?.code === 'PROVIDER_SCORE_CONTRACT_INVALID');
});

test('C02 malformed dynamic risk cannot be resolved as a canonical risk', async () => {
  const router = new CapabilityRouter();
  router.register({
    ...provider(() => true),
    resolveRisk: () => ['read'] as unknown as 'read'
  });
  await assert.rejects(router.resolveRisk({ ...action, capability: 'file.manage', risk: 'write' }),
    (error: any) => error?.code === 'PROVIDER_RISK_CONTRACT_INVALID');
});

test('C02 final pre-dispatch supports recheck blocks provider that changes its support type', async () => {
  let supportCalls = 0;
  let dispatches = 0;
  const runtime = new OperatorRuntime().register({
    ...provider(() => {
      supportCalls++;
      return supportCalls === 1 ? true : ({ supported: true } as unknown as boolean);
    }),
    execute: async () => {
      dispatches++;
      throw new Error('provider.execute must never be called');
    }
  });
  try {
    const result = await runtime.execute(action, { allowedCapabilities: ['git.status'], allowedRoots: [] });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'PROVIDER_SUPPORT_CONTRACT_INVALID');
    assert.equal(supportCalls, 2);
    assert.equal(dispatches, 0);
  } finally {
    await runtime.close();
  }
});

test('C02 provider identity is unique and cannot be confused during reconciliation', async () => {
  const router = new CapabilityRouter();
  router.register(provider(() => true));
  assert.throws(() => router.register(provider(() => true)), (error: any) =>
    error?.code === 'PROVIDER_REGISTRY_INVALID');
  for (const name of ['', 'bad name', 'bad\\nname', '__proto__']) {
    const other = { ...provider(() => true), name };
    assert.throws(() => router.register(other), (error: any) =>
      error?.code === 'PROVIDER_REGISTRY_INVALID');
  }
  assert.equal((await router.provider('c02-fixture'))?.name, 'c02-fixture');
  assert.equal(router.providers().length, 1);
});

test('C02 incomplete provider registration is rejected before any dispatch', () => {
  const router = new CapabilityRouter();
  assert.throws(() => router.register({
    name: 'incomplete',
    supports: () => true,
    execute: async () => { throw new Error('must not run'); }
  } as unknown as CapabilityProvider), (error: any) =>
    error?.code === 'PROVIDER_REGISTRY_INVALID');
  assert.equal(router.providers().length, 0);
});

test('C02 capability schema collection must be literal, unique and bounded before presentation', async () => {
  const schema = {
    capability: 'git.status', risk: 'read' as const,
    inputSchemaVersion: 1 as const, inputMaxBytes: 1024,
    cancellation: 'required' as const, resourceKinds: ['git-repository']
  };
  for (const supplied of [
    { filter: () => [schema] },
    [null],
    Array.from({ length: 257 }, () => schema),
    [schema, schema],
    [{ ...schema, capability: ['git.status'] }],
    [{ ...schema, resourceKinds: [true] }]
  ]) {
    const router = new CapabilityRouter();
    router.register({
      ...provider(() => true),
      capabilitySchemas: () => supplied as unknown as any
    });
    await assert.rejects(router.capabilitySchemas(action),
      (error: any) => error?.code === 'CAPABILITY_SCHEMA_INVALID');
  }
  const router = new CapabilityRouter();
  router.register({ ...provider(() => true), capabilitySchemas: () => [schema] });
  assert.deepEqual(await router.capabilitySchemas(action), [{ ...schema, provider: 'c02-fixture' }]);
});

test('C02 router never executes property getters in provider score objects', async () => {
  let invoked = 0;
  for (const key of [...Object.keys(score), 'unrelated']) {
    const scored = { ...score } as Record<string, unknown>;
    Object.defineProperty(scored, key, {
      enumerable: true, get() { invoked++; return 1; }
    });
    const router = new CapabilityRouter();
    router.register({
      ...provider(() => true),
      score: () => scored as unknown as CapabilityScore
    });
    await assert.rejects(router.rank(action), (error: any) =>
      error?.code === 'PROVIDER_SCORE_CONTRACT_INVALID', 'getter score key ' + key);
  }
  assert.equal(invoked, 0, 'no accessor executes during route ranking');
  const valid = new CapabilityRouter();
  valid.register(provider(() => true));
  assert.equal((await valid.rank(action))[0]?.provider.name, 'c02-fixture');
});

test('C02 provider score cannot be a class or an array masquerading as metrics', async () => {
  class ScoreImpersonator {
    constructor() { Object.assign(this, score); }
  }
  const values = [Object.assign([], score), new ScoreImpersonator(),
    { ...score, security: Infinity }, { ...score, unused: 1 }];
  for (const value of values) {
    const router = new CapabilityRouter();
    router.register({
      ...provider(() => true), score: () => value as CapabilityScore
    });
    await assert.rejects(router.rank(action), (error: any) =>
      error?.code === 'PROVIDER_SCORE_CONTRACT_INVALID');
  }
});
