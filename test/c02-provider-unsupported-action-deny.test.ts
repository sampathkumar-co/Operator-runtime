import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { DockerProvider } from '../src/capabilities/docker.ts';
import { PostgresProvider } from '../src/capabilities/postgres.ts';
import { WindowsUiaProvider } from '../src/capabilities/windows-uia.ts';

test('C02 unsupported capability is refused directly by Docker and PostgreSQL before process or disk access',async()=>{
  const root=path.resolve('.');
  const docker=new DockerProvider({allowedRoots:[root],dockerExecutable:'/nonexistent/docker'});
  const pg=new PostgresProvider({allowedRoots:[root],registryPath:'/nonexistent/pg.json',
    psqlExecutable:'/nonexistent/psql'});
  const examples=[
    {provider:docker,capability:'docker.exec'},
    {provider:docker,capability:'file.read'},
    {provider:pg,capability:'postgres.manage'},
    {provider:pg,capability:'terminal.execute'}
  ] as const;
  for(const entry of examples){
    const result=await entry.provider.execute({
      id:'unsupported-'+entry.capability,capability:entry.capability,risk:'system',
      input:{path:root,operation:'stop',services:['db'],expectedCurrentFingerprint:'a'.repeat(64)},
      provenance:{kind:'runtime'}
    } as any);
    assert.equal(result.ok,false,entry.capability);
    assert.equal(result.error?.code,'UNSUPPORTED_ACTION',entry.capability);
  }
});

test('C02 Windows UIA refuses unknown capabilities and unsupported platforms before sidecar calls',async()=>{
  let nativeCalls=0;
  const client={
    async call(){nativeCalls++;throw new Error('Unexpected native side effect');},
    close(){}
  };
  const action=(capability:string):any=>({
    id:'unsupported-'+capability,capability,risk:'external',
    input:{operation:'click',selector:{name:'Save'}},provenance:{kind:'runtime'}
  });
  const windows=new WindowsUiaProvider({platform:'win32',client});
  const linux=new WindowsUiaProvider({platform:'linux',client});
  try{
    for(const [provider,capability] of [
      [windows,'app.unsafe'],[windows,'terminal.execute'],[linux,'app.operate'],
      [linux,'visual.capture']
    ] as const){
      const result=await provider.execute(action(capability));
      assert.equal(result.ok,false,capability);
      assert.equal(result.error?.code,'UNSUPPORTED_ACTION',capability);
    }
    assert.equal(nativeCalls,0,'Unsupported capability cannot enter the native sidecar');
  }finally{await windows.close();await linux.close();}
});
