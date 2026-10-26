import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeExecutionContextIdentity,
  executionContextIdentityFrom,
  executionContextDigest
} from '../src/core/execution-context-identity.ts';

test('C08 execution identity snapshot preserves ordinary typed source and explicit intent', () => {
  const source = {
    accountId: 'user', deviceId: 'device', sessionId: 'session',
    taskId: 'task', actionId: 'action', attempt: 1, authorityVersion: 3,
    intent: { conversationId: 'chat', intentVersion: 4, digest: 'A'.repeat(64) }
  };
  const normalized = executionContextIdentityFrom(source);
  assert.equal(normalized.intentDigest, 'a'.repeat(64));
  assert.equal(normalized.intentVersion, 4);
  assert.equal(normalized.deviceId, 'device');
  assert.equal(normalized.authorityVersion, 3);
  assert.equal(Object.hasOwn(normalized, 'intent'), false);
  assert.equal(executionContextDigest(normalized).length, 64);
});

test('C08 context normalizer refuses executable or inherited principal fields', () => {
  let executed = 0;
  const base = { schemaVersion: 1 as const, taskId: 'task' };
  const malicious = [
    Object.defineProperty({ ...base }, 'deviceId', {
      enumerable: true, get() { executed++; return 'foreign-device'; }
    }),
    Object.defineProperty({ ...base }, 'taskId', {
      enumerable: false, value: 'task'
    }),
    Object.assign(Object.create({ authorityVersion: 2 }), base),
    Object.defineProperty({ ...base }, Symbol('account'), { value: 'injected' }),
    Object.defineProperty({ ...base }, 'intentDigest', {
      enumerable: true, get() { executed++; return 'a'.repeat(64); }
    })
  ];
  for (const candidate of malicious) {
    assert.throws(() => normalizeExecutionContextIdentity(candidate),
      (e: any) => e?.code === 'EXECUTION_IDENTITY_INVALID');
  }
  assert.equal(executed, 0, 'No caller getter should execute during canonicalization');
});

test('C08 context builder snapshots both outer fields and nested intent without invoking getters', () => {
  let executed = 0;
  const badTop = Object.defineProperty({ taskId: 'task' }, 'deviceId', {
    enumerable: true, get() { executed++; return 'foreign-device'; }
  });
  const badIntent = Object.defineProperty({
    conversationId: 'chat', intentVersion: 1
  }, 'digest', {
    enumerable: true, get() { executed++; return 'a'.repeat(64); }
  });
  for (const candidate of [badTop, { taskId: 'task', intent: badIntent }]) {
    assert.throws(() => executionContextIdentityFrom(candidate as any),
      (e: any) => e?.code === 'EXECUTION_IDENTITY_INVALID');
  }
  assert.equal(executed, 0);
});
