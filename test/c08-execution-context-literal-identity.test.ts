import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeExecutionContextIdentity, executionContextDigest
} from '../src/core/execution-context-identity.ts';

test('C08 canonical execution identity binds literal numeric generations and intent hash', () => {
  const identity = {
    schemaVersion: 1 as const,
    accountId: 'account', deviceId: 'device', sessionId: 'session',
    conversationId: 'conversation', intentVersion: 3,
    intentDigest: 'A'.repeat(64), planId: 'plan', planRevision: 2,
    taskId: 'task', actionId: 'action', attempt: 1, authorityVersion: 5
  };
  const normalized = normalizeExecutionContextIdentity(identity);
  assert.equal(normalized.intentDigest, 'a'.repeat(64));
  assert.equal(normalized.intentVersion, 3);
  assert.equal(normalized.planRevision, 2);
  assert.equal(normalized.authorityVersion, 5);
  assert.match(executionContextDigest(normalized), /^[0-9a-f]{64}$/);
});

test('C08 forged or coercible identity generation cannot become a trusted authority version', () => {
  let conversions = 0;
  const object = { valueOf() { conversions++; return 1; }, toString() { conversions++; return '1'; } };
  const good = {
    schemaVersion: 1 as const,
    conversationId: 'conversation', intentVersion: 3,
    intentDigest: 'a'.repeat(64), planId: 'plan', planRevision: 2,
    actionId: 'action', attempt: 1, authorityVersion: 5
  };
  for (const [key, values] of [
    ['intentVersion', ['3', [3], object, null, true, 0, 1.5, Number.NaN]],
    ['planRevision', ['2', [2], object, null, false, -1, Infinity]],
    ['attempt', ['1', [1], object, null, true]],
    ['authorityVersion', ['5', [5], object, null, 0]]
  ] as const) {
    for (const value of values) {
      assert.throws(() => normalizeExecutionContextIdentity({ ...good, [key]: value }),
        (error: any) => error?.code === 'EXECUTION_IDENTITY_INVALID',
        `${key} must refuse a nonliteral positive integer`);
    }
  }
  for (const digest of [
    { toString() { conversions++; return 'a'.repeat(64); } },
    ['a'.repeat(64)], null, 10
  ]) {
    assert.throws(() => normalizeExecutionContextIdentity({ ...good, intentDigest: digest }),
      (error: any) => error?.code === 'EXECUTION_IDENTITY_INVALID');
  }
  assert.equal(conversions, 0, 'No foreign conversion hooks may execute at the authority identity boundary');
});
