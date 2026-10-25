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

test('C06 workflow cannot certify post-edit commands or exact edit plan through coerced identities',()=>{
  const before='const a = 1;\n';
  const plan=createMultiFileEditPlan({files:[{
    path:'src/a.ts',expectedSha256:digest(before),
    edits:[{start:10,end:11,replacement:'2'}]
  }]});
  const workflow=createDeveloperEditWorkflow({editPlan:plan,
    postEditCommands:[{commandId:'format',roles:['format']}],
    verificationCommandIds:['typecheck']
  });
  let coerced=0;
  const hostile={toString(){coerced++;return 'format';}};
  for(const item of [['format'],hostile,123,null]) {
    assert.throws(()=>assertDeveloperEditWorkflowCoverage(workflow,{
      appliedPlanId:plan.id,
      successfulPostEditCommandIds:[item] as any,
      successfulVerificationCommandIds:['typecheck']
    }),(e:any)=>e?.code==='DEVELOPER_EDIT_WORKFLOW_INVALID');
  }
  for(const item of [['typecheck'],{toString(){coerced++;return 'typecheck';}},true]) {
    assert.throws(()=>assertDeveloperEditWorkflowCoverage(workflow,{
      appliedPlanId:plan.id,
      successfulPostEditCommandIds:['format'],
      successfulVerificationCommandIds:[item] as any
    }),(e:any)=>e?.code==='DEVELOPER_EDIT_WORKFLOW_INVALID');
  }
  for(const wrong of [[plan.id],{toString(){coerced++;return plan.id;}},null]) {
    assert.throws(()=>validateDeveloperEditWorkflow({...workflow,editPlanId:wrong as any}),
      (e:any)=>e?.code==='DEVELOPER_EDIT_WORKFLOW_INVALID');
  }
  assert.equal(coerced,0);
  assert.doesNotThrow(()=>assertDeveloperEditWorkflowCoverage(workflow,{
    appliedPlanId:plan.id,
    successfulPostEditCommandIds:['format'],
    successfulVerificationCommandIds:['typecheck']
  }));
});

test('C06 draft workflow never accepts trusted command array aliases at creation',()=>{
  const before='const a = 1;\n';
  const plan=createMultiFileEditPlan({files:[{
    path:'src/a.ts',expectedSha256:digest(before),edits:[{start:10,end:11,replacement:'2'}]
  }]});
  for(const bad of [['lint'],42,{toString:()=> 'lint'},null]) {
    assert.throws(()=>createDeveloperEditWorkflow({editPlan:plan,
      postEditCommands:[{commandId:bad as any,roles:['format']}]}),
      (e:any)=>e?.code==='DEVELOPER_EDIT_WORKFLOW_INVALID');
    assert.throws(()=>createDeveloperEditWorkflow({editPlan:plan,
      verificationCommandIds:[bad as any]}),
      (e:any)=>e?.code==='DEVELOPER_EDIT_WORKFLOW_INVALID');
  }
});
