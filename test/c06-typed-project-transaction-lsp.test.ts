import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectInspectProvider } from '../src/capabilities/project.ts';
import { ProjectTransactionProvider } from '../src/capabilities/project-transaction.ts';
import { WorkspaceLspEditProvider } from '../src/capabilities/workspace-lsp-edit.ts';

test('C06 destructive project transactions refuse malformed authority before command inspect and checkpoint',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c06-transaction-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const provider=new ProjectTransactionProvider({allowedRoots:[root],allowedExecutables:['node'],
    registryPath:path.join(os.tmpdir(),'mecord-invalid-registry-not-read.json')});
  const input={path:root,commandId:'trusted-build',expectedRisk:'write'};
  let conversions=0;
  const hostile={toString(){conversions++;return root;}};
  const cases=[
    {change:{path:[root]},code:'TRANSACTION_SCOPE_INVALID'},
    {change:{path:hostile},code:'TRANSACTION_SCOPE_INVALID'},
    {change:{path:0},code:'TRANSACTION_SCOPE_INVALID'},
    {change:{commandId:['trusted-build']},code:'INVALID_COMMAND_ID'},
    {change:{commandId:{toString(){conversions++;return 'trusted-build';}}},code:'INVALID_COMMAND_ID'},
    {change:{commandId:'../other'},code:'INVALID_COMMAND_ID'},
    {change:{expectedRisk:['write']},code:'TRANSACTION_RISK_UNSUPPORTED'}
  ];
  for(const [i,{change,code}] of cases.entries()){
    const out=await provider.execute({id:'invalid-transaction-'+i,
      capability:'project.transaction.run',risk:'destructive',
      input:{...input,...change},provenance:{kind:'runtime'}} as any);
    assert.equal(out.ok,false);
    assert.equal(out.error?.code,code);
  }
  assert.equal(conversions,0);
});

test('C06 read-only LSP edit resolver cannot authorize coerced workspace or validation commands',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c06-lsp-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const provider=new WorkspaceLspEditProvider({allowedRoots:[root]});
  let conversions=0;
  const hostile={toString(){conversions++;return root;}};
  const base={workspaceRoot:root,edit:{changes:{}},expectedDocumentSha256:{}};
  for(const [i,change] of [
    {workspaceRoot:[root]}, {workspaceRoot:hostile}
  ].entries()){
    const out=await provider.execute({id:'bad-lsp-root-'+i,
      capability:'workspace.edit.resolve_lsp',risk:'read',
      input:{...base,...change},provenance:{kind:'runtime'}} as any);
    assert.equal(out.ok,false);
    assert.equal(out.error?.code,'LSP_EDIT_WORKSPACE_ROOT_REQUIRED');
  }
  for(const [i,change] of [
    {trustedCommandIds:[['lint']]},{trustedCommandIds:[true]},
    {trustedCommandIds:['lint','lint']},{trustedCommandIds:['../shell']},
    {includeImpactAnalysis:'false'},{includeImpactAnalysis:0}
  ].entries()){
    const out=await provider.execute({id:'bad-lsp-command-'+i,
      capability:'workspace.edit.resolve_lsp',risk:'read',
      input:{...base,...change},provenance:{kind:'runtime'}} as any);
    assert.equal(out.ok,false);
    assert.equal(out.error?.code,'LSP_EDIT_VERIFICATION_INVALID');
  }
  assert.equal(conversions,0);
});

test('C06 read-only project inventory refuses objects that coerce to approved roots',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c06-project-inspect-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const provider=new ProjectInspectProvider({allowedRoots:[root]});
  let conversions=0;
  const hostile={toString(){conversions++;return root;}};
  for(const value of [[root],hostile,null,0,root+'\n']){
    await assert.rejects(()=>provider.execute({id:'invalid-project',
      capability:'project.inspect',risk:'read',input:{path:value},
      provenance:{kind:'runtime'}} as any),
    (error:any)=>error?.code==='PROJECT_SCOPE_INVALID');
  }
  assert.equal(conversions,0);
  const valid=await provider.execute({id:'valid-project',capability:'project.inspect',
    risk:'read',input:{path:root},provenance:{kind:'runtime'}});
  assert.equal(valid.ok,true);
});
