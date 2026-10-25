import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { GitWriteProvider } from '../src/capabilities/git-write.ts';

test('C06 all malformed Git write identities and modes fail before repository read and checkpoint',async()=>{
  const cwd=path.resolve('.');
  const provider=new GitWriteProvider({allowedRoots:[cwd]});
  let conversions=0;
  const hostile={toString(){conversions++;return 'file.txt';}};
  const baseline={operation:'stage',cwd,paths:['safe.txt'],expectedCurrentFingerprint:'a'.repeat(64)};
  const cases=[
    {input:{...baseline,operation:['stage']},code:'INVALID_GIT_WRITE_OPERATION'},
    {input:{...baseline,cwd:[cwd]},code:'GIT_WRITE_CWD_INVALID'},
    {input:{...baseline,cwd:hostile},code:'GIT_WRITE_CWD_INVALID'},
    {input:{...baseline,expectedCurrentFingerprint:['a'.repeat(64)]},code:'GIT_WRITE_FINGERPRINT_REQUIRED'},
    {input:{...baseline,paths:'safe.txt'},code:'GIT_PATH_SELECTION_INVALID'},
    {input:{...baseline,paths:[['safe.txt']]},code:'INVALID_GIT_PATH'},
    {input:{...baseline,paths:[hostile]},code:'INVALID_GIT_PATH'},
    {input:{...baseline,paths:[' safe.txt']},code:'INVALID_GIT_PATH'},
    {input:{...baseline,paths:['safe.txt ']},code:'INVALID_GIT_PATH'},
    {input:{...baseline,all:'true'},code:'GIT_PATH_SELECTION_INVALID'},
    {input:{...baseline,all:true},code:'GIT_PATH_SELECTION_INVALID'},
    {input:{...baseline,paths:[]},code:'GIT_PATHS_REQUIRED'},
    {input:{...baseline,message:'commit while staging'},code:'GIT_WRITE_INPUT_INVALID'},
    {input:{...baseline,operation:'unstage',paths:[]},code:'GIT_PATHS_REQUIRED'},
    {input:{...baseline,operation:'commit',paths:undefined,message:['commit']},code:'INVALID_COMMIT_MESSAGE'},
    {input:{...baseline,operation:'commit',paths:undefined,all:undefined,message:['commit']},code:'INVALID_COMMIT_MESSAGE'},
    {input:{...baseline,operation:'commit',paths:undefined,all:undefined,message:hostile},code:'INVALID_COMMIT_MESSAGE'},
    {input:{...baseline,operation:'commit',paths:undefined,all:undefined,message:'  '},code:'INVALID_COMMIT_MESSAGE'},
    {input:{...baseline,operation:'commit',paths:['safe.txt'],message:'commit'},code:'GIT_WRITE_INPUT_INVALID'}
  ];
  for(const [index,item] of cases.entries()){
    const result=await provider.execute({
      id:'invalid-git-'+index,capability:'git.write',risk:'write',
      input:item.input,provenance:{kind:'runtime'}
    } as any);
    assert.equal(result.ok,false,JSON.stringify(Object.keys(item.input)));
    assert.equal(result.error?.code,item.code,JSON.stringify(Object.keys(item.input)));
  }
  assert.equal(conversions,0,'untrusted objects must never produce Git paths or commit messages');
});
