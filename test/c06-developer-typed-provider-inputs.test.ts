import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DocumentDataProvider } from '../src/capabilities/document-data.ts';
import { ProjectCommandProvider } from '../src/capabilities/project-command.ts';
import { SandboxedComputeProvider } from '../src/capabilities/sandboxed-compute.ts';

test('C06 document read rejects coerced path values before accessing the filesystem',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-doc-boundary-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'report.csv');
  await fs.writeFile(file,'name,score\nMecord,1\n');
  const provider=new DocumentDataProvider({allowedRoots:[root]});
  let coerced=0;
  const hostile={toString(){coerced++;return file;}};
  for(const value of [[file],hostile,42,true,null,file+String.fromCharCode(0)]){
    await assert.rejects(()=>provider.execute({
      id:'doc-input-invalid',capability:'document.extract',risk:'read',
      input:{path:value},provenance:{kind:'runtime'}
    } as any),(error:any)=>error?.code==='DOCUMENT_INPUT_INVALID');
  }
  assert.equal(coerced,0);
  const valid=await provider.execute({
    id:'doc-input-valid',capability:'structured.extract',risk:'read',
    input:{path:file},provenance:{kind:'runtime'}
  });
  assert.equal(valid.ok,true);
});

test('C06 sandboxed computation rejects code, language and resource coercion before Docker',async()=>{
  const provider=new SandboxedComputeProvider({dockerExecutable:'/missing/docker/not-called'});
  let coercions=0;
  const hostile={toString(){coercions++;return 'print(1)';},valueOf(){coercions++;return 128;}};
  const baseline={language:'python',code:'print(1)'};
  const bad=[
    {language:['python'],code:'print(1)',error:'COMPUTE_LANGUAGE_INVALID'},
    {language:hostile,code:'print(1)',error:'COMPUTE_LANGUAGE_INVALID'},
    {language:'python',code:['print(1)'],error:'COMPUTE_CODE_INVALID'},
    {language:'python',code:hostile,error:'COMPUTE_CODE_INVALID'},
    {...baseline,memoryMb:'128',error:'COMPUTE_INPUT_INVALID'},
    {...baseline,memoryMb:[128],error:'COMPUTE_INPUT_INVALID'},
    {...baseline,cpu:'0.5',error:'COMPUTE_INPUT_INVALID'},
    {...baseline,cpu:hostile,error:'COMPUTE_INPUT_INVALID'},
    {...baseline,timeoutMs:'10000',error:'COMPUTE_INPUT_INVALID'}
  ];
  for(const [i,entry] of bad.entries()){
    const {error,...input}=entry;
    const out=await provider.execute({
      id:'invalid-compute-'+i,capability:'compute.run',risk:'write',
      input,provenance:{kind:'runtime'}
    } as any);
    assert.equal(out.ok,false);
    assert.equal(out.error?.code,error);
    assert.equal(out.error?.sideEffectState,'none');
  }
  assert.equal(coercions,0);
});

test('C06 trusted project command scope and registry IDs cannot be coerced',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-project-exact-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const authority=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-project-registry-'));
  t.after(()=>fs.rm(authority,{recursive:true,force:true}));
  const registry=path.join(authority,'commands.json');
  const marker=path.join(root,'should-not-run.txt');
  await fs.writeFile(registry,JSON.stringify({version:1,projects:[{root,commands:[{
    id:'trusted',kind:'test',executable:'node',
    args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`],
    cwd:'.',risk:'read'
  }]}]}));
  const provider=new ProjectCommandProvider({allowedRoots:[root],registryPath:registry,allowedExecutables:['node']});
  let coerced=0;
  const hostile={toString(){coerced++;return root;}};
  const base={path:root,commandId:'trusted',expectedRisk:'read'};
  for(const [i,change] of [
    {path:[root]},{path:hostile},{cwd:[root],path:undefined},
    {commandId:['trusted']},{commandId:{toString:()=>{coerced++;return 'trusted';}}},
    {expectedRisk:['read']}
  ].entries()){
    const out=await provider.execute({
      id:'invalid-command-'+i,capability:'project.command.run',risk:'read',
      input:{...base,...change},provenance:{kind:'runtime'}
    } as any);
    assert.equal(out.ok,false,JSON.stringify(Object.keys(change)));
    assert.ok(['PROJECT_COMMAND_SCOPE_INVALID','INVALID_COMMAND_ID','PROJECT_COMMAND_RISK_MISMATCH'].includes(String(out.error?.code)));
  }
  assert.equal(coerced,0);
  await assert.rejects(fs.access(marker));
});
