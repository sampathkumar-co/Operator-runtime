import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskProposalReviewRegistry, type ReviewedTaskProposal } from '../src/core/task-proposal-review.ts';

const original: ReviewedTaskProposal = {
  goal: { kind: 'browser-navigation', url: 'https://approved.example/check' },
  successConditions: ['The destination is independently observed']
};
const scope = ['browser:https://approved.example'];

test('C05 review binds principal, exact goal, authorized scope and consumes only once', () => {
  const registry = new TaskProposalReviewRegistry({ now: () => 2000 });
  const proposal = structuredClone(original);
  const issued = registry.issue({ principal: 'p1', objective: 'Inspect page', proposal, scope });
  proposal.goal = { kind: 'browser-navigation', url: 'https://unapproved.example/' };
  const consume = (overrides: Record<string, unknown> = {}) => registry.consume({
    proposalId: issued.proposalId, proposalDigest: issued.proposalDigest,
    principal: 'p1', currentScopeFor: () => scope, ...overrides
  });
  assert.throws(() => consume({ principal: 'foreign' }),
    (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  assert.throws(() => consume({ proposalDigest: '0'.repeat(64) }),
    (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  const receipt = consume();
  assert.deepEqual(receipt.proposal, original);
  assert.equal(receipt.objective, 'Inspect page');
  assert.equal(receipt.requestId, issued.proposalId);
  assert.throws(() => consume(), (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
});
test('C05 authorization callback reentrancy cannot consume review twice', () => {
  const registry = new TaskProposalReviewRegistry({ now: () => 2000 });
  const issued = registry.issue({ principal: 'p1', objective: 'Inspect page', proposal: original, scope });
  let entered = 0;
  const consume = () => registry.consume({
    proposalId: issued.proposalId, proposalDigest: issued.proposalDigest,
    principal: 'p1', currentScopeFor: () => {
      entered++;
      assert.throws(() => consume(), (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
      return scope;
    }
  });
  const result = consume();
  assert.equal(entered, 1);
  assert.deepEqual(result.proposal, original);
  assert.throws(() => consume(), (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
});
test('C05 denied or throwing current permission check burns review irreversibly', () => {
  const registry = new TaskProposalReviewRegistry({ now: () => 2000 });
  const issue = () => registry.issue({ principal: 'p1', objective: 'Inspect', proposal: original, scope });
  const first = issue();
  const consume = (issued: ReturnType<typeof issue>, cb: () => string[] | null) => registry.consume({
    proposalId: issued.proposalId, proposalDigest: issued.proposalDigest,
    principal: 'p1', currentScopeFor: cb
  });
  assert.throws(() => consume(first, () => ['browser:https://evil.example']),
    (error: any) => error?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  assert.throws(() => consume(first, () => scope),
    (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  const second = issue();
  assert.throws(() => consume(second, () => { throw new Error('permission backend failed'); }),
    /permission backend failed/);
  assert.throws(() => consume(second, () => scope),
    (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
});
test('C05 short expiration, capacity, reset and invalid clock cannot create authority', () => {
  let now = 2000;
  const registry = new TaskProposalReviewRegistry({ now: () => now, lifetimeMs: 100, limit: 1 });
  const issue = () => registry.issue({ principal: 'p1', objective: 'Inspect', proposal: original, scope });
  const first = issue();
  assert.throws(() => issue(), (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_CAPACITY');
  now += 101;
  assert.throws(() => registry.consume({ proposalId: first.proposalId,
    proposalDigest: first.proposalDigest, principal: 'p1', currentScopeFor: () => scope }),
  (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  const second = issue();
  registry.clear();
  assert.throws(() => registry.consume({ proposalId: second.proposalId,
    proposalDigest: second.proposalDigest, principal: 'p1', currentScopeFor: () => scope }),
  (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  assert.throws(() => new TaskProposalReviewRegistry({ limit: 513 }),
    (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_CONFIG_INVALID');
  const invalidClock = new TaskProposalReviewRegistry({ now: () => Number.NaN });
  assert.throws(() => invalidClock.issue({ principal: 'p1', objective: 'Inspect', proposal: original, scope }),
    (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_CONFIG_INVALID');
});
test('C05 rejects malformed and oversized proposal data before storing a confirmation', () => {
  const registry = new TaskProposalReviewRegistry();
  for (const malformed of [
    { goal: null, successConditions: ['yes'] },
    { goal: original.goal, successConditions: [] },
    { goal: original.goal, successConditions: [''] },
    { goal: original.goal, successConditions: ['X'.repeat(513)] },
    { goal: { kind: 'controlled-file-change', content: 'x'.repeat(25_000) },
      successConditions: ['yes'] }
  ]) {
    assert.throws(() => registry.issue({ principal: 'p1', objective: 'Inspect',
      proposal: malformed as ReviewedTaskProposal, scope }),
    (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  }
});
