import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTRACT_REGISTRY, assertContractRegistryValid, contractRegistration } from '../src/core/contract-registry.ts';
import {
  executionContextDigest,
  executionContextIdentityFrom,
  normalizeExecutionContextIdentity,
  sameExecutionContext
} from '../src/core/execution-context-identity.ts';

test('contract registry has unique valid versioned entries', () => {
  assert.doesNotThrow(() => assertContractRegistryValid());
  assert.equal(new Set(CONTRACT_REGISTRY.map((item) => item.name)).size, CONTRACT_REGISTRY.length);
  assert.equal(contractRegistration('execution-context-identity').persistent, true);
});

test('execution context binds complete intent lineage and plan revision', () => {
  const identity = executionContextIdentityFrom({
    accountId: 'acct-1',
    deviceId: 'device-1',
    sessionId: 'session-1',
    intent: {
      conversationId: 'conversation-1',
      intentVersion: 3,
      digest: 'a'.repeat(64)
    },
    taskId: 'task-1',
    goalId: 'goal-1',
    planId: 'plan-1',
    planRevision: 2,
    nodeId: 'node-1',
    actionId: 'action-1',
    attempt: 1,
    authorityVersion: 4,
    resourceRevision: 'resource-rev-9',
    leaseId: 'lease-1',
    fenceToken: 'fence-2',
    evaluationRunId: 'eval-1'
  });
  assert.equal(identity.intentVersion, 3);
  assert.equal(identity.planRevision, 2);
  assert.match(executionContextDigest(identity), /^[0-9a-f]{64}$/);
  assert.equal(sameExecutionContext(identity, structuredClone(identity)), true);
});

test('execution context refuses partial intent lineage', () => {
  assert.throws(() => normalizeExecutionContextIdentity({
    schemaVersion: 1,
    conversationId: 'conversation-1',
    intentVersion: 1
  }), /must be supplied together/);
});

test('execution context refuses attempt without exact action identity', () => {
  assert.throws(() => normalizeExecutionContextIdentity({
    schemaVersion: 1,
    taskId: 'task-1',
    attempt: 2
  }), /attempt requires actionId/);
});

test('execution context digest changes when an authoritative revision changes', () => {
  const left = normalizeExecutionContextIdentity({
    schemaVersion: 1,
    taskId: 'task-1',
    actionId: 'action-1',
    attempt: 1,
    authorityVersion: 1
  });
  const right = normalizeExecutionContextIdentity({
    schemaVersion: 1,
    taskId: 'task-1',
    actionId: 'action-1',
    attempt: 1,
    authorityVersion: 2
  });
  assert.notEqual(executionContextDigest(left), executionContextDigest(right));
});
