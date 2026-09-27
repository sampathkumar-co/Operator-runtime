import assert from 'node:assert/strict';
import test from 'node:test';
import { OutcomePlanner } from '../src/core/outcome-planner.ts';

test('stage10 outcome planner expands only already-authorized static capabilities beneath maxRisk', () => {
  const planner = new OutcomePlanner();
  const plan = planner.plan({
    objective: 'Repair the project and prove it works',
    scopeKey: 'project:alpha',
    successConditions: ['build succeeds', 'verification passes'],
    maxRisk: 'write',
    availableCapabilities: ['project.inspect', 'file.read', 'file.write', 'file.replace', 'file.manage', 'browser.interact', 'terminal.session'],
    requestedCapabilities: ['project.inspect', 'file.read', 'file.write', 'browser.interact'],
    resources: ['repo:/workspace/alpha']
  });

  assert.match(plan.planDigest, /^[0-9a-f]{64}$/);
  assert.equal(plan.maxRisk, 'write');
  const capabilities = new Set(plan.workItems.flatMap((item) => item.allowedCapabilities ?? []));
  assert.ok(capabilities.has('project.inspect'));
  assert.ok(capabilities.has('file.read'));
  assert.ok(capabilities.has('file.write'));
  assert.equal(capabilities.has('file.replace'), false);
  assert.equal(capabilities.has('browser.interact'), false);
  assert.equal(capabilities.has('terminal.session'), false);
  assert.deepEqual(plan.excludedDynamicCapabilities, ['file.manage', 'terminal.session']);
  assert.ok(plan.workItems.every((item) => JSON.stringify(item.resources) === JSON.stringify(['repo:/workspace/alpha'])));
  assert.ok(plan.workItems.every((item) => !(item.allowedCapabilities ?? []).includes('file.replace')));
});

test('stage10 outcome planner creates independent tester and verifier coverage for generated work', () => {
  const planner = new OutcomePlanner();
  const plan = planner.plan({
    objective: 'Make a bounded change',
    scopeKey: 'project:beta',
    successConditions: ['desired state is observable'],
    maxRisk: 'write',
    availableCapabilities: ['file.read', 'file.write'],
    requestedCapabilities: ['file.read', 'file.write'],
    resources: ['file:/workspace/beta/output.txt']
  });
  const byKey = new Map(plan.workItems.map((item) => [item.key, item]));
  assert.deepEqual(plan.workItems.map((item) => item.key), ['plan', 'execute-write', 'test', 'verify']);
  assert.deepEqual(byKey.get('execute-write')?.dependsOn, ['plan']);
  assert.deepEqual(byKey.get('test')?.dependsOn, ['execute-write']);
  assert.deepEqual(byKey.get('verify')?.dependsOn, ['test']);
  assert.equal(byKey.get('verify')?.role, 'verifier');
  assert.equal(byKey.get('verify')?.risk, 'read');
});

test('stage10 outcome planner honors an explicit read-only ceiling', () => {
  const planner = new OutcomePlanner();
  const plan = planner.plan({
    objective: 'Inspect without changing anything',
    scopeKey: 'project:gamma',
    successConditions: ['state is understood'],
    availableCapabilities: ['file.read', 'file.write', 'browser.interact', 'process.manage'],
    requestedCapabilities: ['file.read'],
    resources: ['file:/workspace/gamma/state.json']
  });
  assert.deepEqual(plan.workItems.map((item) => item.key), ['plan', 'test', 'verify']);
  assert.ok(plan.workItems.every((item) => item.risk === 'read'));
  assert.ok(plan.workItems.every((item) => !(item.allowedCapabilities ?? []).includes('file.write')));
});

test('stage10 outcome planner fails closed when no authorized read observation capability exists', () => {
  const planner = new OutcomePlanner();
  assert.throws(
    () => planner.plan({
      objective: 'Impossible blind operation',
      scopeKey: 'project:none',
      successConditions: ['verified'],
      availableCapabilities: ['file.write', 'terminal.session'],
      requestedCapabilities: ['file.write'],
      resources: ['file:/workspace/none/output.txt']
    }),
    (error: any) => error?.code === 'OUTCOME_PLAN_CAPABILITY_EMPTY'
  );
});


test('stage10 outcome planner refuses mutation without explicit capability and resource authority', () => {
  const planner = new OutcomePlanner();
  assert.throws(
    () => planner.plan({
      objective: 'Do not widen mutation authority',
      scopeKey: 'project:authority',
      successConditions: ['verified'],
      maxRisk: 'write',
      availableCapabilities: ['file.read', 'file.write']
    }),
    (error: any) => error?.code === 'OUTCOME_PLAN_AUTHORITY_REQUIRED'
  );
  assert.throws(
    () => planner.plan({
      objective: 'Resources are mandatory for mutation',
      scopeKey: 'project:authority',
      successConditions: ['verified'],
      maxRisk: 'write',
      availableCapabilities: ['file.read', 'file.write'],
      requestedCapabilities: ['file.read', 'file.write'],
      resources: []
    }),
    (error: any) => error?.code === 'OUTCOME_PLAN_AUTHORITY_REQUIRED'
  );
});


test('stage10 read-only auto-planning also requires explicit resource authority', () => {
  const planner = new OutcomePlanner();
  assert.throws(
    () => planner.plan({
      objective: 'Inspect without implicit scope',
      scopeKey: 'project:read-authority',
      successConditions: ['verified'],
      maxRisk: 'read',
      availableCapabilities: ['file.read']
    }),
    (error: any) => error?.code === 'OUTCOME_PLAN_AUTHORITY_REQUIRED'
  );
});
