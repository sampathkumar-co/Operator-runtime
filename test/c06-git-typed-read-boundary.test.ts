import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { GitProvider } from '../src/capabilities/git.ts';
import { supportedGitAvailable } from './git-test-support.ts';

const gitTest = supportedGitAvailable() ? test : test.skip;
const cwd=path.resolve('.');
const actor={kind:'runtime' as const};
const input=(changes:Record<string,unknown>)=>({
  id:'invalid-read-git',
  capability:'git.diff',
  risk:'read' as const,
  provenance:actor,
  input:{cwd,paths:['README.md'],...changes}
});
gitTest('C06 Git read path selection rejects untyped values without invoking coercion',async()=>{
  const provider=new GitProvider({allowedRoots:[cwd]});
  let coercions=0;
  const hostile={toString(){coercions++;throw new Error('must never coerce attacker object');}};
  for(const bad of [
    {paths:[hostile]},
    {paths:[null]},
    {paths:[true]},
    {paths:'README.md'},
    {paths:Array.from({length:129},()=> 'README.md')},
    {paths:['x'+String.fromCharCode(0)+'y']},
    {paths:['x'+String.fromCharCode(13)+'y']},
    {paths:['x'+String.fromCharCode(10)+'y']},
    {cwd:hostile},
    {cwd:''},
    {cwd:cwd+String.fromCharCode(0)},
    {publicLiteralFiles:'true'},
    {publicLiteralFiles:1}
  ]) {
    const result=await provider.execute(input(bad) as any);
    assert.equal(result.ok,false,JSON.stringify(Object.keys(bad)));
    assert.equal(result.error?.code,'GIT_INPUT_INVALID');
    assert.equal(coercions,0);
  }
});
