import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import test from 'node:test';
import { inspectExplicitLocalSourceProvenance } from '../scripts/c00-local-source-provenance.mjs';
const digest=(text:string)=>crypto.createHash('sha256').update(text).digest('hex');
async function fixture(t:test.TestContext) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c00-provenance-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'src','known.ts'),'export const result = true;\n');
  await fs.writeFile(path.join(root,'src','extra.js'),'export const safe = 1;\n');
  return root;
}
test('C00 local source provenance is read-only, pseudonymous and never asserts controller recovery',async t=>{
  const root=await fixture(t);
  const known='export const result = true;\n';
  const referenceDigests={'src/known.ts':digest(known),'src/extra.js':digest('old content')};
  const before=await Promise.all(['known.ts','extra.js'].map(x=>fs.readFile(path.join(root,'src',x),'utf8')));
  const input={root,relativePaths:['src/known.ts','src/extra.js'],
    referenceDigests,hmacKey:'a'.repeat(64)};
  const a=await inspectExplicitLocalSourceProvenance(input);
  const b=await inspectExplicitLocalSourceProvenance(input);
  assert.deepEqual(a,b);
  assert.equal(a.mode,'READ_ONLY_EXPLICIT_FILES');
  assert.equal(a.inspected,2);
  assert.deepEqual(a.entries.map((e:any)=>e.sourceDisposition),
    ['MATCHES_DECLARED_REFERENCE','DIFFERS_FROM_DECLARED_REFERENCE']);
  assert.equal(a.historicalControllerRecovery,'NOT_VERIFIED');
  assert.equal(a.independentProvenance,'NOT_AUTHENTICATED');
  assert.equal(a.originalDeviceReceipts,'NOT_TOUCHED');
  assert.equal(a.releaseAcceptance,'NOT_ACCEPTED');
  const serialized=JSON.stringify(a);
  for(const privateText of [root,'src/known.ts','src/extra.js',known]) {
    assert.equal(serialized.includes(privateText),false,'source path and content not exported');
  }
  const after=await Promise.all(['known.ts','extra.js'].map(x=>fs.readFile(path.join(root,'src',x),'utf8')));
  assert.deepEqual(after,before,'inventory must not modify source bytes');
});
test('C00 inventory never walks protected state, parent paths or symlink targets',async t=>{
  const root=await fixture(t);
  const base={root,referenceDigests:{},hmacKey:'b'.repeat(64)};
  for(const relativePaths of [
    ['../secret.ts'],['.operator/receipts.json'],['.ssh/config.json'],
    ['src/known.ts','src/known.ts'],['src/known.ts','src/.env'],
    ['src/known.ts',42],Array(1),['C:\\private.ts']
  ]) {
    await assert.rejects(inspectExplicitLocalSourceProvenance({
      ...base,relativePaths:relativePaths as string[]
    }),/C00_LOCAL_PROVENANCE_INVALID/);
  }
  const outside=path.join(root,'target.js');
  await fs.writeFile(outside,'secret');
  const alias=path.join(root,'src','alias.js');
  try {
    await fs.symlink(outside,alias);
  }catch(e){
    if (['EPERM','EACCES'].includes((e as NodeJS.ErrnoException).code??'')){
      return t.skip('symlinks disallowed on this device');
    }
    throw e;
  }
  await assert.rejects(inspectExplicitLocalSourceProvenance({
    ...base,relativePaths:['src/alias.js']
  }),/C00_LOCAL_PROVENANCE_INVALID/);
});

test('C00 cannot coerce a caller object into a provenance HMAC key',async t=>{
  const root=await fixture(t);
  let conversions=0;
  const forged={toString(){conversions++;return 'a'.repeat(64);}};
  await assert.rejects(inspectExplicitLocalSourceProvenance({
    root,relativePaths:['src/known.ts'],referenceDigests:{},hmacKey:forged
  }),/C00_LOCAL_PROVENANCE_INVALID/);
  assert.equal(conversions,0,'source inventory must not execute token conversion');
});

test('C00 protected source roots cannot be reached through an ancestor alias',async t=>{
  const root=await fixture(t);
  const protectedRoot=path.join(root,'.operator');
  const receipts=path.join(protectedRoot,'receipts');
  await fs.mkdir(receipts,{recursive:true});
  await fs.writeFile(path.join(receipts,'private.json'),'{"protected":true}');
  const alias=path.join(root,'visible');
  try{ await fs.symlink(protectedRoot,alias,'dir'); }
  catch(error){
    if(['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??'')){
      return t.skip('OS symlink privilege unavailable');
    }
    throw error;
  }
  const reportRoot=path.join(alias,'receipts');
  await assert.rejects(inspectExplicitLocalSourceProvenance({
    root:reportRoot,relativePaths:['private.json'],
    referenceDigests:{},hmacKey:'1'.repeat(64)
  }),/C00_LOCAL_PROVENANCE_INVALID/);
  assert.equal(await fs.readFile(path.join(receipts,'private.json'),'utf8'),
    '{"protected":true}','protected evidence remains unchanged');
});

test('C00 without independent source reference never declares a unique recovered controller',async t=>{
  const root=await fixture(t);
  const response=await inspectExplicitLocalSourceProvenance({
    root,hmacKey:'f'.repeat(64),relativePaths:['src/known.ts'],referenceDigests:{}
  });
  assert.equal(response.entries[0].sourceDisposition,'NO_INDEPENDENT_REFERENCE');
  assert.equal(response.historicalControllerRecovery,'NOT_VERIFIED');
  await assert.rejects(inspectExplicitLocalSourceProvenance({
    root,hmacKey:'f'.repeat(64),relativePaths:['src/known.ts'],
    referenceDigests:{'src/known.ts':'not-a-sha'}
  }),/C00_LOCAL_PROVENANCE_INVALID/);
});
