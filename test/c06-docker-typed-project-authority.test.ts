import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DockerProvider } from '../src/capabilities/docker.ts';

test('C06 Docker refuses type-confused project, service, fingerprint and timeout without invoking CLI', async () => {
  const projectPath = path.resolve('.');
  const provider=new DockerProvider({
    allowedRoots:[projectPath], dockerExecutable:'/missing/docker/should/not/run'
  });
  let objectConversions=0;
  const hostile={toString(){objectConversions++;return 'web';}};
  const baseline={path:projectPath,operation:'stop',services:['web'],
    expectedCurrentFingerprint:'a'.repeat(64)};
  const cases=[
    {capability:'docker.inspect',input:{path:[projectPath]},code:'INVALID_DOCKER_PROJECT_PATH'},
    {capability:'docker.inspect',input:{path:null},code:'INVALID_DOCKER_PROJECT_PATH'},
    {capability:'docker.inspect',input:{path:hostile},code:'INVALID_DOCKER_PROJECT_PATH'},
    {capability:'docker.manage',input:{...baseline,operation:['stop']},code:'INVALID_DOCKER_OPERATION'},
    {capability:'docker.manage',input:{...baseline,services:[['web']]},code:'INVALID_DOCKER_SERVICE'},
    {capability:'docker.manage',input:{...baseline,services:[hostile]},code:'INVALID_DOCKER_SERVICE'},
    {capability:'docker.manage',input:{...baseline,services:[true]},code:'INVALID_DOCKER_SERVICE'},
    {capability:'docker.manage',input:{...baseline,expectedCurrentFingerprint:['a'.repeat(64)]},code:'DOCKER_FINGERPRINT_REQUIRED'},
    {capability:'docker.manage',input:{...baseline,path:[projectPath]},code:'INVALID_DOCKER_PROJECT_PATH'},
    {capability:'docker.manage',input:{...baseline,path:hostile},code:'INVALID_DOCKER_PROJECT_PATH'},
    {capability:'docker.manage',input:{...baseline,timeoutMs:'1000'},code:'INVALID_DOCKER_TIMEOUT'},
    {capability:'docker.manage',input:{...baseline,timeoutMs:false},code:'INVALID_DOCKER_TIMEOUT'},
    {capability:'docker.manage',input:{...baseline,timeoutMs:1.5},code:'INVALID_DOCKER_TIMEOUT'},
    {capability:'docker.manage',input:{...baseline,timeoutMs:1},code:'INVALID_DOCKER_TIMEOUT'},
    {capability:'docker.manage',input:{...baseline,timeoutMs:300001},code:'INVALID_DOCKER_TIMEOUT'}
  ];
  for(const [index, scenario] of cases.entries()){
    const result=await provider.execute({
      id:'invalid-docker-'+index,capability:scenario.capability,
      risk:scenario.capability==='docker.inspect'?'read':'system',
      provenance:{kind:'runtime'},input:scenario.input
    } as any);
    assert.equal(result.ok,false,scenario.code);
    assert.equal(result.error?.code,scenario.code,
      'Malformed Docker scope must fail before CLI/context discovery');
  }
  assert.equal(objectConversions,0,'Hostile object methods cannot generate service or project identities');
});

test('C06 Docker reconciliation of a malformed mutation returns UNCERTAIN without creating success',async()=>{
  const provider=new DockerProvider({allowedRoots:[path.resolve('.')],
    dockerExecutable:'/missing/docker/should/not/run'});
  const action:any={id:'uncertain-docker',capability:'docker.manage',risk:'system',
    input:{path:path.resolve('.'),operation:'start',services:[['web']],expectedCurrentFingerprint:'a'.repeat(64)},
    provenance:{kind:'runtime'}};
  const result=await provider.reconcile({action});
  assert.equal(result.status,'uncertain');
  assert.equal(result.result,undefined);
});
