import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskProposalReviewRegistry } from '../src/core/task-proposal-review.ts';
import type { TaskGoalProposal } from '../src/core/task-goal-interpreter.ts';

const browser: TaskGoalProposal = {
  goal: { kind: 'browser-navigation', url: 'https://approved.example/test' },
  successConditions: ['Observe expected URL']
};

test('review is principal bound, scoped, immutable and one use', () => {
  const registry = new TaskProposalReviewRegistry({ now: () => 1_000_000 });
  const scope = ['browser:https://approved.example'];
  const original = structuredClone(browser);
  const issued = registry.issue({ principal: 'local-user', objective: 'Inspect approved URL', proposal: original, scope });
  assert.match(issued.proposalId, /^[0-9a-f-]{36}$/);
  assert.match(issued.proposalDigest, /^[0-9a-f]{64}$/);
  original.goal = { kind: 'browser-navigation', url: 'https://evil.example' };
  const confirm = (overrides: Record<string, unknown> = {}) => registry.consume({
    proposalId: issued.proposalId, proposalDigest: issued.proposalDigest, principal: 'local-user',
    currentScopeFor: () => scope, ...overrides
  });
  assert.throws(() => confirm({ principal: 'relay:another-principal' }),
    (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  assert.throws(() => confirm({ proposalDigest: '0'.repeat(64) }),
    (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  assert.throws(() => confirm({ currentScopeFor: () => ['browser:https://evil.example'] }),
    (error: any) => error?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  const result = confirm();
  assert.deepEqual(result.proposal, browser);
  assert.equal(result.objective, 'Inspect approved URL');
  assert.equal(result.requestId, issued.proposalId);
  assert.throws(() => confirm(), (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
});

test('review TTL, capacity and missing current permissions fail closed', () => {
  let now = 2000;
  const registry = new TaskProposalReviewRegistry({ now: () => now, lifetimeMs: 100, limit: 1 });
  const scope = ['browser:https://approved.example'];
  const first = registry.issue({ principal: 'local-user', objective: 'Inspect', proposal: browser, scope });
  assert.throws(() => registry.issue({ principal: 'local-user', objective: 'Inspect again', proposal: browser, scope }),
    (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_CAPACITY');
  assert.throws(() => registry.consume({ proposalId: first.proposalId,
    proposalDigest: first.proposalDigest, principal: 'local-user', currentScopeFor: () => null }),
  (error: any) => error?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  now += 101;
  assert.throws(() => registry.consume({ proposalId: first.proposalId,
    proposalDigest: first.proposalDigest, principal: 'local-user', currentScopeFor: () => scope }),
  (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  const renewed = registry.issue({ principal: 'local-user', objective: 'Inspect again', proposal: browser, scope });
  assert.notEqual(renewed.proposalId, first.proposalId);
  registry.clear();
  assert.throws(() => registry.consume({ proposalId: renewed.proposalId,
    proposalDigest: renewed.proposalDigest, principal: 'local-user', currentScopeFor: () => scope }),
  (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
});
