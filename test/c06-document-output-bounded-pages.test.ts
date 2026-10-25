import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DocumentDataProvider } from '../src/capabilities/document-data.ts';

async function fixture(t: import('node:test').TestContext) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-doc-pages-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root, provider:new DocumentDataProvider({allowedRoots:[root]})};
}
const action=(pathValue:unknown,extras:Record<string,unknown>={},capability='structured.extract')=>({
  id:'document-paging',capability,risk:'read' as const,provenance:{kind:'runtime' as const},
  input:{path:pathValue,...extras}
});

test('C06 small CSV extraction remains complete and backwards compatible',async t=>{
  const {root,provider}=await fixture(t);
  const file=path.join(root,'small.csv');
  await fs.writeFile(file,'name,value\nalpha,1\nbeta,2\n');
  const outcome=await provider.execute(action(file));
  assert.equal(outcome.ok,true);
  assert.match(String((outcome.output as any).text),/alpha,1/);
  assert.equal((outcome.output as any).rows.length,3);
  assert.equal((outcome.output as any).page,undefined);
});

test('C06 large CSV extraction returns bounded, stable, advancing pages',async t=>{
  const {root,provider}=await fixture(t);
  const file=path.join(root,'large.csv');
  const values=Array.from({length:1000},(_,i)=>'row'+i+','+'X'.repeat(380));
  await fs.writeFile(file,'name,value\n'+values.join('\n')+'\n');
  let offset=0,seen=0,pages=0;let digest='';
  while(true){
    const result=await provider.execute(action(file,{offset,maxBytes:8192}));
    assert.equal(result.ok,true);
    assert.ok(Buffer.byteLength(JSON.stringify(result.output),'utf8')<=8192);
    const output=result.output as any;
    assert.equal(output.page.offset,offset);
    assert.ok(output.rows.length>0);
    assert.equal(output.text,undefined);
    assert.equal(output.textOmitted,true);
    if(digest)assert.equal(output.page.sourceSha256,digest);
    digest=output.page.sourceSha256;
    seen+=output.rows.length;pages++;
    if(output.page.nextOffset===null)break;
    assert.ok(output.page.nextOffset>offset,'page must advance');
    offset=output.page.nextOffset;
    assert.ok(pages<=100,'pagination cannot cycle indefinitely');
  }
  assert.equal(seen,1001);
  assert.ok(pages>1);
});

test('C06 cannot report success for oversized JSON output or a CSV row that cannot fit',async t=>{
  const {root,provider}=await fixture(t);
  const jsonFile=path.join(root,'oversized.json');
  await fs.writeFile(jsonFile,JSON.stringify({large:'z'.repeat(400000)}));
  await assert.rejects(()=>provider.execute(action(jsonFile,{maxBytes:8192},'structured.extract')),
    (error:any)=>error?.code==='DOCUMENT_OUTPUT_TOO_LARGE');
  const csvFile=path.join(root,'oversized.csv');
  await fs.writeFile(csvFile,'key,value\nfirst,'+'q'.repeat(12000)+'\n');
  await assert.rejects(()=>provider.execute(action(csvFile,{maxBytes:1024})),
    (error:any)=>error?.code==='DOCUMENT_OUTPUT_TOO_LARGE');
});

test('C06 read budgets and offsets require exact numbers and allowed operations',async t=>{
  const {root,provider}=await fixture(t);
  const csv=path.join(root,'input.csv');
  await fs.writeFile(csv,'key,value\nfirst,1\n');
  for(const wrong of [{maxBytes:'4096'},{maxBytes:[4096]},{maxBytes:512},{maxBytes:262145},
    {offset:'0'},{offset:[0]},{offset:null},{offset:-1},{offset:1.5},{offset:10001},{offset:100}]) {
    await assert.rejects(()=>provider.execute(action(csv,wrong)),
      (error:any)=>error?.code==='DOCUMENT_PAGINATION_INVALID');
  }
  await assert.rejects(()=>provider.execute(action(csv,{offset:0},'structured.inspect')),
    (error:any)=>error?.code==='DOCUMENT_PAGINATION_INVALID');
  const typed=await provider.execute(action(csv,{offset:0,maxBytes:2048}));
  assert.equal((typed.output as any).page.offset,0);
});
