import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createMultiFileEditPlan } from '../src/core/multi-file-edit-plan.ts';
import {
  assertDeveloperEditWorkflowCoverage,
  createDeveloperEditWorkflow,
  developerEditWorkflowSteps,
  validateDeveloperEditWorkflow
} from '../src/core/developer-edit-workflow.ts';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

test('Developer edit workflow sequences apply, formatter/import organization, then verification', () => {
  const before = 'export const value = 1;\n';
  const plan = createMultiFileEditPlan({
    files: [{
      path: 'src/value.ts',
      expectedSha256: digest(before),
      edits: [{ start: before.indexOf('1'), end: before.indexOf('1') + 1, replacement: '2' }]
    }],
    verification: {
      trustedCommandIds: ['typecheck'],
      requiredTestPaths: ['test/value.test.ts']
    }
  });
  const workflow = createDeveloperEditWorkflow({
    editPlan: plan,
    postEditCommands: [
      { commandId: 'biome.fix', roles: ['format', 'organize-imports'] }
    ],
    verificationCommandIds: ['unit-tests']
  });

  assert.equal(validateDeveloperEditWorkflow(workflow).id, workflow.id);
  assert.deepEqual(developerEditWorkflowSteps(workflow), [
    {
      ordinal: 1,
      phase: 'apply',
      capability: 'workspace.edit.transaction',
      planId: plan.id
    },
    {
      ordinal: 2,
      phase: 'post-edit',
      capability: 'project.command.run',
      commandId: 'biome.fix',
      roles: ['format', 'organize-imports']
    },
    {
      ordinal: 3,
      phase: 'verify',
      capability: 'project.command.run',
      commandId: 'typecheck'
    },
    {
      ordinal: 4,
      phase: 'verify',
      capability: 'project.command.run',
      commandId: 'unit-tests'
    }
  ]);

  assert.doesNotThrow(() => assertDeveloperEditWorkflowCoverage(workflow, {
    appliedPlanId: plan.id,
    successfulPostEditCommandIds: ['biome.fix'],
    successfulVerificationCommandIds: ['typecheck', 'unit-tests'],
    observedTestPaths: ['test/value.test.ts']
  }));
});

test('Developer edit workflow refuses incomplete formatter/import or test evidence', () => {
  const before = 'const a = 1;\n';
  const plan = createMultiFileEditPlan({
    files: [{
      path: 'a.ts',
      expectedSha256: digest(before),
      edits: [{ start: 10, end: 11, replacement: '2' }]
    }]
  });
  const workflow = createDeveloperEditWorkflow({
    editPlan: plan,
    postEditCommands: [
      { commandId: 'format', roles: ['format'] },
      { commandId: 'imports', roles: ['organize-imports'] }
    ],
    requiredTestPaths: ['a.test.ts']
  });

  assert.throws(
    () => assertDeveloperEditWorkflowCoverage(workflow, {
      appliedPlanId: plan.id,
      successfulPostEditCommandIds: ['format'],
      observedTestPaths: ['a.test.ts']
    }),
    /Formatter\/import-organization/
  );
  assert.throws(
    () => assertDeveloperEditWorkflowCoverage(workflow, {
      appliedPlanId: plan.id,
      successfulPostEditCommandIds: ['format', 'imports'],
      observedTestPaths: []
    }),
    /Required affected tests/
  );
});

test('Developer edit workflow content address detects tampering', () => {
  const before = 'const a = 1;\n';
  const plan = createMultiFileEditPlan({
    files: [{
      path: 'a.ts',
      expectedSha256: digest(before),
      edits: [{ start: 10, end: 11, replacement: '2' }]
    }]
  });
  const workflow = createDeveloperEditWorkflow({ editPlan: plan });
  const tampered = structuredClone(workflow);
  tampered.verificationCommandIds.push('injected');
  assert.throws(() => validateDeveloperEditWorkflow(tampered), /id does not match/);
});
