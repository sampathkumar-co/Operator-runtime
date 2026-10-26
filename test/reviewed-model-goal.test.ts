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

test('C05 proposal issue rejects changing getters instead of binding mismatched scope', () => {
  const bridge = new ReviewedModelGoalBridge();
  let invoked = 0;
  const scopeWithGetter = Object.defineProperty({
    objective: request.objective,
    approvedRoots: [...request.approvedRoots]
  }, 'approvedBrowserOrigins', {
    enumerable: true,
    get() {
      invoked++;
      return invoked === 1 ? [origin] : [origin, 'https://unapproved.example'];
    }
  });
  assert.throws(() => bridge.propose({
    principal: 'user:a', request: scopeWithGetter, modelOutput
  }), (err: any) => err?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  assert.equal(invoked, 0, 'untrusted authority getters must never run');
});

test('C05 issued review remains bound to its consent-time authority after caller mutation', () => {
  const bridge = new ReviewedModelGoalBridge();
  const callerOwned = {
    objective: request.objective,
    approvedBrowserOrigins: [...request.approvedBrowserOrigins],
    approvedRoots: [...request.approvedRoots]
  };
  const review = bridge.propose({ principal: 'user:a', request: callerOwned, modelOutput });
  callerOwned.objective = 'Perform a different task';
  callerOwned.approvedBrowserOrigins.push('https://unapproved.example');
  callerOwned.approvedRoots.push(path.join(root, 'another-root'));
  assert.throws(() => bridge.confirm({
    principal: 'user:a', proposalId: review.proposalId,
    proposalDigest: review.proposalDigest, currentApprovedScopeFor: () => callerOwned
  }), (err: any) => err?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  const another = bridge.propose({ principal: 'user:a', request, modelOutput });
  const verified = bridge.confirm({
    principal: 'user:a', proposalId: another.proposalId,
    proposalDigest: another.proposalDigest, currentApprovedScopeFor: () => request
  });
  assert.equal(verified.objective, request.objective);
  assert.deepEqual(verified.authorizedScope, ['browser:' + origin, 'project:' + root].sort());
});

test('C05 no hidden or sparse permission fields can enter reviewed proposal binding', () => {
  const bridge = new ReviewedModelGoalBridge();
  const sparse: string[] = new Array(2);
  sparse[1] = origin;
  const hidden = Object.defineProperty({ ...request }, 'extraAuthority', {
    value: 'system', enumerable: false
  });
  const symbol = { ...request, [Symbol('policy')]: 'external' };
  for (const invalidRequest of [
    { ...request, approvedBrowserOrigins: sparse },
    hidden, symbol,
    { ...request, approvedRoots: Object.assign([...request.approvedRoots], { hidden: root }) }
  ]) {
    assert.throws(() => bridge.propose({
      principal: 'user:a', request: invalidRequest as typeof request, modelOutput
    }), (err: any) => err?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  }
});

test('C05 confirmation refuses executable or hidden current-scope permissions before issuing options', () => {
  const bridge = new ReviewedModelGoalBridge();
  let invoked = 0;
  const issued = bridge.propose({ principal: 'user:a', request, modelOutput });
  const shifting = Object.defineProperty({
    objective: request.objective,
    approvedRoots: [...request.approvedRoots]
  }, 'approvedBrowserOrigins', {
    enumerable: true, get() {
      invoked++;
      return invoked === 1 ? [origin] : [origin, 'https://unauthorized.example'];
    }
  });
  const confirm = (current: unknown) => bridge.confirm({
    principal: 'user:a',
    proposalId: issued.proposalId, proposalDigest: issued.proposalDigest,
    currentApprovedScopeFor: () => current as typeof request
  });
  assert.throws(() => confirm(shifting),
    (error: any) => error?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  assert.equal(invoked, 0, 'No current permission getter may execute');
  assert.throws(() => confirm(request),
    (error: any) => error?.code === 'TASK_PROPOSAL_REVIEW_INVALID',
    'Invalid current scope must burn the one-use review token');
});

test('C05 confirmation rejects a current authorized-root array with an executable slot', () => {
  const bridge = new ReviewedModelGoalBridge();
  const issued = bridge.propose({ principal: 'user:a', request, modelOutput });
  let invoked = 0;
  const roots = Object.defineProperty([...request.approvedRoots], '0', {
    enumerable: true, get() { invoked++; return root; }
  });
  assert.throws(() => bridge.confirm({
    principal: 'user:a', proposalId: issued.proposalId,
    proposalDigest: issued.proposalDigest,
    currentApprovedScopeFor: () => ({
      ...request, approvedRoots: roots
    })
  }), (error: any) => error?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  assert.equal(invoked, 0);
});
