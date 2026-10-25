import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VsCodeProvider } from '../src/capabilities/vscode.ts';

test('C06 VS Code semantic target validation refuses coerced files and bogus goto positions before opening editor',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-vscode-project-'));
  const authority=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-vscode-authority-'));
  t.after(async()=>{await fs.rm(root,{recursive:true,force:true});await fs.rm(authority,{recursive:true,force:true});});
  const file=path.join(root,'main.ts');
  await fs.writeFile(file,'console.log("hello")');
  const provider=new VsCodeProvider({allowedRoots:[root],codeExecutable:'/missing/code/not-called',dataDir:path.join(authority,'vs-code')});
  let coerced=0;
  const hostile={toString(){coerced++;return file;},valueOf(){coerced++;return 5;}};
  const examples=[
    {capability:'vscode.inspect',input:{operation:['version']},code:'INVALID_VSCODE_INSPECT_OPERATION'},
    {capability:'vscode.inspect',input:{operation:hostile},code:'INVALID_VSCODE_INSPECT_OPERATION'},
    {capability:'vscode.open',input:{mode:['file'],path:file},code:'INVALID_VSCODE_OPEN_MODE'},
    {capability:'vscode.open',input:{mode:'file',path:[file]},code:'VSCODE_TARGET_INVALID'},
    {capability:'vscode.open',input:{mode:'file',path:hostile},code:'VSCODE_TARGET_INVALID'},
    {capability:'vscode.open',input:{mode:'goto',path:file,line:'5'},code:'VSCODE_POSITION_INVALID'},
    {capability:'vscode.open',input:{mode:'goto',path:file,line:[5]},code:'VSCODE_POSITION_INVALID'},
    {capability:'vscode.open',input:{mode:'goto',path:file,line:5,column:hostile},code:'VSCODE_POSITION_INVALID'},
    {capability:'vscode.open',input:{mode:'diff',leftPath:[file],rightPath:file},code:'VSCODE_TARGET_INVALID'},
    {capability:'vscode.open',input:{mode:'folder',path:root,timeoutMs:['10000']},code:'VSCODE_TIMEOUT_INVALID'},
    {capability:'vscode.open',input:{mode:'folder',path:root,timeoutMs:hostile},code:'VSCODE_TIMEOUT_INVALID'}
  ];
  for(const [i,example] of examples.entries()){
    const result=await provider.execute({id:'invalid-vscode-'+i,capability:example.capability,
      risk:example.capability==='vscode.inspect'?'read':'external',
      input:example.input,provenance:{kind:'runtime'}} as any);
    assert.equal(result.ok,false);
    assert.equal(result.error?.code,example.code,example.capability+' '+i);
  }
  assert.equal(coerced,0);
  await assert.rejects(fs.access(path.join(authority,'vs-code')),
    'Invalid requests cannot prepare or launch an editor profile');
});
