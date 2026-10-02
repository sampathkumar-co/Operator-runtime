import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityRouter } from '../src/core/router.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { OperatorError } from '../src/core/errors.ts';
import type { ActionResult, CapabilityProvider, PermissionProfile } from '../src/core/types.ts';

function provider(name: string, reliability: number, latency: number): CapabilityProvider {
  return {
    name,
    supports: () => true,
    score: () => ({ reliability, latency, determinism: reliability, security: reliability, reversibility: reliability, informationQuality: reliability, interactionCost: latency }),
    execute: async (action) => ({ ok: true, capability: action.capability, provider: name, evidence: [], durationMs: 0 })
  };
}

test('router prefers stronger semantic capability by weighted quality', async () => {
  const router = new CapabilityRouter();
  router.register(provider('vision.mouse', 0.65, 0.8));
  router.register(provider('git.native', 0.99, 0.05));
  const selected = await router.select({ id: 'x', capability: 'git.status', risk: 'read', input: {}, provenance: { kind: 'chatgpt' } });
  assert.equal(selected.name, 'git.native');
});

test('runtime advertises only locally supported capabilities in stable order', async () => {
  const runtime = new OperatorRuntime();
  runtime.register({
    ...provider('local.dynamic', 0.9, 0.1),
    supports: (action) => ['file.read', 'git.status'].includes(action.capability)
  });
  const supported = await runtime.supportedCapabilities(['git.diff', 'file.read', 'git.status', 'file.read']);
  assert.deepEqual(supported, ['file.read', 'git.status']);
});

test('runtime keeps unavailable claimed capabilities routable while omitting them from advertisement', async () => {
  const runtime = new OperatorRuntime();
  runtime.register({
    ...provider('git.mock', 0.99, 0.05),
    supports: (action) => action.capability === 'git.status',
    advertises: () => false,
    execute: async (action) => ({
      ok: false,
      capability: action.capability,
      provider: 'git.mock',
      evidence: [],
      error: { code: 'GIT_VERSION_UNSUPPORTED', message: 'Git 2.45+ is required.', retryable: false },
      durationMs: 0
    })
  });

  assert.deepEqual(await runtime.supportedCapabilities(['git.status']), []);
  const result = await runtime.execute({
    id: 'git-version-error',
    capability: 'git.status',
    risk: 'read',
    input: {},
    provenance: { kind: 'runtime' }
  }, { allowedCapabilities: ['git.status'], allowedRoots: [] });
  assert.equal(result.ok, false);
  assert.equal(result.provider, 'git.mock');
  assert.equal(result.error?.code, 'GIT_VERSION_UNSUPPORTED');
});

const WRITE_PERMISSIONS: PermissionProfile = {
  allowedCapabilities: ['file.write'],
  allowedRoots: [],
  maxRisk: 'destructive'
};

function failingProvider(name: string, reliability: number, failure: ActionResult['error'], calls: string[]): CapabilityProvider {
  return {
    ...provider(name, reliability, 0),
    execute: async (action) => {
      calls.push(name);
      return { ok: false, capability: action.capability, provider: name, evidence: [], error: failure, durationMs: 0 };
    }
  };
}

test('runtime does not fallback a mutation after non-retryable uncertain failure', async () => {
  const calls: string[] = [];
  const runtime = new OperatorRuntime()
    .register(failingProvider('first', 1, { code: 'FAILED', message: 'uncertain', retryable: false, sideEffectState: 'uncertain' }, calls))
    .register({ ...provider('second', 0.5, 0), execute: async (action) => { calls.push('second'); return { ok: true, capability: action.capability, provider: 'second', evidence: [], durationMs: 0 }; } });
  const result = await runtime.execute({ id: 'a', capability: 'file.write', risk: 'write', input: {}, provenance: { kind: 'runtime' } }, WRITE_PERMISSIONS);
  assert.deepEqual(calls, ['first']);
  assert.equal(result.error?.sideEffectState, 'uncertain');
});

test('runtime does not fallback a mutation after retryable uncertain failure', async () => {
  const calls: string[] = [];
  const runtime = new OperatorRuntime()
    .register(failingProvider('first', 1, { code: 'TRANSIENT', message: 'response lost', retryable: true, sideEffectState: 'uncertain' }, calls))
    .register({ ...provider('second', 0.5, 0), execute: async (action) => { calls.push('second'); return { ok: true, capability: action.capability, provider: 'second', evidence: [], durationMs: 0 }; } });
  const result = await runtime.execute({ id: 'b', capability: 'file.write', risk: 'write', input: {}, provenance: { kind: 'runtime' } }, WRITE_PERMISSIONS);
  assert.deepEqual(calls, ['first']);
  assert.equal(result.error?.sideEffectState, 'uncertain');
});

test('runtime may fallback a mutation only when retryable failure proves no side effect', async () => {
  const calls: string[] = [];
  const runtime = new OperatorRuntime()
    .register(failingProvider('first', 1, { code: 'PRE_DISPATCH', message: 'not dispatched', retryable: true, sideEffectState: 'none' }, calls))
    .register({ ...provider('second', 0.5, 0), execute: async (action) => { calls.push('second'); return { ok: true, capability: action.capability, provider: 'second', evidence: [], durationMs: 0 }; } });
  const result = await runtime.execute({ id: 'c', capability: 'file.write', risk: 'write', input: {}, provenance: { kind: 'runtime' } }, WRITE_PERMISSIONS);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(result.ok, true);
});

test('runtime preserves safe read fallback after transient provider failure', async () => {
  const calls: string[] = [];
  const runtime = new OperatorRuntime()
    .register(failingProvider('first', 1, { code: 'TRANSIENT', message: 'temporary', retryable: true }, calls))
    .register({ ...provider('second', 0.5, 0), execute: async (action) => { calls.push('second'); return { ok: true, capability: action.capability, provider: 'second', evidence: [], durationMs: 0 }; } });
  const result = await runtime.execute({ id: 'd', capability: 'file.read', risk: 'read', input: {}, provenance: { kind: 'runtime' } }, { allowedCapabilities: ['file.read'], allowedRoots: [] });
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(result.ok, true);
});

test('runtime treats mutation provider exceptions as uncertain and does not fallback', async () => {
  const calls: string[] = [];
  const runtime = new OperatorRuntime()
    .register({ ...provider('first', 1, 0), execute: async () => { calls.push('first'); throw new OperatorError('CONNECTION_LOST', 'lost after dispatch', { retryable: true }); } })
    .register({ ...provider('second', 0.5, 0), execute: async (action) => { calls.push('second'); return { ok: true, capability: action.capability, provider: 'second', evidence: [], durationMs: 0 }; } });
  const result = await runtime.execute({ id: 'e', capability: 'file.write', risk: 'write', input: {}, provenance: { kind: 'runtime' } }, WRITE_PERMISSIONS);
  assert.deepEqual(calls, ['first']);
  assert.equal(result.error?.sideEffectState, 'uncertain');
});
