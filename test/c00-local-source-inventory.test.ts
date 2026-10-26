import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inventoryLocalSource } from '../scripts/c00-local-source-inventory.mjs';

async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'c00-local-inventory-'));
  function git(...args:string[]) {execFileSync('git',['-C',root,...args],{stdio:'ignore'});}
  git('init','-q');git('config','user.email','fixture@example.test');git('config','user.name','fixture');
  await fs.writeFile(path.join(root,'tracked.ts'),'export const v = 1;\n');
  git('add','tracked.ts');git('commit','-qm','baseline');
  await fs.writeFile(path.join(root,'tracked.ts'),'export const v = 2;\n');
  await fs.writeFile(path.join(root,'miniwob-controller.py'),'# local code only\n');
  await fs.writeFile(path.join(root,'.env.local'),'PRIVATE_VALUE_DONT_EXPOSE');
  await fs.mkdir(path.join(root,'.operator'));
  await fs.writeFile(path.join(root,'.operator','receipt.ts'),'PROTECTED_RECEIPT_DONT_EXPOSE');
  await fs.mkdir(path.join(root,'node_modules'));
  await fs.writeFile(path.join(root,'node_modules','package.ts'),'UNRELATED');
  return {root,git};
}

test('read-only candidate inventory hashes only scoped safe source; never reads protected or secret data',async()=>{
  const f=await fixture();try {
    const before=execFileSync('git',['-C',f.root,'status','--porcelain=v1'],{encoding:'utf8'});
    const result=await inventoryLocalSource({root:f.root});
    const after=execFileSync('git',['-C',f.root,'status','--porcelain=v1'],{encoding:'utf8'});
    assert.equal(before,after);
    assert.equal(result.sourceCandidateCount,2);
    assert.equal(result.entries.some(x=>x.classification==='CONTROLLER_NAMED_CANDIDATE'||x.classification==='BENCHMARK_RELATED_CANDIDATE'),true);
    assert.equal(result.entries.some(x=>'relativePath' in x),false);
    assert.equal(result.originalProtectedReceipts,'NOT_ACCESSED');
    assert.equal(result.historicalOriginalController,'NOT_RECOVERED_OR_AUTHENTICATED');
    assert.equal(result.releaseAcceptance,'NOT_ACCEPTED');
    assert.equal(result.ignoredFiles,'NOT_INSPECTED');
    assert.ok(result.skippedSensitive>=2);
    const text=JSON.stringify(result);
    assert.ok(!text.includes('PRIVATE_VALUE_DONT_EXPOSE'));
    assert.ok(!text.includes('PROTECTED_RECEIPT_DONT_EXPOSE'));
    assert.ok(!text.includes('miniwob-controller.py'));
  } finally {await fs.rm(f.root,{recursive:true,force:true});}
});

test('explicit path exposure is owner opt-in, and index plus worktree changes are deduplicated',async()=>{
  const f=await fixture();try {
    f.git('add','tracked.ts');
    await fs.writeFile(path.join(f.root,'tracked.ts'),'export const v = 3;\n');
    const result=await inventoryLocalSource({root:f.root,showPaths:true});
    const x=result.entries.find(x=>x.relativePath==='tracked.ts');
    assert.deepEqual(x?.kinds,['TRACKED_INDEX_CHANGE','TRACKED_WORKTREE_CHANGE']);
    assert.equal(result.sourcePathExposure,'EXPLICIT_OWNER_OPT_IN');
  } finally {await fs.rm(f.root,{recursive:true,force:true});}
});

test('rejects unbounded roots and a path within protected state',async()=>{
  const f=await fixture();try {
    await assert.rejects(inventoryLocalSource({root:'relative'}),/absolute checkout/);
    await assert.rejects(inventoryLocalSource({root:path.join(f.root,'.operator')}),/protected state/);
    await assert.rejects(inventoryLocalSource({root:path.join(f.root,'node_modules')}),/exact Git worktree top level/);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('cannot hash symlinked untracked code outside allowed root',async(t)=>{
  const f=await fixture();const outside=await fs.mkdtemp(path.join(os.tmpdir(),'c00-outside-'));
  try {
    const sensitive=path.join(outside,'private.py');
    await fs.writeFile(sensitive,'EXTERNAL_PRIVATE_DATA');
    try {await fs.symlink(sensitive,path.join(f.root,'external.py'));}
    catch (error:any){if(error.code==='EPERM'){t.skip('platform cannot create symlink');return;}throw error;}
    const result=await inventoryLocalSource({root:f.root});
    assert.equal(result.skippedSymlink,1);
    assert.equal(JSON.stringify(result).includes('EXTERNAL_PRIVATE_DATA'),false);
  }finally{await fs.rm(f.root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
});
