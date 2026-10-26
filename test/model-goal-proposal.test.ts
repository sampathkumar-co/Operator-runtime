import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { validateModelGoalProposal, type ModelGoalProposalRequest } from '../src/core/model-goal-proposal.ts';

const root = path.resolve(os.tmpdir(), 'c05-allowed-project');
const foreign = path.resolve(os.tmpdir(), 'c05-foreign-project');
const request: ModelGoalProposalRequest = {
  objective: 'Inspect approved site and validate a project',
  approvedBrowserOrigins: ['https://approved.example'],
  approvedRoots: [root]
};
const navigation = { kind: 'browser-navigation', url: 'https://approved.example/guide' };
const command = { kind: 'trusted-project-command', root, commandKind: 'test' };
const proposed = (goal: unknown) => ({
  goal, successConditions: ['Independently observe the requested final state']
});
const invalid = (goal: unknown, code: string) => assert.throws(
  () => validateModelGoalProposal(proposed(goal), request),
  (error: any) => error?.code === code
);

test('C05 preflight accepts bounded scoped novel instructions without performing them', () => {
  const goal = validateModelGoalProposal(proposed(navigation), request);
  assert.deepEqual(goal.goal, navigation);
  assert.deepEqual(validateModelGoalProposal(proposed(command), request).goal, command);
  assert.deepEqual(validateModelGoalProposal(proposed({
    kind: 'semantic-workflow', steps: [navigation, command]
  }), request).goal, { kind: 'semantic-workflow', steps: [navigation, command] });
  assert.deepEqual(validateModelGoalProposal(proposed({
    kind: 'project-quality-gate', root, checks: ['test', 'lint'], requireAll: true
  }), request).goal, { kind: 'project-quality-gate', root, checks: ['test', 'lint'], requireAll: true });
});
test('C05 model cannot invent browser origin, browser target ID, or credentials', () => {
  invalid({ ...navigation, url: 'https://unapproved.example/path' }, 'TASK_PROPOSAL_SCOPE_DENIED');
  invalid({ ...navigation, url: 'https://approved.example@unapproved.example/path' }, 'TASK_PROPOSAL_SCOPE_DENIED');
  invalid({ ...navigation, url: 'javascript:alert(1)' }, 'TASK_PROPOSAL_SCOPE_DENIED');
  invalid({ ...navigation, targetId: 'invented-tab' }, 'TASK_PROPOSAL_INVALID');
  invalid({ ...navigation, url: 'https://name:secret@approved.example/' }, 'TASK_PROPOSAL_SCOPE_DENIED');
  invalid({ ...navigation, url: 'https://approved.example.evil/path' }, 'TASK_PROPOSAL_SCOPE_DENIED');
  invalid({ ...navigation, action: 'click', selector: '#pay' }, 'TASK_PROPOSAL_INVALID');
});
test('C05 model project operations are restricted to exact approved roots and known checks', () => {
  invalid({ ...command, root: foreign }, 'TASK_PROPOSAL_SCOPE_DENIED');
  invalid({ ...command, root: root + '-lookalike' }, 'TASK_PROPOSAL_SCOPE_DENIED');
  invalid({ ...command, root: 'relative/root' }, 'TASK_PROPOSAL_INVALID');
  invalid({ ...command, commandKind: 'exec' }, 'TASK_PROPOSAL_INVALID');
  invalid({ ...command, shell: 'rm -rf' }, 'TASK_PROPOSAL_INVALID');
  const nested = { ...command, root: path.join(root, 'child') };
  assert.equal((validateModelGoalProposal(proposed(nested), request).goal as any).root, nested.root);
});
test('C05 project quality gates cannot accept partial, repeated, or destructive checks', () => {
  const quality = { kind: 'project-quality-gate', root, checks: ['test', 'build'], requireAll: true };
  for (const bad of [
    { ...quality, requireAll: false },
    { ...quality, checks: ['test', 'test'] },
    { ...quality, checks: ['test', 'shell'] },
    { ...quality, checks: ['test'] },
    { ...quality, root: foreign },
    { ...quality, extraPermission: 'system' }
  ]) invalid(bad, bad.root === foreign ? 'TASK_PROPOSAL_SCOPE_DENIED' : 'TASK_PROPOSAL_INVALID');
});
test('C05 rejects oversized, duplicate and unsupported steps without any action', () => {
  invalid({ kind: 'semantic-workflow', steps: [navigation, navigation] }, 'TASK_PROPOSAL_INVALID');
  invalid({ kind: 'semantic-workflow', steps: [command] }, 'TASK_PROPOSAL_INVALID');
  invalid({ kind: 'semantic-workflow', steps: [navigation, command, navigation, command, navigation] },
    'TASK_PROPOSAL_INVALID');
  invalid({ kind: 'semantic-workflow', steps: [navigation, {
    kind: 'controlled-file-change', root, path: 'proof.txt', content: 'do not run'
  }] }, 'TASK_PROPOSAL_INVALID');
  invalid({ kind: 'semantic-workflow', steps: [navigation, { ...command, root: foreign }] },
    'TASK_PROPOSAL_SCOPE_DENIED');
});
test('C05 model input cannot supply permissions, claimed evidence or malformed success conditions', () => {
  assert.throws(() => validateModelGoalProposal({
    ...proposed(navigation), permissions: ['all']
  }, request), (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  for(const conditions of [[], [''], ['a'.repeat(513)], [null], ['a','b','c','d','e','f']]) {
    assert.throws(() => validateModelGoalProposal({
      goal: navigation, successConditions: conditions
    }, request), (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  }
  assert.throws(() => validateModelGoalProposal(proposed(navigation), {
    ...request, approvedRoots: [], approvedBrowserOrigins: []
  }), (error: any) => error?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  assert.throws(() => validateModelGoalProposal(proposed(navigation), {
    ...request, approvedBrowserOrigins: ['https://approved.example/path']
  }), (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  assert.throws(() => validateModelGoalProposal(proposed(navigation), {
    ...request, approvedRoots: ['../relative']
  }), (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
});

test('C05 model workflow and success contracts reject sparse or executable array slots', () => {
  const sparseSteps: unknown[] = new Array(2);
  sparseSteps[1] = navigation;
  const sparseConditions: unknown[] = new Array(2);
  sparseConditions[1] = 'Only one actual success condition';
  const extraSteps = Object.assign([navigation, command], { ignoredStep: navigation });
  const symbolConditions = ['Observe independent proof'] as unknown[] & Record<symbol, unknown>;
  symbolConditions[Symbol('hidden')] = 'bypass';
  const getterChecks = ['test', 'lint'];
  let accessorCalls = 0;
  Object.defineProperty(getterChecks, '1', {
    enumerable: true, get() { accessorCalls++; throw Error('must not run'); }
  });
  const customSteps = [navigation, command];
  Object.setPrototypeOf(customSteps, Object.create(Array.prototype));

  const attempts = [
    proposed({ kind: 'semantic-workflow', steps: sparseSteps }),
    proposed({ kind: 'semantic-workflow', steps: extraSteps }),
    proposed({ kind: 'semantic-workflow', steps: customSteps }),
    { goal: navigation, successConditions: sparseConditions },
    { goal: navigation, successConditions: symbolConditions },
    proposed({ kind: 'project-quality-gate', root, checks: getterChecks, requireAll: true })
  ];
  for (const malformed of attempts) {
    assert.throws(() => validateModelGoalProposal(malformed, request),
      (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  }
  assert.equal(accessorCalls, 0);
  assert.deepEqual(validateModelGoalProposal(proposed({
    kind: 'semantic-workflow', steps: [navigation, command]
  }), request).goal, { kind: 'semantic-workflow', steps: [navigation, command] });
});

test('C05 model envelopes cannot run accessors or hide extra authority fields', () => {
  let invoked = 0;
  const getterResponse = Object.defineProperty({ successConditions: ['check'] }, 'goal', {
    enumerable: true,
    get() { invoked++; throw Error('untrusted model getter'); }
  });
  const getterGoal = Object.defineProperty({ url: navigation.url }, 'kind', {
    enumerable: true,
    get() { invoked++; throw Error('untrusted goal getter'); }
  });
  const hidden = Object.defineProperty({ ...navigation }, 'authorization', {
    enumerable: false, value: true
  });
  for (const malformed of [
    getterResponse,
    proposed(getterGoal),
    proposed(hidden),
    proposed({ ...navigation, [Symbol('approval')]: 'all' })
  ]) {
    assert.throws(() => validateModelGoalProposal(malformed, request),
      (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  }
  const rootsWithHole: string[] = new Array(2);
  rootsWithHole[1] = root;
  assert.throws(() => validateModelGoalProposal(proposed(navigation), {
    ...request, approvedRoots: rootsWithHole
  }), (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  assert.equal(invoked, 0);
});
