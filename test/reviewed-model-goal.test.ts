import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { ReviewedModelGoalBridge } from '../src/core/reviewed-model-goal.ts';
import { TaskProposalReviewRegistry } from '../src/core/task-proposal-review.ts';

const origin = 'https://approved.example';
const root = path.resolve(os.tmpdir(), 'mecord-reviewed-model-goal');
const request = {
  objective: 'Validate this project and inspect the approved page',
  approvedRoots: [root], approvedBrowserOrigins: [origin]
};
const modelOutput = {
  goal: {
    kind: 'semantic-workflow', steps: [
      { kind: 'browser-navigation', url: origin + '/guide' },
      { kind: 'trusted-project-command', root, commandKind: 'test' }
    ]
  },
  successConditions: ['The page and project tests have independent verified outcomes']
};

test('C05 model proposal review only returns options and never executes a task', () => {
  const bridge = new ReviewedModelGoalBridge(new TaskProposalReviewRegistry({ now: () => 1000 }));
  let executionCount = 0;
  const proposed = bridge.propose({ principal: 'user:a', request, modelOutput });
  assert.equal(proposed.executionStarted, false);
  assert.deepEqual(proposed.proposal, modelOutput);
  assert.equal(executionCount, 0);
  const opts = bridge.confirm({
    principal: 'user:a', proposalId: proposed.proposalId, proposalDigest: proposed.proposalDigest,
    currentApprovedScopeFor: () => request
  });
  assert.equal(opts.requestId, proposed.proposalId);
  assert.equal(opts.objective, request.objective);
  assert.deepEqual(opts.goal, modelOutput.goal);
  assert.deepEqual(opts.successConditions, modelOutput.successConditions);
  assert.deepEqual(opts.authorizedScope, ['browser:' + origin, 'project:' + root].sort());
  assert.equal(executionCount, 0);
  assert.throws(() => bridge.confirm({
    principal: 'user:a', proposalId: proposed.proposalId, proposalDigest: proposed.proposalDigest,
    currentApprovedScopeFor: () => { executionCount++; return request; }
  }), (err: any) => err?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  assert.equal(executionCount, 0);
});
test('C05 raw model-invented resources or unsupported operations cannot issue review', () => {
  const bridge = new ReviewedModelGoalBridge();
  for (const goal of [
    { kind: 'browser-navigation', url: 'https://evil.example' },
    { kind: 'browser-navigation', url: origin + '/', targetId: 'invented-tab' },
    { kind: 'trusted-project-command', root, commandKind: 'shell' },
    { kind: 'controlled-file-change', root, path: 'unexpected.txt', content: 'mutation' }
  ]) {
    assert.throws(() => bridge.propose({
      principal: 'user:a', request, modelOutput: { goal, successConditions: ['done'] }
    }), (err: any) => err?.code === 'TASK_PROPOSAL_INVALID' || err?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  }
});
test('C05 changed current permission scope burns the exact one-use review even if goal still fits', () => {
  const bridge = new ReviewedModelGoalBridge();
  const proposed = bridge.propose({ principal: 'user:a', request, modelOutput });
  const confirm = (current: typeof request) => bridge.confirm({
    principal: 'user:a', proposalId: proposed.proposalId, proposalDigest: proposed.proposalDigest,
    currentApprovedScopeFor: () => current
  });
  assert.throws(() => confirm({ ...request, approvedRoots: [] }),
    (err: any) => err?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  assert.throws(() => confirm(request),
    (err: any) => err?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
});
test('C05 foreign principal and forged review digest never dispatch or consume the legitimate review', () => {
  const bridge = new ReviewedModelGoalBridge();
  const p = bridge.propose({ principal: 'user:a', request, modelOutput });
  assert.throws(() => bridge.confirm({
    principal: 'user:foreign', proposalId: p.proposalId, proposalDigest: p.proposalDigest,
    currentApprovedScopeFor: () => request
  }), (err: any) => err?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  assert.throws(() => bridge.confirm({
    principal: 'user:a', proposalId: p.proposalId, proposalDigest: 'a'.repeat(64),
    currentApprovedScopeFor: () => request
  }), (err: any) => err?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
  assert.deepEqual(bridge.confirm({
    principal: 'user:a', proposalId: p.proposalId, proposalDigest: p.proposalDigest,
    currentApprovedScopeFor: () => request
  }).goal, modelOutput.goal);
});
test('C05 nested confirmation callback is unable to consume the same reviewed intent twice', () => {
  const bridge = new ReviewedModelGoalBridge();
  const p = bridge.propose({ principal: 'user:a', request, modelOutput });
  const confirm = (callback: () => typeof request) => bridge.confirm({
    principal: 'user:a', proposalId: p.proposalId, proposalDigest: p.proposalDigest,
    currentApprovedScopeFor: () => callback()
  });
  assert.deepEqual(confirm(() => {
    assert.throws(() => confirm(() => request),
      (err: any) => err?.code === 'TASK_PROPOSAL_REVIEW_INVALID');
    return request;
  }).goal, modelOutput.goal);
});
