import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../src/core/audit.ts';
import { createTask } from '../src/core/task.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { ApprovalStore } from '../apps/local-agent/src/approval-store.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

test('R4 Control Center serves separate accessible assets and runtime-backed product projections', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-r4-root-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-r4-state-'));
  t.after(() => Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(stateDir,{recursive:true,force:true})]));
  const token='a'.repeat(64), recoveryToken='b'.repeat(64);
  const runtime=createRuntime({allowedRoots:[root],allowedExecutables:['node']});
  const tasks=new TaskStore(stateDir);
  const audit=new AuditLog(stateDir);
  const approvals=new ApprovalStore(stateDir);
  const verified=createTask({userObjective:'Verified onboarding task',interpretedObjective:'Verify onboarding',authorizedScope:[root],prohibitedScope:[],successConditions:['verified']});
  verified.state='VERIFIED';
  verified.evidence.push({kind:'verification',status:'pass',message:'verified',timestamp:new Date().toISOString()});
  await tasks.put(verified);
  const agent=createLocalAgentServer({
    runtime,token,recoveryToken,tasks,audit,approvals,
    settings:{recoveryConfigured:true,relayConfigured:true,authorizedRootCount:1},
    getRuntimeStatus:()=>({relay:{connected:true,status:'connected'}}),
    permissions:{allowedCapabilities:['file.*'],allowedRoots:[root]}
  });
  t.after(()=>Promise.allSettled([agent.close(),runtime.close()]));
  const bound=await agent.listen('127.0.0.1',0);
  const base=`http://127.0.0.1:${bound.port}`;
  const headers={authorization:`Bearer ${token}`};

  const page=await fetch(`${base}/control-center`);
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Approval Center/);
  assert.match(html,/Diagnostics/);
  assert.match(html,/\/control-center\/app\.js/);
  assert.match(page.headers.get('content-security-policy')??'',/script-src 'self'/);
  assert.equal(html.includes(token),false);

  const js=await fetch(`${base}/control-center/app.js`);
  const css=await fetch(`${base}/control-center/styles.css`);
  assert.match(js.headers.get('content-type')??'',/^text\/javascript/);
  assert.match(css.headers.get('content-type')??'',/^text\/css/);
  assert.match(await js.text(),/support-bundle/);

  const probe=await fetch(`${base}/v1/control-center/onboarding/read-probe`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'});
  assert.equal(probe.status,200);

  const practice=await fetch(`${base}/v1/control-center/onboarding/approval-probe`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'});
  assert.equal(practice.status,202);
  const practiceBody=await practice.json() as any;
  const actionId=practiceBody.approval.actionId;
  const approvalRequestId=practiceBody.approval.approvalRequestId;

  const approvalsView=await fetch(`${base}/v1/control-center/approvals`,{headers});
  const approvalsBody=await approvalsView.json() as any;
  assert.equal(approvalsBody.model.counts.pending,1);
  assert.equal(approvalsBody.model.pending[0].canApprove,true);

  const approve=await fetch(`${base}/v1/approvals/${encodeURIComponent(actionId)}`,{
    method:'POST',
    headers:{...headers,'x-operator-recovery-token':recoveryToken,'content-type':'application/json'},
    body:JSON.stringify({decision:'approve',approvalRequestId})
  });
  assert.equal(approve.status,200);

  const onboarding=await fetch(`${base}/v1/control-center/onboarding`,{headers});
  const onboardingBody=await onboarding.json() as any;
  const readStep=onboardingBody.model.steps.find((x:any)=>x.id==='READ_PROBE');
  const approvalStep=onboardingBody.model.steps.find((x:any)=>x.id==='APPROVAL_PROBE');
  const taskStep=onboardingBody.model.steps.find((x:any)=>x.id==='GUIDED_VERIFIED_TASK');
  assert.equal(readStep.status,'COMPLETE');
  assert.equal(approvalStep.status,'COMPLETE');
  assert.equal(taskStep.status,'COMPLETE');

  const bundleRes=await fetch(`${base}/v1/control-center/support-bundle`,{headers});
  assert.equal(bundleRes.status,200);
  const bundle=await bundleRes.json() as any;
  const serialized=JSON.stringify(bundle);
  assert.equal(serialized.includes(token),false);
  assert.equal(serialized.includes(recoveryToken),false);
  assert.equal(serialized.includes(root),false);
  assert.equal(bundle.bundle.health.authorizedRootCount,1);
  assert.ok(Array.isArray(bundle.bundle.diagnostics));
});

test('R4 APIs remain bearer protected while the credential-free shell and assets are public locally', async (t) => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-r4-auth-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const runtime=createRuntime({allowedRoots:[root],allowedExecutables:['node']});
  const agent=createLocalAgentServer({runtime,token:'c'.repeat(64),permissions:{allowedCapabilities:['file.*'],allowedRoots:[root]}});
  t.after(()=>Promise.allSettled([agent.close(),runtime.close()]));
  const bound=await agent.listen('127.0.0.1',0); const base=`http://127.0.0.1:${bound.port}`;
  assert.equal((await fetch(`${base}/control-center`)).status,200);
  assert.equal((await fetch(`${base}/control-center/app.js`)).status,200);
  assert.equal((await fetch(`${base}/v1/control-center/overview`)).status,401);
});
