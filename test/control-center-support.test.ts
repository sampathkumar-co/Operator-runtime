import assert from 'node:assert/strict';
import test from 'node:test';
import { buildControlCenterSupportBundle } from '../apps/local-agent/src/control-center-support.ts';

test('support bundle is useful but excludes credentials, paths and free-form settings', () => {
  const product:any = {
    schemaVersion:1,
    generatedAt:'2026-10-07T00:00:00.000Z',
    approvals:{counts:{pending:1}},
    recovery:{items:[]},
    onboarding:{steps:[],nextStep:'READ_PROBE',completed:false},
    health:{tasks:2,blockedTasks:1,uncertainActions:0,pendingApprovals:1}
  };
  const bundle=buildControlCenterSupportBundle({
    productVersion:'2.0.5',
    sourceCommit:'a'.repeat(40),
    product,
    runtimeStatus:{relay:{state:'READY',configured:true,required:true,continuity:'automatic',sessionToken:'secret'}},
    settings:{
      recoveryConfigured:true,
      authorizedRootCount:2,
      relayConfigured:true,
      secretToken:'do-not-leak',
      arbitraryPath:'C:\\sensitive\\repo'
    },
    tasks:[{
      failures:[{code:'VERIFY_FAILED'}],
      execution:{records:[{errorCode:'APPROVAL_REQUIRED'}]}
    } as any],
    generatedAt:'2026-10-07T01:00:00.000Z'
  });
  const text=JSON.stringify(bundle);
  assert.equal(text.includes('do-not-leak'),false);
  assert.equal(text.includes('sensitive'),false);
  assert.equal(text.includes('sessionToken'),false);
  assert.equal(bundle.configuration.authorizedRootCount,2);
  assert.deepEqual(bundle.failures.map(x=>x.code).sort(),['APPROVAL_REQUIRED','VERIFY_FAILED']);
  assert.match(bundle.id,/^[0-9a-f]{64}$/);
});
