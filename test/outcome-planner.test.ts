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
    availableCapabilities: ['project.inspect', 'file.*', 'browser.interact', 'terminal.session']
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
});

test('stage10 outcome planner creates independent tester and verifier coverage for generated work', () => {
  const planner = new OutcomePlanner();
  const plan = planner.plan({
    objective: 'Make a bounded change',
    scopeKey: 'project:beta',
    successConditions: ['desired state is observable'],
    availableCapabilities: ['file.read', 'file.write']
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
    maxRisk: 'read',
    availableCapabilities: ['file.read', 'file.write', 'browser.interact', 'process.manage']
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
      availableCapabilities: ['file.write', 'terminal.session']
    }),
    (error: any) => error?.code === 'OUTCOME_PLAN_CAPABILITY_EMPTY'
  );
});
