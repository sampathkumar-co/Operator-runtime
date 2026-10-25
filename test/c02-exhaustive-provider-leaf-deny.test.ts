import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ProcessProvider } from '../src/capabilities/process.ts';
import { GitProvider } from '../src/capabilities/git.ts';
import { GitCheckpointProvider } from '../src/capabilities/git-checkpoint.ts';
import { GitWriteProvider } from '../src/capabilities/git-write.ts';
import { PerceptionProvider } from '../src/capabilities/perception.ts';
import { ProjectCommandProvider } from '../src/capabilities/project-command.ts';
import { ProjectTransactionProvider } from '../src/capabilities/project-transaction.ts';
import { ProjectInspectProvider } from '../src/capabilities/project.ts';
import { SandboxedComputeProvider } from '../src/capabilities/sandboxed-compute.ts';
import { VsCodeProvider } from '../src/capabilities/vscode.ts';
import { WorkspaceLspEditProvider } from '../src/capabilities/workspace-lsp-edit.ts';
import { SystemInspectProvider } from '../src/capabilities/system.ts';

test('C02 every developer and system provider denies unknown actions without observing input or opening a process',async()=>{
  const root=path.resolve('.');
  const projectOptions={allowedRoots:[root],allowedExecutables:[]};
  const providers:any[]=[
    new ProcessProvider(projectOptions),
    new GitProvider({allowedRoots:[root]}),
    new GitCheckpointProvider({allowedRoots:[root]}),
    new GitWriteProvider({allowedRoots:[root]}),
    new PerceptionProvider({} as any),
    new ProjectCommandProvider(projectOptions),
    new ProjectTransactionProvider(projectOptions),
    new ProjectInspectProvider({allowedRoots:[root]}),
    new SandboxedComputeProvider(),
    new VsCodeProvider({allowedRoots:[root],codeExecutable:'/nonexistent/code'}),
    new WorkspaceLspEditProvider({allowedRoots:[root]}),
    new SystemInspectProvider()
  ];
  let payloadReads=0;
  const poisoned=new Proxy({}, {
    get(){payloadReads++;throw new Error('An unsupported capability cannot parse user input.');},
    ownKeys(){payloadReads++;throw new Error('An unsupported capability cannot enumerate user input.');}
  });
  const action:any={id:'unrecognized-provider-capability',
    capability:'unregistered.write',risk:'destructive',
    input:poisoned,provenance:{kind:'runtime'}};
  for(const provider of providers){
    assert.equal(provider.supports(action),false,provider.name);
    try {
      const result=await provider.execute(action);
      assert.equal(result.ok,false,provider.name+' must not report success');
      assert.equal(result.error?.code,'UNSUPPORTED_ACTION',provider.name);
    }catch(error:any){
      assert.equal(error?.code,'UNSUPPORTED_ACTION',provider.name+' must reject as a typed unsupported action');
    }
  }
  assert.equal(payloadReads,0,'No unsupported provider may even read its payload before refusing');
});
